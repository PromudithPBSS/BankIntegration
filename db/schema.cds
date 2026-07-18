namespace my.bankintegration;

using { managed, cuid } from '@sap/cds/common';

entity BusinessPartner : managed {
    key businessPartnerId : String(10);
    fullName              : String(255);
    email                 : String(255);
    mobileNumber          : String(50);
    bankCode      : String(20);
    accountNumber : String(30);
    transactions  : Association to many Transaction on transactions.businessPartner = $self;
}

entity Transaction : cuid, managed {
    externalId      : String(100);  // S/4HANA unique ID — used for dedup
    fromAccNumber   : String(30);
    toAccNumber     : String(30);
    beneficiaryName : String(255);
    amount          : Decimal(15, 2);
    currency        : String(3);
    postingDate     : Date;
    status          : String(20);   // 'Pending' | 'Completed' | 'Failed'
    bankResponse    : LargeString;  // raw JSON response stored on success
    businessPartner : Association to BusinessPartner;
}