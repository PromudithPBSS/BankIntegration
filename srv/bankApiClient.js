const axios = require('axios')

let cachedToken = null
let tokenExpiryTime = 0

function maskToken(token) {
  if (!token) return token
  return `${token.slice(0, 8)}...${token.slice(-8)}`
}

function logRequest(label, { method, url, headers, data }) {
  const safeHeaders = { ...headers }
  if (safeHeaders.Authorization) {
    safeHeaders.Authorization = maskToken(safeHeaders.Authorization)
  }
  console.log(`--- ${label} request ---`)
  console.log('Method:', method)
  console.log('URL:', url)
  console.log('Headers:', safeHeaders)
  console.log('Body:', data)
}

function logErrorResponse(label, err) {
  console.error(`--- ${label} error ---`)
  if (err.config) {
    const safeHeaders = { ...err.config.headers }
    if (safeHeaders.Authorization) {
      safeHeaders.Authorization = maskToken(safeHeaders.Authorization)
    }
    console.error('Request URL:', err.config.url)
    console.error('Request headers sent:', safeHeaders)
    console.error('Request body sent:', err.config.data)
  }
  if (err.response) {
    console.error('Response status:', err.response.status)
    console.error('Response headers:', err.response.headers)
    console.error('Response data:', err.response.data)
  } else {
    console.error('No response received. Error message:', err.message)
  }
}

/**
 * Fetches an OAuth2 access token from the bank's login endpoint
 * (BANK_TOKEN_PATH), caching it until shortly before expiry.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiryTime) {
    return cachedToken
  }

  const tokenUrl = `${process.env.BANK_TOKEN_PATH}`

  const params = new URLSearchParams({
    grant_type: process.env.BANK_GRANT_TYPE || 'client_credentials',
    client_id: process.env.BANK_CLIENT_ID,
    client_secret: process.env.BANK_CLIENT_SECRET,
    scope: process.env.BANK_TOKEN_SCOPE || 'api_banking'
  })

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: process.env.BANK_TOKEN_AUTHORIZATION
  }

  logRequest('Token', { method: 'POST', url: tokenUrl, headers, data: params.toString() })

  try {
    const { data } = await axios.post(tokenUrl, params, { headers })

    cachedToken = data.access_token
    const expiresInSeconds = Number(data.expires_in) || 300
    // refresh 30s before actual expiry to avoid using a stale token
    tokenExpiryTime = Date.now() + Math.max(expiresInSeconds - 30, 0) * 1000

    return cachedToken
  } catch (err) {
    logErrorResponse('Token', err)
    throw err
  }
}

/**
 * Calls the bank's doSampathTran endpoint with the given payload,
 * authenticating with a bearer token obtained from getAccessToken().
 */
async function doSampathTran(payload) {
  const token = await getAccessToken()
  const transactionUrl = `${process.env.BANK_BASE_URL}${process.env.BANK_TRANSACTION_PATH}`

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': 'PostmanRuntime/7.36.3',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  }

  logRequest('doSampathTran', { method: 'POST', url: transactionUrl, headers, data: payload })

  try {
    const { data } = await axios.post(transactionUrl, payload, { headers })
    return data
  } catch (err) {
    logErrorResponse('doSampathTran', err)
    throw err
  }
}

module.exports = { getAccessToken, doSampathTran }
