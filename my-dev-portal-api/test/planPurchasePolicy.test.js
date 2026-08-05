const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SALES_CONTACT_EMAIL,
  getContactLedPlanDetails,
  normalizedSalesContactEmail,
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
