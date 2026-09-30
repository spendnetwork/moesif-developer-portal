const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createInvitations } = require("../services/invitations");
const { createDeliveryWorker } = require("../services/invitationDelivery");
const env = { INVITATIONS_ENABLED: "true", INVITATION_SIGNING_SECRET: "a".repeat(40), INVITATION_PORTAL_URL: "https://portal.example.com",
  SENDGRID_API_KEY: "SG.synthetic.test", EMAIL_FROM: "welcome@example.com", INVITATION_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test" };
const user = { sub: "auth0|test", email: "alex@example.com", email_verified: true };

test("signed invitation links are stable, fragment-only, and tamper resistant", async () => {
  const calls = [];
  const service = createInvitations({ env, request: async (...args) => { calls.push(args); return {}; } });
  const id = crypto.randomUUID();
  const token = service.token(id);
  assert.equal(service.token(id), token);
  assert.equal(new URL(service.link(id)).search, "");
  assert.ok(new URL(service.link(id)).hash.includes(token));
  await service.receive(user, token, "accept");
  assert.equal(calls[0][1].body.email, user.email);
  assert.equal(calls[0][1].body.auth0_user_id, user.sub);
  assert.ok(!JSON.stringify(calls).includes(token));
  await assert.rejects(() => service.receive(user, token.slice(0, -1) + (token.endsWith("x") ? "y" : "x"), "accept"));
  await assert.rejects(() => service.receive({ ...user, email_verified: false }, token, "accept"), { code: "invitation_email_unverified" });
  assert.equal(calls.length, 1);
});

test("missing configuration and unsafe portal URLs reject invitation creation", () => {
  for (const update of [{ INVITATIONS_ENABLED: "false" }, { INVITATION_SIGNING_SECRET: "short" }, { INVITATION_PORTAL_URL: "http://public.example.com" }, { INVITATION_PORTAL_URL: "https://user:password@example.com" }]) {
    const service = createInvitations({ env: { ...env, ...update }, request: () => assert.fail("must not call API") });
    assert.throws(() => service.create({ requestId: crypto.randomUUID() }), { code: "invitations_not_configured" });
  }
});

test("SendGrid transient failure retries the delivery only, without touching credit", async () => {
  const results = [];
  let claimed = false;
  const job = { id: "job", lease_id: "lease", kind: "invite", invitation: { id: "invite", email: "alex@example.com", full_name: "<script>", company_name: "A&B", amount_gbp_pence: 5000, validity_days: 30, expires_at: "2030-01-01T00:00:00Z" } };
  const sent = [];
  const service = { settings: () => ({ origin: "https://portal.example.com" }), link: () => "https://portal.example.com/signup#invitation=safe",
    claim: async () => { if (claimed) return null; claimed = true; return job; }, finish: async (_, result) => results.push(result) };
  const worker = createDeliveryWorker({ env, service,
    email: { send: async command => { sent.push(command); throw Object.assign(new Error("private provider diagnostic"), { name: "SendGridUnavailable" }); } } });
  await worker.tick();
  assert.equal(results[0].result, "retry");
  assert.equal(results[0].failure_code, "SendGridUnavailable");
  const data = sent[0].data;
  // HTML escaping belongs to the renderer; plain text keeps the original text.
  assert.equal(data.name, "<script>");
  assert.equal(data.company, "A&B");
  assert.ok(!("internalNote" in data));
});

test("confirmed SendGrid submission is recorded and concurrent ticks do not duplicate work", async () => {
  let claimed = 0, deliveries = 0;
  const results = [];
  const service = { settings: () => ({ origin: "https://portal.example.com" }), claim: async () => claimed++ === 0 ? {
    id: "job", lease_id: "lease", kind: "accepted_email", invitation: { email: "alex@example.com", id: "invite", amount_gbp_pence: 5000, validity_days: 30, credit_receipt: { expires_at: "2030-01-01" } },
  } : null, finish: async (_, result) => results.push(result) };
  const worker = createDeliveryWorker({ env, service, email: { send: async () => { deliveries++; return "sendgrid-id"; } } });
  await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(deliveries, 1); assert.deepEqual(results, [{ result: "sent", message_id: "sendgrid-id" }]);
});

test("lost acknowledgement retries only the acknowledgement, not the email", async () => {
  let claims = 0, sends = 0, acknowledgements = 0;
  const service = { settings: () => ({ origin: "https://portal.example.com" }),
    claim: async () => claims++ === 0 ? { id: "job", kind: "accepted_email", invitation: {
      id: "invite", email: "alex@example.com", amount_gbp_pence: 5000, credit_receipt: { expires_at: "2030-01-01" },
    } } : null,
    finish: async () => { if (++acknowledgements === 1) throw Object.assign(new Error("timeout"), { status: 503 }); } };
  await createDeliveryWorker({ service, env, email: { send: async () => { sends++; return "sent"; } } }).tick();
  assert.equal(sends, 1); assert.equal(acknowledgements, 2);
});

test("Slack errors are safe and successful acceptance sends no new credit request", async () => {
  for (const success of [false, true]) {
    let claims = 0;
    const results = [];
    const service = { settings: () => ({}), claim: async () => claims++ === 0 ? {
      id: "job", kind: "accepted_slack", invitation: { id: "invite", full_name: "Alex", email: "alex@example.com", company_name: "Example", amount_gbp_pence: 5000, validity_days: 30 },
    } : null, finish: async (_, result) => results.push(result) };
    await createDeliveryWorker({ env, service, fetcher: async (_, options) => {
      assert.equal(options.redirect, "error"); assert.ok(options.signal);
      return { ok: success, text: async () => success ? "ok" : "private error" };
    } }).tick();
    assert.equal(results[0].result, success ? "sent" : "retry");
    if (!success) assert.equal(results[0].failure_code, "SlackDeliveryRejected");
  }
});

test("invalid origin and Slack configuration fail safely", () => {
  for (const update of [{ INVITATION_PORTAL_URL: "not a URL" }, { INVITATION_SLACK_WEBHOOK_URL: "https://example.com/secret" }]) {
    assert.throws(() => createInvitations({ env: { ...env, ...update } }).settings(), { code: "invitations_not_configured" });
  }
});

test("permanent mail rejection is marked failed and lost acknowledgement does not resend", async () => {
  let claims = 0, sends = 0, acknowledgements = 0;
  const results = [];
  const service = { settings: () => ({ origin: "https://portal.example.com" }),
    claim: async () => claims++ === 0 ? { id: "job", kind: "accepted_email", invitation: {
      id: "invite", email: "alex@example.com", amount_gbp_pence: 5000, credit_receipt: { expires_at: "2030-01-01" },
    } } : null,
    finish: async (_, result) => { results.push(result); if (++acknowledgements === 1) throw Object.assign(new Error("timeout"), { status: 503 }); } };
  await createDeliveryWorker({ service, env, email: { send: async () => {
    sends++; throw Object.assign(new Error("safe error"), { name: "SendGridSenderOrPermissionDenied", permanent: true });
  } } }).tick();
  assert.equal(sends, 1); assert.equal(acknowledgements, 2);
  assert.deepEqual(results[0], { result: "failed", failure_code: "SendGridSenderOrPermissionDenied" });
  assert.deepEqual(results[0], results[1]);
});

async function runTeamJob(job, overrides = {}) {
  let claims = 0;
  const results = [], sent = [];
  const service = { settings: () => ({ origin: "https://portal.example.com" }), link: () => "https://portal.example.com/signup#invitation=safe",
    claim: async () => claims++ === 0 ? job : null, finish: async (_, result) => results.push(result) };
  await createDeliveryWorker({ env, service, email: { send: async command => { sent.push(command); return "sendgrid-id"; } }, ...overrides }).tick();
  return { results, sent };
}
const teamInvite = { id: "invite", kind: "team_member", email: "tara@example.com", full_name: "Tara", company_name: "Acme",
  amount_gbp_pence: null, validity_days: null, expires_at: "2030-01-01T00:00:00Z", credit_receipt: null };

test("a team invitation uses the teammate template and never mentions credit", async () => {
  const { results, sent } = await runTeamJob({ id: "job", lease_id: "lease", kind: "invite", invitation: teamInvite });
  assert.deepEqual(results, [{ result: "sent", message_id: "sendgrid-id" }]);
  assert.equal(sent[0].kind, "team_invite");
  assert.equal(sent[0].to, "tara@example.com");
  assert.equal(sent[0].data.company, "Acme");
  assert.ok(!("creditAmount" in sent[0].data));
});

test("a teammate joining emails the org admins, not the new member", async () => {
  const { results, sent } = await runTeamJob({ id: "job", lease_id: "lease", kind: "accepted_email", invitation: teamInvite,
    recipients: ["owner@example.com", "second-admin@example.com"] });
  assert.deepEqual(results, [{ result: "sent", message_id: "sendgrid-id" }]);
  assert.equal(sent[0].kind, "team_joined");
  assert.deepEqual(sent[0].to, ["owner@example.com", "second-admin@example.com"]);
  assert.equal(sent[0].data.memberEmail, "tara@example.com");
  assert.equal(sent[0].data.teamUrl, "https://portal.example.com/settings");
});

test("a teammate-joined job without admin recipients fails permanently instead of retrying", async () => {
  const { results, sent } = await runTeamJob({ id: "job", lease_id: "lease", kind: "accepted_email", invitation: teamInvite });
  assert.equal(sent.length, 0);
  assert.deepEqual(results, [{ result: "failed", failure_code: "NoAdminRecipients" }]);
});

test("the Slack alert for a teammate says no credit was granted", async () => {
  let body;
  const { results } = await runTeamJob({ id: "job", lease_id: "lease", kind: "accepted_slack", invitation: teamInvite }, {
    fetcher: async (_, options) => { body = JSON.parse(options.body); return { ok: true, text: async () => "ok" }; } });
  assert.equal(results[0].result, "sent");
  assert.equal(body.blocks[0].text.text, "Teammate joined");
  const text = JSON.stringify(body.blocks);
  assert.ok(text.includes("no credit granted"));
  assert.ok(!text.includes("NaN") && !text.includes("null"));
});

test("an admin's cancel request carries their own identity and rejects malformed ids", async () => {
  const calls = [];
  const service = createInvitations({ env, request: async (...args) => { calls.push(args); return { status: "revoked" }; } });
  const id = crypto.randomUUID(), requestId = crypto.randomUUID();
  assert.deepEqual(await service.revokeTeamInvitation(user, id, requestId), { status: "revoked" });
  assert.deepEqual(calls[0], [`/api/v3/developer-portal/team-invitations/${id}/revoke`,
    { method: "POST", body: { request_id: requestId, auth0_user_id: user.sub } }]);
  assert.throws(() => service.revokeTeamInvitation(user, "../admin", requestId), { code: "invalid_invitation_id" });
  assert.throws(() => service.revokeTeamInvitation(user, id, "not-a-uuid"), { code: "invalid_invitation_id" });
  assert.equal(calls.length, 1);
});
