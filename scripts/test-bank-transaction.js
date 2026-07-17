require('dotenv').config()
const { doSampathTran } = require('../srv/bankApiClient')

// Sample payload matching the shape sent when CNxPaymentRequisition Created fires
const samplePayload = {
  fromAccNumber: '001410003577',
  toAccNumber: '100414021379',
  beneficiaryName: 'Test Payment',
  beneficiaryMob: '0765451161',
  beneficiaryEmail: 'test@mail.com',
  amount: 10.00,
  remark: 'testTran',
  bankCode: '7278'
}

;(async () => {
  try {
    console.log('Requesting token and calling doSampathTran with payload:', samplePayload)
    const result = await doSampathTran(samplePayload)
    console.log('Success. Bank response:', result)
  } catch (err) {
    console.error('Bank transaction test failed:')
    if (err.response) {
      console.error('Status:', err.response.status)
      console.error('Server header:', err.response.headers?.server)
      console.error('Data:', err.response.data)
    } else {
      console.error(err.message)
    }
    process.exitCode = 1
  }
})()
