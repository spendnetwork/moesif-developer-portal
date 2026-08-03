const test = require("node:test");
const assert = require("node:assert/strict");

process.env.STRIPE_API_KEY ||= "sk_test_placeholder";

const {
  buildStripeUsageLines,
  isMissingStripeCustomer,
} = require("../services/stripeApis");

test("recognizes Stripe's missing-customer responses as stale references", () => {
  assert.equal(isMissingStripeCustomer({ code: "resource_missing" }), true);
  assert.equal(isMissingStripeCustomer({ statusCode: 404 }), true);
  assert.equal(isMissingStripeCustomer({ status: 404 }), true);
  assert.equal(isMissingStripeCustomer({ code: "rate_limit" }), false);
});

function meteredPrice(id, nickname, metric, unitAmount) {
  return {
    id,
    nickname,
    unit_amount: unitAmount,
    metadata: { usage_metric: metric, plan_key: "growth" },
    recurring: { usage_type: "metered" },
  };
}

test("Stripe usage lines use the selected subscription's four prices", () => {
  const subscription = {
    items: {
      data: [
        { price: meteredPrice("price_api", "Growth - API Call", "api_call", 20) },
        {
          price: meteredPrice(
            "price_records",
            "Growth - Record Returned",
            "records_returned",
            10
          ),
        },
        {
          price: meteredPrice(
            "price_aggregate",
            "Growth - Aggregate Call",
            "aggregate_call",
            35
          ),
        },
        {
          price: meteredPrice(
            "price_attachment",
            "Growth - Attachment",
            "attachment",
            50
          ),
        },
        {
          price: {
            id: "price_commitment",
            metadata: { billing_category: "commitment" },
            recurring: { usage_type: "licensed" },
          },
        },
      ],
    },
  };
  const preview = {
    lines: {
      data: [
        {
          pricing: { price_details: { price: "price_api" } },
          quantity: 12,
          amount: 240,
        },
        { price: { id: "price_records" }, quantity: 100, amount: 1000 },
        { price: { id: "price_commitment" }, quantity: 1, amount: 500000 },
      ],
    },
  };

  const lines = buildStripeUsageLines(subscription, preview);

  assert.deepEqual(
    lines.map(({ key, rate, quantity, amount }) => ({
      key,
      rate,
      quantity,
      amount,
    })),
    [
      { key: "api_call", rate: 20, quantity: 12, amount: 240 },
      { key: "records_returned", rate: 10, quantity: 100, amount: 1000 },
      { key: "aggregate_call", rate: 35, quantity: 0, amount: 0 },
      { key: "attachment", rate: 50, quantity: 0, amount: 0 },
    ]
  );
});
