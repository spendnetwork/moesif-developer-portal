const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBasicUsageSummary,
} = require("../services/basicUsageSummary");

const catalogue = {
  hits: [{
    id: "prod_basic",
    metadata: { plan_key: "basic" },
    prices: [
      {
        id: "price_api",
        nickname: "Basic - API Call",
        unit_amount: 26,
        metadata: { usage_metric: "api_call" },
      },
      {
        id: "price_records",
        nickname: "Basic - Record Returned",
        unit_amount: 13,
        metadata: { usage_metric: "records_returned" },
      },
      {
        id: "price_aggregate",
        nickname: "Basic - Aggregate Call",
        unit_amount: 46,
        metadata: { usage_metric: "aggregate_call" },
      },
      {
        id: "price_attachment",
        nickname: "Basic - Attachment",
        unit_amount: 65,
        metadata: { usage_metric: "attachment" },
      },
    ],
  }],
};

function balance(overrides = {}) {
  return {
    currency: "GBP",
    current: 400,
    pending: -30,
    available: 370,
    subscription: {
      current_period_start: "2026-07-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

const reports = [
  {
    _id: "report_api_old",
    type: "usage",
    success: true,
    price_id: "price_api",
    billing_meter_id: "meter_api",
    report_total_usage: 10,
    updated_at: "2026-07-20T00:00:00.000Z",
  },
  {
    _id: "report_api_latest",
    type: "usage",
    success: true,
    price_id: "price_api",
    billing_meter_id: "meter_api",
    report_total_usage: 12,
    updated_at: "2026-07-21T00:00:00.000Z",
  },
  {
    _id: "report_records",
    type: "usage",
    success: true,
    price_id: "price_records",
    billing_meter_id: "meter_records",
    report_total_usage: 100,
    updated_at: "2026-07-21T00:00:00.000Z",
  },
];

test("Basic summary restores request count, credit used, and metric totals", () => {
  const summary = buildBasicUsageSummary({
    balance: balance(),
    totalPurchasedPence: 50000,
    reports,
    planCatalogue: catalogue,
    eventCount: 37,
    now: Date.parse("2026-07-30T12:00:00.000Z"),
  });

  assert.equal(summary.billingModel, "prepaid_credit");
  assert.equal(summary.requestCount, 37);
  assert.equal(summary.credit.granted, 50000);
  assert.equal(summary.credit.remaining, 37000);
  assert.equal(summary.credit.used, 13000);
  assert.equal(summary.lines.length, 4);
  assert.equal(summary.lines[0].rate, 26);
  assert.equal(summary.lines[0].amount, 312);
  assert.equal(summary.lines[1].amount, 1300);
  assert.equal(summary.lines[2].quantity, 0);
  assert.equal(summary.lines[2].rate, 46);
  assert.equal(summary.accrued, 1612);
  assert.equal(summary.period.start, 1782864000);
});

test("adding another Basic top-up increases purchased credit without resetting usage", () => {
  const summary = buildBasicUsageSummary({
    balance: balance({ current: 700, available: 670 }),
    totalPurchasedPence: 80000,
    reports,
    planCatalogue: catalogue,
    eventCount: 44,
  });

  assert.equal(summary.requestCount, 44);
  assert.equal(summary.credit.granted, 80000);
  assert.equal(summary.credit.remaining, 67000);
  assert.equal(summary.credit.used, 13000);
});

test("a temporary analytics failure still returns the authoritative balance", () => {
  const summary = buildBasicUsageSummary({
    balance: balance(),
    totalPurchasedPence: null,
    reports: [],
    planCatalogue: [],
    analyticsAvailable: false,
  });

  assert.equal(summary.requestCount, null);
  assert.deepEqual(summary.lines, []);
  assert.equal(summary.credit.remaining, 37000);
  assert.equal(summary.credit.granted, null);
  assert.equal(summary.credit.used, null);
});

test("missing Moesif balance data is never presented as zero credit", () => {
  const summary = buildBasicUsageSummary({
    balance: balance({
      balanceAvailable: false,
      current: null,
      pending: null,
      available: null,
    }),
    totalPurchasedPence: 50000,
    reports: [],
    planCatalogue: catalogue,
    eventCount: 8,
  });

  assert.equal(summary.requestCount, 8);
  assert.equal(summary.credit.available, false);
  assert.equal(summary.credit.remaining, null);
  assert.equal(summary.credit.used, null);
  assert.equal(summary.credit.granted, 50000);
});
