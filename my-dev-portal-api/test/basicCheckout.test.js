const test = require("node:test");
const assert = require("node:assert/strict");
const Stripe = require("stripe");
const stripePath = require.resolve("stripe");
const calls = [];
const authUser = { sub: "auth0|buyer", email: "buyer@example.com" };
const customer = { id: "cus_buyer", email: authUser.email, metadata: { authUserId: authUser.sub } };
const fakeStripe = {
  products: { retrieve: async () => ({ id: "prod_basic", metadata: { plan_key: "basic" } }) },
  customers: { search: async () => ({ data: [customer] }) },
  subscriptions: { list: async () => ({ data: [] }) },
  checkout: { sessions: { create: async (...args) => { calls.push(args); return { id: "cs_test" }; } } },
};
require.cache[stripePath].exports = () => fakeStripe;
const { createBasicCreditCheckoutSession } = require("../services/stripeApis");
require.cache[stripePath].exports = Stripe;

for (const purchaseType of ["basic_activation", "basic_credit_top_up"]) {
  test(`${purchaseType} rejects new payments below GBP 50 before creating Checkout`, async () => {
    const before = calls.length;
    for (const amount of [0, -1, "", "invalid", 1, 49.99, 50.001, Infinity]) {
      await assert.rejects(createBasicCreditCheckoutSession(authUser.email, "prod_basic", amount, purchaseType, authUser, "request"));
    }
    assert.equal(calls.length, before);
  });
  test(`${purchaseType} is a one-off payment on the existing product with no free credit`, async () => {
    for (const amount of [50, 50.01, 100, 250]) {
      await createBasicCreditCheckoutSession(authUser.email, "prod_basic", amount, purchaseType, authUser, "request",
        { current_plan_key: "development", current_subscription_id: "prepaid_dev" });
      const [payload, options] = calls.at(-1);
      assert.equal(payload.mode, "payment");
      assert.equal(payload.subscription_data, undefined);
      assert.equal(payload.line_items[0].price_data.product, "prod_basic");
      assert.equal(payload.line_items[0].price_data.recurring, undefined);
      assert.equal(payload.line_items[0].price_data.unit_amount, Math.round(amount * 100));
      assert.equal(payload.metadata.expected_current_plan_key, "development");
      assert.equal(payload.metadata.expected_current_subscription_id, "prepaid_dev");
      assert.equal(payload.payment_intent_data.metadata.purchase_type, purchaseType);
      assert.equal(options.idempotencyKey, `${purchaseType}-request`);
    }
  });
}
