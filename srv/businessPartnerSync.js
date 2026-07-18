require('dotenv').config()

const axios = require('axios')
const cds = require('@sap/cds')
const { UPSERT } = cds.ql
const log = require('./logger')

const S4_BUSINESS_PARTNER_API_URL = process.env.S4_BUSINESS_PARTNER_API_URL
const S4_USER = process.env.S4_USER
const S4_PASSWORD = process.env.S4_PASSWORD

function logSyncError(error) {
  if (error.response) {
    log.error('S/4HANA business partner request failed:', {
      status: error.response.status,
      statusText: error.response.statusText,
      headers: error.response.headers,
      data: error.response.data
    })
    return
  }

  log.error('Business partner synchronization failed:', error.stack || error.message || error)
}

function expandedRows(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.results)) return value.results
  return []
}

function preferredValue(rows, valueField, defaultField) {
  const defaultRow = rows.find((row) => row[defaultField] === true || row[defaultField] === 'true')
  return (defaultRow || rows[0])?.[valueField] || null
}

function toBusinessPartnerRecord(partner = {}) {
  const emails = expandedRows(partner.to_AddressIndependentEmail)
  const mobiles = expandedRows(partner.to_AddressIndependentMobile)

  return {
    businessPartnerId: partner.BusinessPartner,
    fullName: partner.BusinessPartnerFullName || null,
    email: preferredValue(emails, 'EmailAddress', 'IsDefaultEmailAddress'),
    mobileNumber:
      preferredValue(mobiles, 'InternationalPhoneNumber', 'IsDefaultPhoneNumber') ||
      preferredValue(mobiles, 'PhoneNumber', 'IsDefaultPhoneNumber')
  }
}

async function fetchBusinessPartners() {
  if (!S4_BUSINESS_PARTNER_API_URL) {
    throw new Error('S4_BUSINESS_PARTNER_API_URL is not configured.')
  }

  const response = await axios.get(S4_BUSINESS_PARTNER_API_URL, {
    auth: { username: S4_USER, password: S4_PASSWORD },
    headers: { Accept: 'application/json' },
    params: {
      '$select': 'BusinessPartner,BusinessPartnerFullName',
      '$expand': 'to_AddressIndependentEmail,to_AddressIndependentMobile'
    }
  })

  const partners = response.data?.d?.results || response.data?.value || []
  log.info(`S/4HANA returned ${partners.length} business partner(s).`)
  log.debug('S/4HANA business partner response:', response.data)
  return partners
}

async function syncBusinessPartners() {
  log.info(`Fetching business partners from S/4HANA: ${S4_BUSINESS_PARTNER_API_URL}`)
  const partners = await fetchBusinessPartners()
  const records = partners.map(toBusinessPartnerRecord).filter((partner) => partner.businessPartnerId)

  if (records.length === 0) {
    log.info('No business partners returned by S/4HANA.')
    return 0
  }

  const db = await cds.connect.to('db')
  await db.run(UPSERT.into('my.bankintegration.BusinessPartner').entries(records))
  log.info(`Upserted ${records.length} business partner(s) into the SQL database.`)
  return records.length
}

if (require.main === module) {
  syncBusinessPartners().catch((error) => {
    logSyncError(error)
    process.exitCode = 1
  })
}

module.exports = { fetchBusinessPartners, logSyncError, syncBusinessPartners, toBusinessPartnerRecord }