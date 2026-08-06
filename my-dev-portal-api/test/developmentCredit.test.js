const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEVELOPMENT_CREDIT_GBP,
  DEVELOPMENT_CREDIT_MARKER,
  DEVELOPMENT_CREDIT_PENCE,
  developmentCreditTransactionId,
} = require("../services/developmentCredit");

test("development credit is a fixed one-time GBP promotion", () => {
  assert.equal(DEVELOPMENT_CREDIT_GBP, 50);
  assert.equal(DEVELOPMENT_CREDIT_PENCE, 5000);
  assert.equal(DEVELOPMENT_CREDIT_MARKER, "oo_development_credit_v1");
  assert.equal(
    developmentCreditTransactionId(9),
    "oo_development_credit_v1_9"
  );
});
