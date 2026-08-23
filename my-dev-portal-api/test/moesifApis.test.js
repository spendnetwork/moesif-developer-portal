const test = require("node:test");
const assert = require("node:assert/strict");

process.env.MOESIF_APPLICATION_ID ||= "00000000000000000000000000000000";
process.env.MOESIF_MANAGEMENT_TOKEN ||= "test-token";

const {
  eventUsageMetricValues,
  getMoesifUsageMetrics,
  latestEndingBalance,
  normalizedBalance,
  readMoesifResponse,
  waitForMoesifSubscription,
  isMoesifSubscriptionPropagationError,
} = require("../services/moesifApis");

test("manual subscription readiness waits until Moesif exposes the subscription", async () => {
  let requests = 0;
  const sleeps = [];
  await waitForMoesifSubscription({
    companyId: 15,
    subscriptionId: "manual_subscription",
    delaysMs: [1, 2],
    sleep: async (delayMs) => sleeps.push(delayMs),
    fetchImpl: async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          subscriptions:
            requests === 3
              ? [{ subscription_id: "manual_subscription" }]
              : [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  assert.equal(requests, 3);
  assert.deepEqual(sleeps, [1, 2]);
});

test("only subscription propagation validation errors are retryable", () => {
  assert.equal(
    isMoesifSubscriptionPropagationError({
      status: 400,
      detail: { message: "Subscription does not exist yet" },
    }),
    true
  );
  assert.equal(
    isMoesifSubscriptionPropagationError({
      status: 400,
      detail: { message: "Amount must be positive" },
    }),
    false
  );
  assert.equal(
    isMoesifSubscriptionPropagationError({
      status: 401,
      detail: { message: "Subscription not found" },
    }),
    false
  );
});

test("Moesif billing-scope failures have a stable operational code", async () => {
  const response = new Response(
    JSON.stringify({
      moesif_error: {
        message:
          "This API requires create:billing_meters or create:billing_reports",
      },
    }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );

  await assert.rejects(
    readMoesifResponse(response, "Moesif balance credit"),
    (error) =>
      error.code === "moesif_management_scope_missing" && error.status === 401
  );
});

test("Moesif non-JSON failures remain readable", async () => {
  const response = new Response("upstream unavailable", { status: 503 });
  await assert.rejects(
    readMoesifResponse(response, "Moesif lookup"),
    (error) =>
      error.status === 503 && error.message.includes("upstream unavailable")
  );
});

test("Moesif read:events failures have a stable operational code", async () => {
  const response = new Response(
    JSON.stringify({
      moesif_error: { message: "This API requires read:events" },
    }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );

  await assert.rejects(
    readMoesifResponse(response, "Moesif usage metrics lookup"),
    (error) => error.code === "moesif_event_scope_missing"
  );
});

test("usage authorization failures are classified even without scope detail", async () => {
  const response = new Response(
    JSON.stringify({ moesif_error: { message: "Unauthorized" } }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );

  await assert.rejects(
    readMoesifResponse(response, "Moesif usage metrics lookup"),
    (error) => error.code === "moesif_event_scope_missing"
  );
});

test("latest balance is selected by Moesif sequence rather than array order", () => {
  const latest = latestEndingBalance([
    {
      success: true,
      ending_balance: { sequence_id: 4, available_balance: 90 },
    },
    {
      success: true,
      ending_balance: { sequence_id: 7, available_balance: 75 },
    },
    {
      success: false,
      ending_balance: { sequence_id: 9, available_balance: 0 },
    },
  ]);

  assert.equal(latest.ending_balance.available_balance, 75);
});

test("missing balance fields are not converted into a zero balance", () => {
  assert.equal(normalizedBalance(undefined), null);
  assert.equal(normalizedBalance({ current_balance: 10 }), null);
  assert.deepEqual(
    normalizedBalance({
      current_balance: "50500",
      pending_activity: "10",
      available_balance: "50490",
    }),
    { current: 50500, pending: 10, available: 50490 }
  );
});

test("event metric parser combines attachment list and download units", () => {
  assert.deepEqual(
    eventUsageMetricValues({
      aggregations: {
        api_calls: { value: 6 },
        records_returned: { value: 40 },
        aggregate_calls: { value: 2 },
        attachment_list: { value: 3 },
        attachment_download: { value: 4 },
      },
    }),
    {
      api_call: 6,
      records_returned: 40,
      aggregate_call: 2,
      attachment: 7,
    }
  );
});

test("usage metrics query is constrained by user, company, and subscription", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(
      JSON.stringify({
        aggregations: {
          api_calls: { value: 1 },
          records_returned: { value: 2 },
          aggregate_calls: { value: 3 },
          attachment_list: { value: 4 },
          attachment_download: { value: 5 },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const result = await getMoesifUsageMetrics({
      userId: 10,
      companyId: 11,
      subscriptionId: "sub_basic",
      from: "2026-08-01T00:00:00.000Z",
      to: "now",
    });
    assert.deepEqual(result, {
      api_call: 1,
      records_returned: 2,
      aggregate_call: 3,
      attachment: 9,
    });
    assert.match(request.url, /search\/events/);
    assert.deepEqual(request.body.query.bool.filter, [
      { term: { "user_id.raw": "10" } },
      { term: { "company_id.raw": "11" } },
      { term: { "subscription_id.raw": "sub_basic" } },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});
