const test = require("node:test");
const assert = require("node:assert/strict");
const { localUsageSummary, localSubscription } = require("../services/localUsageSummary");

function snapshot(overrides = {}) {
  return {
    plan_key: "development", subscription_id: "prepaid_dev", debit_owner: "api", currency: "GBP",
    current_period_start: "2026-09-01T00:00:00Z", as_of: "2026-09-07T00:00:00Z",
    balances: { development: { granted_gbp_pence: 10000, remaining_gbp_pence: 9600, spendable_gbp_pence: 9600, expired_gbp_pence: 0 } },
    historical_balances: { commercial: { granted_gbp_pence: 900000, remaining_gbp_pence: 900000 } },
    usage: { cost_gbp_pence: 400, to: "2026-09-07T00:00:00Z",
      measurements: { api_call_quantity: 1, records_returned: 2, aggregate_call_quantity: 0, attachment_list_quantity: 2, attachment_download_quantity: 1 },
      cost_by_metric_gbp_pence: { api_call_quantity: 100, records_returned: 100, aggregate_call_quantity: 0, attachment_list_quantity: 125, attachment_download_quantity: 75 } },
    rate_card: { api_call_quantity: 26, records_returned: 13, aggregate_call_quantity: 46, attachment_list_quantity: 65, attachment_download_quantity: 65 },
    access_block_reason: null,
    ...overrides,
  };
}

test("local summary uses exactly four metrics and combines settled attachment amounts", () => {
  const result = localUsageSummary(snapshot());
  assert.equal(result.lines.length, 4);
  assert.deepEqual(result.lines[3], { key: "attachment", label: "Attachments", included: true, quantity: 3, rate: 65, amount: 200 });
  assert.equal(result.lines[2].included, false);
  assert.equal(result.accrued, 400);
  assert.equal(result.credit.granted, 10000);
  assert.equal(result.credit.remaining, 9600);
  assert.equal(result.credit.used, 400);
  assert.equal(result.period.start, Date.parse("2026-09-01T00:00:00Z") / 1000);
});

test("missing per-metric costs remain unknown, never recomputed from today's rates", () => {
  const input = snapshot();
  delete input.usage.cost_by_metric_gbp_pence;
  const result = localUsageSummary(input);
  assert.ok(result.lines.every(line => line.amount === null));
  assert.equal(result.accrued, 400);
});

test("a partial attachment cost is not shown as the total", () => {
  const input = snapshot();
  delete input.usage.cost_by_metric_gbp_pence.attachment_download_quantity;
  assert.equal(localUsageSummary(input).lines[3].amount, null);
});

test("an account pause preserves unexpired remaining money and reports spendability separately", () => {
  const input = snapshot({ access_block_reason: "access_paused" });
  input.balances.development.spendable_gbp_pence = 0;
  const result = localUsageSummary(input);
  assert.equal(result.credit.remaining, 9600);
  assert.equal(result.credit.spendable, 0);
  assert.equal(result.credit.used, 400);
});

test("expired allowance is labelled, not counted as consumption", () => {
  const input = snapshot();
  input.balances.development.expired_gbp_pence = 1600;
  input.balances.development.spendable_gbp_pence = 8000;
  const result = localUsageSummary(input);
  assert.equal(result.credit.remaining, 8000);
  assert.equal(result.credit.expired, 1600);
  assert.equal(result.credit.used, 400);
});

test("API eligible balance is shown separately from paused spendable credit", () => {
  const input = snapshot({ access_block_reason: "access_paused" });
  input.balances.development.eligible_gbp_pence = 8000;
  input.balances.development.expired_gbp_pence = 1600;
  input.balances.development.spendable_gbp_pence = 0;
  assert.equal(localUsageSummary(input).credit.remaining, 8000);
  assert.equal(localUsageSummary(input).credit.spendable, 0);
});

test("exhaustion keeps Development visible and management active without Stripe", () => {
  const input = snapshot({ access_block_reason: "insufficient_credit" });
  input.balances.development.remaining_gbp_pence = 0;
  input.balances.development.spendable_gbp_pence = 0;
  const result = localSubscription(input);
  assert.equal(result.status, "active");
  assert.equal(result.plan_key, "development");
  assert.equal(result.access_block_reason, "insufficient_credit");
  assert.equal(result.items.length, 4);
});

test("Basic includes available Development but excludes historical commercial balances", () => {
  const input = snapshot({ plan_key: "basic" });
  input.balances.commercial = { granted_gbp_pence: 10000, remaining_gbp_pence: 9600, spendable_gbp_pence: 9600, expired_gbp_pence: 0 };
  assert.equal(localUsageSummary(input).credit.granted, 20000);
  assert.equal(localUsageSummary(input).credit.remaining, 19200);
});

test("legacy balances are not presented as locally authoritative, missing local money fails closed", () => {
  assert.equal(localUsageSummary(snapshot({ debit_owner: "moesif" })), null);
  assert.throws(() => localUsageSummary(snapshot({ balances: {} })), { code: "local_ledger_unavailable" });
});

module.exports = { snapshot };

test("manual Growth uses mixed local balances without changing its annual period or rates", () => {
  const input = snapshot({ plan_key: "growth", debit_owner: "admin", billing_provider: "manual",
    current_period_end: "2027-09-01T00:00:00Z" });
  input.usage.balance_authority = "local_ledger";
  input.balances.commercial = { granted_gbp_pence: 500000, remaining_gbp_pence: 500000, spendable_gbp_pence: 500000, expired_gbp_pence: 0 };
  input.rate_card = { api_call_quantity: 20, records_returned: 10, aggregate_call_quantity: 35, attachment_list_quantity: 50, attachment_download_quantity: 50 };
  const result = localUsageSummary(input);
  assert.equal(result.credit.remaining, 509600);
  assert.equal(result.lines[2].included, true);
  assert.equal(result.lines[2].rate, 35);
  assert.equal(result.period.end, Date.parse(input.current_period_end) / 1000);
  assert.equal(localSubscription(input).billing_provider, "manual");
  assert.equal(result.analytics.source, "local_ledger");
});
