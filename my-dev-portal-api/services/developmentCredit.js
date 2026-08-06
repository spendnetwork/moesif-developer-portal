const DEVELOPMENT_CREDIT_GBP = 50;
const DEVELOPMENT_CREDIT_PENCE = DEVELOPMENT_CREDIT_GBP * 100;
const DEVELOPMENT_CREDIT_MARKER = "oo_development_credit_v1";

function developmentCreditTransactionId(companyId) {
  return `${DEVELOPMENT_CREDIT_MARKER}_${String(companyId)}`;
}

module.exports = {
  DEVELOPMENT_CREDIT_GBP,
  DEVELOPMENT_CREDIT_MARKER,
  DEVELOPMENT_CREDIT_PENCE,
  developmentCreditTransactionId,
};
