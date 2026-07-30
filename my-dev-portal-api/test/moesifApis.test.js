const test = require("node:test");
const assert = require("node:assert/strict");

process.env.MOESIF_APPLICATION_ID ||= "00000000000000000000000000000000";
process.env.MOESIF_MANAGEMENT_TOKEN ||= "test-token";

const { readMoesifResponse } = require("../services/moesifApis");

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
