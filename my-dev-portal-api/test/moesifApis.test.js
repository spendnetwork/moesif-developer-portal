const test = require("node:test");
const assert = require("node:assert/strict");

process.env.MOESIF_APPLICATION_ID ||= "00000000000000000000000000000000";
process.env.MOESIF_MANAGEMENT_TOKEN ||= "test-token";

const {
  eventCountValue,
  latestEndingBalance,
  normalizedBalance,
  readMoesifResponse,
} = require("../services/moesifApis");

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
    readMoesifResponse(response, "Moesif event count lookup"),
    (error) => error.code === "moesif_event_scope_missing"
  );
});

test("event-count authorization failures are classified even without scope detail", async () => {
  const response = new Response(
    JSON.stringify({ moesif_error: { message: "Unauthorized" } }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );

  await assert.rejects(
    readMoesifResponse(response, "Moesif event count lookup"),
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

test("event count parser supports Moesif total-hit responses", () => {
  assert.equal(eventCountValue({ hits: { total: { value: 42 } } }), 42);
  assert.equal(eventCountValue({ count: 11 }), 11);
});
