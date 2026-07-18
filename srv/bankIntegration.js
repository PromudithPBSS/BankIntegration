require('dotenv').config()

const axios = require('axios')
const cds = require('@sap/cds')
const { doSampathTran } = require('./bankApiClient')
const log = require('./logger')

const S4_API_URL = process.env.S4_API_URL
const S4_USER = process.env.S4_USER
const S4_PASSWORD = process.env.S4_PASSWORD
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5 * 60 * 1000 // default 5 minutes

/** Shared CDS db connection (lazily initialised once). */
let _db = null
async function getDb() {
  if (!_db) _db = await cds.connect.to('db')
  return _db
}

/**
 * Resolves a stable unique id from a S/4HANA payment row.
 * This becomes the `externalId` used to deduplicate in the Transaction table.
 */
function getPaymentId(payment = {}) {
  return (
    payment.UniqueEndToEndTransactionID ||
    payment.PaymentReference ||
    payment.PaymentDocument ||
    payment.ID ||
    null
  )
}

/**
 * Looks up the BusinessPartner record from the local SQLite DB.
 * Tries common S/4HANA field names that carry the payee BP ID.
 */
async function getLocalBusinessPartner(database, payment = {}) {
  const bpId =
    payment.PayFnPayeeBusinessPartner ||
    payment.PayFnInitiatorBusinessPartner ||
    payment.PayFnPayerBusinessPartner ||
    null

  if (!bpId) {
    log.warn('No BusinessPartner ID found on payment row — cannot look up local BP')
    return null
  }

  const bp = await database.run(
    SELECT.one.from('my.bankintegration.BusinessPartner').where({ businessPartnerId: bpId })
  )

  if (bp) {
    log.info(`Resolved local BusinessPartner ${bpId}: ${bp.fullName || '(no name)'} | accountNumber: ${bp.accountNumber || 'null'}`)
  } else {
    log.warn(`BusinessPartner ${bpId} not found in local DB — run npm run sync:business-partners to refresh`)
  }

  return bp || null
}

/**
 * Maps a S/4HANA payment record + optional local BusinessPartner to the
 * doSampathTran payload.
 * Local BP data (email, mobile, accountNumber) takes priority over S/4HANA fields.
 */
function toTransactionPayload(payment = {}, bp = null) {
  return {
    fromAccNumber:    process.env.BANK_DEFAULT_FROM_ACC || payment.BankAccountNumber,
    toAccNumber:      bp?.accountNumber,
    beneficiaryName:  bp?.fullName                     || payment.PayFnPayeeName,
    beneficiaryMob:   '0765451161',
    beneficiaryEmail: 'test@mail.com',
    amount:           payment.PayFnTransactionAmount,
    remark:           payment.PayFnCatPurposeCodeDesc,
    bankCode:         process.env.BANK_DEFAULT_BANK_CODE || '7278'
  }
}

/**
 * Strips HTML login pages (common SAP 401 responses) down to useful bits
 * for log-friendly error summaries.
 */
function summarizeErrorResponse(err) {
  const status = err.response?.status
  const statusText = err.response?.statusText
  let data = err.response?.data

  if (typeof data === 'string' && /<html/i.test(data)) {
    const titleMatch  = data.match(/<title>(.*?)<\/title>/i)
    const headerMatch = data.match(/errorTextHeader">\s*([^<]+)/i)
    data = {
      note:   'HTML error page received (truncated)',
      title:  titleMatch  ? titleMatch[1].trim()  : undefined,
      detail: headerMatch ? headerMatch[1].trim() : undefined
    }
  }

  return { status, statusText, data: data ?? err.message }
}

/**
 * Returns true when a transaction with the given externalId already exists
 * in the local SQLite Transaction table.
 */
async function isAlreadyProcessed(database, externalId) {
  const row = await database.run(
    SELECT.one.from('my.bankintegration.Transaction').where({ externalId })
  )
  return Boolean(row)
}

/**
 * Persists a successfully sent transaction into the SQLite Transaction table.
 * Only called after the bank returns a successful response.
 */
async function saveTransaction(database, externalId, payload, bankResponse, bp = null) {
  await database.run(
    INSERT.into('my.bankintegration.Transaction').entries({
      externalId,
      fromAccNumber:   payload.fromAccNumber,
      toAccNumber:     payload.toAccNumber,
      beneficiaryName: payload.beneficiaryName,
      amount:          payload.amount,
      currency:        'LKR',
      postingDate:     new Date().toISOString().split('T')[0],
      status:          'Completed',
      bankResponse:    JSON.stringify(bankResponse),
      businessPartner_businessPartnerId: bp?.businessPartnerId || null
    })
  )
  log.info(`Transaction ${externalId} saved to DB with status Completed.`)
}

/**
 * Fetches the current payment list from S/4HANA.
 */
async function fetchPayments() {
  log.info(`Fetching payments from S/4HANA: ${S4_API_URL}`)

  try {
    const response = await axios.get(S4_API_URL, {
      auth: { username: S4_USER, password: S4_PASSWORD },
      headers: { Accept: 'application/json' }
    })

    const rows = response.data?.value || []
    log.info(`S/4HANA responded with ${rows.length} row(s)`)
    log.debug('S/4HANA raw payload:', response.data)
    return rows
  } catch (err) {
    const summary = summarizeErrorResponse(err)
    log.error(
      `Failed to fetch from S/4HANA (status ${summary.status ?? 'n/a'} ${summary.statusText ?? ''}):`,
      summary.data
    )
    throw err
  }
}

/**
 * One full poll cycle:
 *   1. Fetch all payments from S/4HANA.
 *   2. Filter out any whose externalId already exists in the Transaction table.
 *   3. For each new payment, call doSampathTran.
 *   4. On bank success  → save to Transaction table (Completed).
 *   5. On bank failure  → skip saving; the next cycle will retry.
 */
async function pollPayments() {
  log.info('=== Poll cycle started ===')

  let allPayments
  try {
    allPayments = await fetchPayments()
  } catch {
    log.info('=== Poll cycle aborted (S/4HANA fetch failed) ===')
    return
  }

  const database = await getDb()

  // Identify which payments have NOT yet been processed
  const newPayments = []
  for (const payment of allPayments) {
    const id = getPaymentId(payment)
    if (!id) {
      log.warn('Skipping payment row with no resolvable id:', payment)
      continue
    }
    if (!(await isAlreadyProcessed(database, id))) {
      newPayments.push(payment)
    }
  }

  log.info(`${newPayments.length} new payment(s) out of ${allPayments.length} total`)

  if (newPayments.length === 0) {
    log.info('No new payments to process.')
    log.info('=== Poll cycle complete ===')
    return
  }

  for (const payment of newPayments) {
    const id = getPaymentId(payment)

    // Look up the local BusinessPartner first — use their stored contact & account details
    const bp      = await getLocalBusinessPartner(database, payment)
    const payload = toTransactionPayload(payment, bp)

    log.info(`Processing payment ${id}${bp ? ` (BP: ${bp.businessPartnerId} — ${bp.fullName})` : ' (no local BP found)'}`)
    log.info(`Payload for ${id}:`, payload)

    try {
      const result = await doSampathTran(payload)

      // Print bank response to terminal as required
      console.log(`\n[Bank response] Payment ${id}:`, JSON.stringify(result, null, 2))
      log.info(`Bank response for ${id}:`, result)

      // Only persist when the bank confirms success
      await saveTransaction(database, id, payload, result, bp)
    } catch (err) {
      const errData = err.response?.data || err.message
      log.error(`Bank transfer failed for ${id} — will retry next cycle:`, errData)
      // Intentionally NOT saved → next poll will re-attempt
    }
  }

  log.info('=== Poll cycle complete ===')
}

/**
 * Bootstraps the CDS db connection, then starts the 5-minute polling loop.
 */
async function startPolling() {
  if (!S4_API_URL) {
    log.error('S4_API_URL is not set. Configure it in .env before starting.')
    return
  }

  // Warm up the CDS db connection so entities are ready before the first poll
  await getDb()

  log.info(`Bank integration worker started. Poll interval: ${POLL_INTERVAL_MS}ms`)
  log.info(`Log file: ${log.LOG_FILE}`)

  await pollPayments()
  setInterval(pollPayments, POLL_INTERVAL_MS)
}

if (require.main === module) {
  startPolling().catch((err) => {
    log.error('Fatal startup error:', err.stack || err.message)
    process.exitCode = 1
  })
}

module.exports = { pollPayments, startPolling, getPaymentId, toTransactionPayload, getLocalBusinessPartner, fetchPayments }
