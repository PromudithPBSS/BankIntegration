require('dotenv').config()

const axios = require('axios')
const { doSampathTran } = require('./bankApiClient')
const db = require('./db')
const log = require('./logger')

// S/4HANA payment API polled on an interval (self-polling worker, no iFlow/CAP required)
const S4_API_URL = process.env.S4_API_URL
const S4_USER = process.env.S4_USER
const S4_PASSWORD = process.env.S4_PASSWORD
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5 * 60 * 1000 // default 5 minutes

/**
 * Resolves a stable unique id for a payment record returned by S/4HANA,
 * used as the dedup key against the local processed-transactions DB.
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
 * Maps a raw S/4HANA payment record (PayFnPaymentAPIBasic) to the payload
 * expected by doSampathTran.
 */
function toTransactionPayload(payment = {}) {
  return {
    fromAccNumber: payment.BankAccountNumber || process.env.BANK_DEFAULT_FROM_ACC,
    toAccNumber: payment.toAccNumber || payment.PayeeBankAccountNumber,
    beneficiaryName: payment.PayFnPayeeName,
    beneficiaryMob: payment.beneficiaryMob || payment.PayeeMobileNumber,
    beneficiaryEmail: payment.beneficiaryEmail || payment.PayeeEmail,
    amount: payment.PayFnTransactionAmount,
    remark: payment.PayFnCatPurposeCodeDesc,
    bankCode: '7278'
  }
}

/**
 * Extracts a compact, log-friendly summary of an axios error response.
 * SAP gateways often return a full HTML login-failure page (with an
 * embedded base64 logo) on 401s - this strips that down to the useful bits
 * instead of dumping the whole page into the log file.
 */
function summarizeErrorResponse(err) {
  const status = err.response?.status
  const statusText = err.response?.statusText
  let data = err.response?.data

  if (typeof data === 'string' && /<html/i.test(data)) {
    const titleMatch = data.match(/<title>(.*?)<\/title>/i)
    const headerMatch = data.match(/errorTextHeader">\s*([^<]+)/i)
    data = {
      note: 'HTML error page received from server (truncated)',
      title: titleMatch ? titleMatch[1].trim() : undefined,
      detail: headerMatch ? headerMatch[1].trim() : undefined
    }
  }

  return { status, statusText, data: data ?? err.message }
}

/**
 * Fetches the current payment list from S/4HANA and logs the raw response.
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
    log.debug('S/4HANA raw response payload:', response.data)

    return rows
  } catch (err) {
    const summary = summarizeErrorResponse(err)
    log.error(`Failed to fetch from S/4HANA (status ${summary.status ?? 'n/a'} ${summary.statusText ?? ''}):`, summary.data)
    throw err
  }
}

/**
 * One full poll cycle: fetch -> filter unprocessed -> send to bank -> record result.
 */
async function pollPayments() {
  log.info('=== Poll cycle started ===')

  let allPayments
  try {
    allPayments = await fetchPayments()
  } catch (err) {
    log.info('=== Poll cycle aborted (fetch failed) ===')
    return
  }

  log.info('Fetched rows:', allPayments)

  const newPayments = allPayments.filter((payment) => {
    const id = getPaymentId(payment)
    if (!id) {
      log.warn('Skipping payment row with no resolvable id:', payment)
      return false
    }
    return !db.isProcessed(id)
  })

  log.info(`Filtered ${newPayments.length} new payment(s) out of ${allPayments.length} total`)
  log.info('New (unprocessed) rows:', newPayments)

  if (newPayments.length === 0) {
    log.info('No new payments found.')
    log.info('=== Poll cycle complete ===')
    return
  }

  for (const payment of newPayments) {
    const id = getPaymentId(payment)
    const payload = toTransactionPayload(payment)

    log.info(`Processing payment ${id}`)
    log.info(`Payload for ${id}:`, payload)

    try {
      const result = await doSampathTran(payload)
      log.info(`Bank response for ${id}:`, result)

      db.markProcessed(id, { payload, response: result, status: 'SUCCESS' })
      log.info(`Successfully processed and recorded: ${id}`)
    } catch (err) {
      const errData = err.response?.data || err.message
      log.error(`Bank transfer failed for ${id}:`, errData)
      // Not marked as processed, so it will be retried on the next poll cycle
    }
  }

  log.info('=== Poll cycle complete ===')
}

/**
 * Starts the background worker: runs one poll immediately, then on the
 * configured interval. This replaces the old cds.on('bootstrap', ...) hook
 * since this app no longer depends on @sap/cds.
 */
function startPolling() {
  if (!S4_API_URL) {
    log.error('S4_API_URL is not configured. Set it in .env before starting the worker.')
    return
  }

  log.info(`Starting bank integration worker. Poll interval: ${POLL_INTERVAL_MS}ms`)
  log.info(`Processed transactions DB: ${db.DB_FILE}`)
  log.info(`Log file: ${log.LOG_FILE}`)

  pollPayments()
  setInterval(pollPayments, POLL_INTERVAL_MS)
}

if (require.main === module) {
  startPolling()
}

module.exports = { pollPayments, startPolling, getPaymentId, toTransactionPayload, fetchPayments }
