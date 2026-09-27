const test = require("node:test");
const assert = require("node:assert/strict");
const { creditUtilisationSlack } = require("../services/creditUtilisationSlack");
const { createCustomerNotificationWorker, renderJob } = require("../services/customerNotificationDelivery");

const job = { kind: "credit_low", channel: "slack", organization_id: 35, company: "Example Ltd",
  stripe_customer_id: "cus_test", moesif_company_id: "35",
  payload: { funding: "paid", plan_key: "basic", threshold: 90, granted_gbp_pence: 5000,
    remaining_gbp_pence: 16, used_gbp_pence: 4984, utilisation_percent: 99.68, request_rejected_at: "2026-09-27T00:00:00Z" } };

test("all tiers and both funding pools use the same structured layout", () => {
  for (const plan_key of ["basic", "growth", "enterprise", "test", "development"]) {
    for (const funding of ["paid", "development"]) {
      const result = creditUtilisationSlack({ ...job, payload: { ...job.payload, plan_key, funding } });
      assert.equal(result.blocks[0].text.text, "API credit utilisation: 90%");
      assert.equal(result.blocks[2].fields.length, 9);
      assert.match(result.blocks[2].fields[2].text, funding === "paid" ? /Purchased credit/ : /Development credit/);
      assert.match(JSON.stringify(result), /99.68% used/);
      assert.match(JSON.stringify(result), /balance is not zero/);
      assert.doesNotMatch(JSON.stringify(result), /100%/);
    }
  }
});

test("zero balance is critical but never claims every funding pool is empty", () => {
  const result = creditUtilisationSlack({ ...job, kind: "credit_exhausted", payload: {
    ...job.payload, threshold: 100, utilisation_percent: 100, remaining_gbp_pence: 0, used_gbp_pence: 5000 } });
  assert.match(JSON.stringify(result), /Critical/);
  assert.match(JSON.stringify(result), /Other eligible credit may still be available/);
  assert.doesNotMatch(JSON.stringify(result), /balance is not zero/);
});

test("customer names cannot inject Slack mentions and missing amounts are not zero", () => {
  const result = creditUtilisationSlack({ ...job, company: "<!channel> & <@U123>",
    payload: { ...job.payload, granted_gbp_pence: undefined } });
  assert.doesNotMatch(JSON.stringify(result), /<!channel>|<@U123>/);
  assert.match(result.blocks[2].fields[2].text, /Not available/);
  assert.equal(result.blocks[2].fields[0].verbatim, true);
});

test("worker sends the structured payload, not the old customer paragraph", async () => {
  let claimed = false, body;
  const worker = createCustomerNotificationWorker({ service: {
    settings: () => ({ origin: "https://portal.example.com" }),
    claim: async () => { if (claimed) return null; claimed = true; return job; },
    finish: async (_, result) => assert.equal(result.result, "sent"),
  }, env: { NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test" },
  fetchImpl: async (_, options) => { body = JSON.parse(options.body); return { ok: true, text: async () => "ok" }; } });
  await worker.tick();
  assert.equal(body.blocks[0].type, "header");
  assert.doesNotMatch(JSON.stringify(body), /purchase credit from/);
  assert.doesNotMatch(renderJob(job, "https://portal.example.com").message, /or this balance/);
});
