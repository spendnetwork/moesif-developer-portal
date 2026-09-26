const test = require("node:test");
const assert = require("node:assert/strict");
const { createCustomerNotificationWorker, notificationService } = require("../services/customerNotificationDelivery");
const { renderEmail } = require("../services/notificationEmail");

const origin = "https://portal.example.com";
const admins = ["owner@example.com", "second@example.com"];

async function run(job, send = async () => "sendgrid-id") {
  let claims = 0;
  const results = [], sent = [];
  const service = { settings: () => ({ origin }), claim: async () => claims++ === 0 ? job : null, finish: async (_, result) => results.push(result) };
  await createCustomerNotificationWorker({ service, email: { send: async command => { sent.push(command); return send(command); } } }).tick();
  return { results, sent, rendered: sent[0] && renderEmail(sent[0].kind, sent[0].data) };
}

test("the self-service welcome goes to the admins and never promises credit", async () => {
  const { results, sent, rendered } = await run({ id: "welcome:1", lease_id: "l", kind: "welcome", recipients: admins,
    company: "Acme", payload: { name: "Sam" } });
  assert.deepEqual(results, [{ result: "sent", message_id: "sendgrid-id" }]);
  assert.deepEqual(sent[0].to, admins);
  assert.equal(rendered.subject, "Welcome to Open Opportunities");
  assert.ok(rendered.text.includes(`${origin}/plans`));
  assert.ok(!/development credit|free credit|£/i.test(rendered.text));
});

test("a confirmed payment shows the amount, the new balance, expiry and any pricing change", async () => {
  const payload = { amount_gbp_pence: 500000, available_gbp_pence: 512345, credit_expires_at: "2027-09-26T10:00:00+00:00",
    renewal: false, pricing_applied: true, plan_key: "growth", pricing_ends_at: "2027-09-26T10:00:00+00:00" };
  const { rendered } = await run({ id: "payment_confirmed:x", lease_id: "l", kind: "payment_confirmed", recipients: admins, company: "Acme", payload });
  assert.equal(rendered.subject, "Payment confirmed: £5,000.00 added to Acme");
  assert.ok(rendered.text.includes("Credit available now: £5,123.45"));
  assert.ok(rendered.text.includes("Paid credit expires: 26 September 2027"));
  assert.ok(rendered.text.includes("Growth pricing is active until 26 September 2027."));
  const renewal = await run({ id: "payment_confirmed:y", lease_id: "l", kind: "payment_confirmed", recipients: admins, company: "Acme",
    payload: { ...payload, renewal: true, pricing_applied: false } });
  assert.ok(renewal.rendered.subject.startsWith("Renewal payment confirmed"));
  assert.ok(!renewal.rendered.text.includes("pricing is active"));
});

test("paused access explains itself without revealing the staff reason, and restored access says so", async () => {
  const staff = await run({ id: "access_paused:1:a", lease_id: "l", kind: "access_paused", recipients: admins, company: "Acme", payload: { reason: "staff" } });
  assert.ok(staff.rendered.text.includes("Our team has paused API access for Acme"));
  const review = await run({ id: "access_paused:1:b", lease_id: "l", kind: "access_paused", recipients: admins, company: "Acme", payload: { reason: "payment_review" } });
  assert.ok(review.rendered.text.includes("please don't pay again"));
  const restored = await run({ id: "access_restored:1:c", lease_id: "l", kind: "access_restored", recipients: admins, company: "Acme", payload: {} });
  assert.match(restored.rendered.subject, /staff pause.*removed/);
  assert.match(restored.rendered.text, /sufficient valid credit, accepted terms and an active API key/);
  assert.doesNotMatch(restored.rendered.text, /keys work as before/);
});

test("undeliverable jobs fail permanently while provider outages retry", async () => {
  assert.deepEqual((await run({ id: "a", lease_id: "l", kind: "welcome", recipients: [], company: "Acme", payload: {} })).results,
    [{ result: "failed", failure_code: "NoAdminRecipients" }]);
  assert.deepEqual((await run({ id: "b", lease_id: "l", kind: "mystery", recipients: admins, payload: {} })).results,
    [{ result: "failed", failure_code: "UnknownNotificationKind" }]);
  assert.deepEqual((await run({ id: "c", lease_id: "l", kind: "payment_confirmed", recipients: admins, company: "Acme", payload: {} })).results,
    [{ result: "failed", failure_code: "InvalidNotificationAmount" }]);
  const outage = await run({ id: "d", lease_id: "l", kind: "access_restored", recipients: admins, company: "Acme", payload: {} },
    async () => { throw Object.assign(new Error("private"), { name: "SendGridUnavailable" }); });
  assert.deepEqual(outage.results, [{ result: "retry", failure_code: "SendGridUnavailable" }]);
});

test("the service talks to sn-api's notification delivery endpoints with the lease", async () => {
  const calls = [];
  const service = notificationService({ settings: () => ({ origin }) }, async (path, options) => { calls.push([path, options]); return null; });
  await service.claim();
  await service.finish({ id: "payment_confirmed:x", lease_id: "lease-1" }, { result: "sent", message_id: "m" });
  assert.deepEqual(calls[0], ["/api/v3/developer-portal/notification-deliveries/claim", { method: "POST" }]);
  assert.deepEqual(calls[1], ["/api/v3/developer-portal/notification-deliveries/payment_confirmed%3Ax/result",
    { method: "POST", body: { lease_id: "lease-1", result: "sent", message_id: "m" } }]);
});
