const test = require("node:test");
const assert = require("node:assert/strict");
const { checkNotifications } = require("../scripts/check-notifications");
const env = { INVITATIONS_ENABLED: "true", INVITATION_SIGNING_SECRET: "x".repeat(40),
  INVITATION_PORTAL_URL: "https://portal.example.com", INVITATION_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test",
  SENDGRID_API_KEY: "SG.synthetic.test", EMAIL_FROM: "welcome@example.com" };
test("preflight renders both local templates without network calls or SES settings", async () => {
  const reports = [];
  await checkNotifications({ env, report: text => reports.push(text), email: { send: () => assert.fail("must not send") } });
  assert.equal(reports.filter(line => line.includes("template renders")).length, 2);
  assert.ok(!JSON.stringify(reports).includes(env.SENDGRID_API_KEY));
});
test("optional provider preflight always enables sandbox with synthetic recipient and links", async () => {
  const calls = [];
  await checkNotifications({ env, sandbox: true, report: () => {}, email: { send: async (...args) => calls.push(args) } });
  assert.equal(calls.length, 2);
  for (const [body, options] of calls) {
    assert.deepEqual(options, { sandbox: true });
    assert.equal(body.to, "notification-check@example.com");
    assert.equal(new URL(body.data.invitationUrl).hostname, "example.com");
  }
});
test("preflight stops on missing SendGrid configuration", async () => {
  await assert.rejects(checkNotifications({ env: { ...env, SENDGRID_API_KEY: "" }, report: () => {} }), { code: "invitations_not_configured" });
});
