const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyEvents, createSendgridEventHandler } = require("../services/sendgridEvents");
const { createCustomerNotificationWorker, renderJob } = require("../services/customerNotificationDelivery");
const { renderEmail } = require("../services/notificationEmail");
const { installNotificationRoutes } = require("../services/notificationRoutes");

test("worker distinguishes missing routes and auth failures without leaking upstream details", async (t) => {
  const logs = [];
  t.mock.method(console, "warn", value => logs.push(JSON.parse(value)));
  for (const [status, code] of [[404, "notification_api_route_missing"], [401, "notification_api_unauthorized"], [403, "notification_api_forbidden"], [503, "delivery_service_unavailable"]]) {
    logs.length = 0;
    const fail = async () => { throw Object.assign(new Error("private-token customer@example.com"), { status, code: "private_token", detail: "private upstream body" }); };
    await createCustomerNotificationWorker({ service: { settings: () => ({}), scan: fail, claim: fail } }).tick();
    assert.deepEqual(logs, [
      { event: "notification_scan_delayed", phase: "scan", status, code },
      { event: "customer_notification_worker_delayed", phase: "claim", status, code },
    ]);
    assert.doesNotMatch(JSON.stringify(logs), /private|customer@example/);
  }
});

test("verified SendGrid reports forward only permitted fields; API outage is retriable", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const env = { SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const events = [{ event: "delivered", delivery_id: "welcome:1", email: "test@example.com", timestamp: 1789999999, secret: "not forwarded" },
    { event: "open", delivery_id: "welcome:1", email: "test@example.com" }];
  const body = Buffer.from(JSON.stringify(events)), timestamp = "1789999999";
  const signature = crypto.sign("sha256", Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString("base64");
  const req = { body, headers: { "x-twilio-email-event-webhook-signature": signature, "x-twilio-email-event-webhook-timestamp": timestamp } };
  const res = { status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
  const calls = [];
  await createSendgridEventHandler({ env, request: async (...args) => calls.push(args) })(req, res);
  assert.equal(res.code, 200);
  assert.deepEqual(calls[0][1].body.events, [{ event: "delivered", delivery_id: "welcome:1", email: "test@example.com", timestamp: 1789999999 }]);
  await createSendgridEventHandler({ env, request: async () => { throw new Error("unavailable"); } })(req, res);
  assert.equal(res.code, 503);
});

test("inbox routes authenticate and never trust a supplied account identity", async () => {
  const routes = [], calls = [];
  const auth = [() => {}, () => {}];
  const app = { get: (...args) => routes.push(args), post: (...args) => routes.push(args) };
  installNotificationRoutes(app, { auth, origin: "https://portal.example.com", request: async (...args) => { calls.push(args); return []; } });
  for (const route of routes) {
    assert.deepEqual(route.slice(1, 3), auth);
    const req = { user: { sub: "google-oauth2|trusted" }, query: { auth0_user_id: "attacker" },
      body: { auth0_user_id: "attacker" }, params: { id: "credit:1" } };
    const res = { json() {}, status() { return this; } };
    await route.at(-1)(req, res);
    assert.match(calls.at(-1)[0], /auth0_user_id=google-oauth2%7Ctrusted$/);
    assert.doesNotMatch(calls.at(-1)[0], /attacker/);
  }
});

test("inbox authorization failure exposes neither upstream response nor customer data", async () => {
  const routes = [];
  installNotificationRoutes({ get: (...args) => routes.push(args), post() {} }, { auth: [], origin: "https://portal.example.com",
    request: async () => { throw Object.assign(new Error("private upstream details"), { status: 403 }); } });
  const res = { status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
  await routes[0].at(-1)({ user: { sub: "member" } }, res);
  assert.equal(res.code, 403);
  assert.doesNotMatch(JSON.stringify(res.body), /private upstream/);
});

test("SendGrid signature covers timestamp and raw bytes; forged or changed bodies fail", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const raw = Buffer.from('[{"email":"test@example.com"}]');
  const timestamp = "1789999999";
  const signature = crypto.sign("sha256", Buffer.concat([Buffer.from(timestamp), raw]), privateKey).toString("base64");
  assert.equal(verifyEvents(raw, signature, timestamp, key), true);
  assert.equal(verifyEvents(Buffer.concat([raw, Buffer.from(" ")]), signature, timestamp, key), false);
  assert.equal(verifyEvents(raw, signature, "1790000000", key), false);
  assert.equal(verifyEvents(raw, signature, timestamp, "wrong"), false);
});

test("unverified feedback never reaches SN API", async () => {
  let calls = 0;
  const handler = createSendgridEventHandler({ env: { SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: "invalid" }, request: async () => calls++ });
  const res = { status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
  await handler({ body: Buffer.from("[]"), headers: {} }, res);
  assert.equal(res.code, 401);
  assert.equal(calls, 0);
});

test("new templates escape names and clearly distinguish grants, expiry and payments", () => {
  const payload = { amount_gbp_pence: 5000, remaining_gbp_pence: 1000, threshold: 80,
    funding: "development", expires_at: "2027-01-01T00:00:00Z", plan_key: "growth", action: "paused" };
  for (const kind of ["development_granted", "credit_low", "credit_exhausted", "credit_expiring", "credit_expired",
    "pricing_expiring", "pricing_expired", "payment_failed", "api_key_changed", "purchase_requested"]) {
    const rendered = renderEmail(kind, renderJob({ kind, company: "<script>bad</script>", payload }, "https://portal.example.com"));
    assert.ok(rendered.subject);
    assert.doesNotMatch(rendered.html, /<script>/);
    assert.doesNotMatch(rendered.text, /GBP 100|Add credit from £100/);
  }
});

test("a scan outage does not prevent existing jobs from being delivered", async () => {
  let sent = 0, claimed = 0;
  const service = { settings: () => ({ origin: "https://portal.example.com" }), scan: async () => { throw new Error("offline"); },
    claim: async () => claimed++ ? null : { id: "welcome:1", kind: "welcome", recipients: ["owner@example.com"], payload: {} },
    finish: async () => {} };
  await createCustomerNotificationWorker({ service, email: { send: async () => { sent++; return "accepted"; } } }).tick();
  assert.equal(sent, 1);
});

test("Slack messages use plain text without mentions and retry on a provider outage", async () => {
  let claimed = 0;
  const results = [], requests = [];
  const service = { settings: () => ({ origin: "https://portal.example.com" }),
    claim: async () => claimed++ ? null : { id: "slack:welcome:1", channel: "slack", kind: "welcome", organization_id: 1,
      company: "<!channel>", payload: {} }, finish: async (_, result) => results.push(result) };
  await createCustomerNotificationWorker({ service, env: { NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test" },
    fetchImpl: async (_, options) => { requests.push(options); return { ok: false, text: async () => "failure" }; } }).tick();
  assert.equal(JSON.parse(requests[0].body).blocks[0].text.type, "plain_text");
  assert.equal(requests[0].redirect, "error");
  assert.deepEqual(results, [{ result: "retry", failure_code: "SlackDeliveryFailed" }]);
});
