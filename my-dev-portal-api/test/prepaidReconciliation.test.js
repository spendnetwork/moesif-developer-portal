const test = require("node:test");
const assert = require("node:assert/strict");

const {
  prepaidSubscriptionPeriodEnd,
  reconcileBasicTopUp,
} = require("../services/prepaidReconciliation");

function checkoutSession(overrides = {}) {
  return {
    id: "cs_top_up",
    status: "complete",
    payment_status: "paid",
    amount_total: 50000,
    currency: "gbp",
    customer: {
      id: "cus_123",
      email: "buyer@example.com",
      metadata: { authUserId: "auth0|123" },
    },
    payment_intent: { id: "pi_123" },
    client_reference_id: "auth0|123",
    metadata: {
      purchase_type: "basic_credit_top_up",
      plan_id: "prod_basic",
      plan_key: "basic",
      amount_gbp_pence: "50000",
      auth0_user_id: "auth0|123",
    },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    verifyStripeSession: async () => checkoutSession(),
    getStripeCustomerById: async () => checkoutSession().customer,
    getStripeProduct: async () => ({
      id: "prod_basic",
      metadata: { plan_key: "basic" },
    }),
    getPlanKeyForProduct: async () => "basic",
    getPlanPrices: async () => ({
      commitmentPrices: [],
      meteredPrices: [
        { id: "price_api", recurring: { meter: "meter_api" } },
        { id: "price_records", recurring: { meter: "meter_records" } },
        { id: "price_aggregate", recurring: { meter: "meter_aggregate" } },
        { id: "price_attachment", recurring: { meter: "meter_attachment" } },
      ],
    }),
    provisionSnApiPrepaidCustomer: async () => ({
      user_id: 7,
      organization_id: 9,
      moesif_company_id: "9",
    }),
    updateStripeCustomerIdentity: async () => {},
    syncToMoesif: async () => {},
    sendPrepaidSubscriptionToMoesif: async () =>
      "openopps_basic_prepaid_cus_123",
    createMoesifBalanceTransaction: async () => {},
    ...overrides,
  };
}

test("paid Basic Checkout provisions access and credits Moesif idempotently", async () => {
  let subscriptionInput;
  let creditInput;
  const result = await reconcileBasicTopUp(
    "cs_top_up",
    { sub: "auth0|123", email: "buyer@example.com" },
    dependencies({
      sendPrepaidSubscriptionToMoesif: async (input) => {
        subscriptionInput = input;
        return "openopps_basic_prepaid_cus_123";
      },
      createMoesifBalanceTransaction: async (input) => {
        creditInput = input;
      },
    })
  );

  assert.equal(result.planKey, "basic");
  assert.equal(result.amountPence, 50000);
  assert.deepEqual(subscriptionInput.priceIds, [
    "price_api",
    "price_records",
    "price_aggregate",
    "price_attachment",
  ]);
  const periodEnd = new Date(subscriptionInput.currentPeriodEnd);
  const latestAllowedEnd = new Date();
  latestAllowedEnd.setUTCFullYear(latestAllowedEnd.getUTCFullYear() + 50);
  assert.ok(periodEnd < latestAllowedEnd);
  assert.equal(creditInput.amountGbp, 500);
  assert.equal(creditInput.transactionId, "pi_123");
  assert.equal(creditInput.companyId, "9");
});

test("the prepaid period end stays inside Moesif's 50-year limit", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  assert.equal(
    prepaidSubscriptionPeriodEnd(now),
    "2075-07-30T12:00:00.000Z"
  );
});

test("a forged top-up amount never provisions or credits access", async () => {
  let provisionCalls = 0;
  await assert.rejects(
    reconcileBasicTopUp(
      checkoutSession({ amount_total: 100 }),
      { sub: "auth0|123", email: "buyer@example.com" },
      dependencies({
        verifyStripeSession: async () =>
          checkoutSession({ amount_total: 100 }),
        provisionSnApiPrepaidCustomer: async () => {
          provisionCalls += 1;
        },
      })
    ),
    (error) => error.code === "top_up_amount_mismatch"
  );
  assert.equal(provisionCalls, 0);
});

test("a Basic top-up is rejected when its four meters are not configured", async () => {
  let creditCalls = 0;
  await assert.rejects(
    reconcileBasicTopUp(
      checkoutSession(),
      { sub: "auth0|123", email: "buyer@example.com" },
      dependencies({
        getPlanPrices: async () => ({
          commitmentPrices: [],
          meteredPrices: [
            { id: "price_api", recurring: { meter: "meter_shared" } },
            { id: "price_records", recurring: { meter: "meter_shared" } },
            { id: "price_aggregate", recurring: { meter: "meter_aggregate" } },
            { id: "price_attachment", recurring: { meter: "meter_attachment" } },
          ],
        }),
        createMoesifBalanceTransaction: async () => {
          creditCalls += 1;
        },
      })
    ),
    (error) => error.code === "basic_price_configuration_invalid"
  );
  assert.equal(creditCalls, 0);
});
