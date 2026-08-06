const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SALES_CONTACT_EMAIL,
  commitmentUpgradeQuote,
  eligiblePaidBasicCreditPence,
  getContactLedPlanDetails,
  normalizedSalesContactEmail,
  requiresManagedContact,
} = require("../services/planPurchasePolicy");

test("Growth and Enterprise require a contact-led invoice", () => {
  for (const planKey of ["growth", "enterprise"]) {
    const details = getContactLedPlanDetails(planKey, "sales@example.com");
    assert.equal(details.code, "contact_required");
    assert.equal(details.contact_email, "sales@example.com");
    assert.match(details.message, /arranged by invoice/);
  }
});

test("Basic remains eligible for self-service checkout", () => {
  assert.equal(getContactLedPlanDetails("basic", "sales@example.com"), null);
});

test("invalid contact configuration falls back to the company address", () => {
  assert.equal(
    normalizedSalesContactEmail("not-an-email"),
    DEFAULT_SALES_CONTACT_EMAIL
  );
});

test("managed contact applies to initial selections and upgrades, not downgrades", () => {
  assert.equal(requiresManagedContact(null, "growth"), true);
  assert.equal(requiresManagedContact("basic", "growth"), true);
  assert.equal(requiresManagedContact("growth", "enterprise"), true);
  assert.equal(requiresManagedContact("enterprise", "growth"), false);
  assert.equal(requiresManagedContact("growth", "basic"), false);
});

test("unused paid Basic credit is capped by the live balance", () => {
  assert.equal(
    eligiblePaidBasicCreditPence({
      totalPurchasedPence: 80000,
      balancePence: 110000,
    }),
    80000
  );
  assert.equal(
    eligiblePaidBasicCreditPence({
      totalPurchasedPence: 80000,
      balancePence: 70000,
    }),
    70000
  );
});

test("Basic credit reduces Growth while plan commitments define later upgrades", () => {
  assert.deepEqual(
    commitmentUpgradeQuote({
      fromPlanKey: "basic",
      targetCommitmentPence: 500000,
      paidBasicCreditPence: 80000,
    }),
    {
      targetCommitmentPence: 500000,
      creditAppliedPence: 80000,
      amountDuePence: 420000,
    }
  );
  assert.deepEqual(
    commitmentUpgradeQuote({
      fromPlanKey: "growth",
      targetCommitmentPence: 1200000,
      currentCommitmentPence: 500000,
    }),
    {
      targetCommitmentPence: 1200000,
      creditAppliedPence: 500000,
      amountDuePence: 700000,
    }
  );
});
