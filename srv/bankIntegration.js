const cds = require('@sap/cds')
const { doSampathTran } = require('./bankApiClient')

// CloudEvents topic emitted when a CNxPaymentRequisition is created (SAP S/4 BEH)
const EVENT_TOPIC = 'ce/sap/s4/beh/cnxpaymentrequisition/v1/CNxPaymentRequisition/Created/v1'

function toTransactionPayload(eventData = {}) {
  return {
    fromAccNumber: eventData.fromAccNumber || process.env.BANK_DEFAULT_FROM_ACC,
    toAccNumber: eventData.toAccNumber,
    beneficiaryName: eventData.beneficiaryName,
    beneficiaryMob: eventData.beneficiaryMob,
    beneficiaryEmail: eventData.beneficiaryEmail,
    amount: eventData.amount,
    remark: eventData.remark,
    bankCode: eventData.bankCode || process.env.BANK_DEFAULT_BANK_CODE
  }
}

cds.on('bootstrap', async () => {
  const messaging = await cds.connect.to('messaging')
  const log = cds.log('bank-integration')

  messaging.on(EVENT_TOPIC, async (msg) => {
    const eventData = msg.data || {}
    log.info('Received CNxPaymentRequisition Created event:', eventData)

    try {
      const payload = toTransactionPayload(eventData)
      const result = await doSampathTran(payload)
      log.info('Bank transaction submitted successfully:', result)
    } catch (err) {
      log.error('Bank transaction failed:', err.response?.data || err.message)
      throw err
    }
  })
})
