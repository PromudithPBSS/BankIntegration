require('dotenv').config()
const { getAccessToken } = require('../srv/bankApiClient')

;(async () => {
  try {
    console.log('Requesting bank access token from:', process.env.BANK_TOKEN_PATH)
    const token = await getAccessToken()
    console.log('Success. Access token received:')
    console.log(token)
  } catch (err) {
    console.error('Token request failed:')
    if (err.response) {
      console.error('Status:', err.response.status)
      console.error('Data:', err.response.data)
    } else {
      console.error(err.message)
    }
    process.exitCode = 1
  }
})()
