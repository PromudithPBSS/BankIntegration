using { my.bankintegration as my } from '../db/schema';

service BankingService {
    entity BusinessPartners as projection on my.BusinessPartner;
    entity Transactions     as projection on my.Transaction;
}