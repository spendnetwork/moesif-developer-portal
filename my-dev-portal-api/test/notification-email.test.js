const test = require("node:test");
const assert = require("node:assert/strict");
const { createNotificationEmail, emailSettings, renderEmail } = require("../services/notificationEmail");
const env = { SENDGRID_API_KEY: "SG.synthetic.test", EMAIL_FROM: "welcome@example.com", EMAIL_FROM_NAME: "Open Opportunities" };
const data = { name: '<script>"Hello"</script>', company: "A&B", creditAmount: "50.00", validityDays: "30",
  invitationUrl: "https://portal.example.com/signup#invitation=synthetic", portalUrl: "https://portal.example.com/dashboard",
  invitationExpiresAt: "1 January 2030 UTC", creditExpiresAt: "31 January 2030 UTC" };
function setup(response = [{ statusCode: 202, headers: { "x-message-id": "message-123" } }]) {
  const calls = [];
  const client = { setApiKey: key => assert.equal(key, env.SENDGRID_API_KEY), setTimeout: ms => assert.equal(ms, 15000),
    client: { setDefaultRequest: (key, value) => assert.deepEqual([key, value], ["maxRedirects", 0]) },
    send: async body => { calls.push(body); if (response instanceof Error) throw response; return response; } };
  return { calls, email: createNotificationEmail({ env, client }) };
}
test("local templates escape HTML once, retain plain text, and do not evaluate recipient content", () => {
  for (const kind of ["invite", "accepted_email"]) {
    const rendered = renderEmail(kind, { ...data, company: "A&B {{creditAmount}}" });
    assert.ok(rendered.html.includes("&lt;script&gt;"));
    assert.ok(!rendered.html.includes("<script>"));
    assert.ok(rendered.html.includes("A&amp;B {{creditAmount}}"));
    assert.ok(rendered.text.includes(data.name));
    assert.ok(!rendered.text.includes("&lt;"));
  }
  assert.throws(() => renderEmail("invite", {}), { code: "EmailTemplateInvalid" });
  assert.throws(() => renderEmail("unknown", data), { code: "UnknownEmailTemplate" });
});
test("SendGrid sends local HTML/text with tracking off and returns only accepted message ID", async () => {
  const { calls, email } = setup();
  assert.equal(await email.send({ kind: "invite", to: "recipient@example.com", data, deliveryId: "job-1" }), "message-123");
  const body = calls[0];
  assert.deepEqual(body.from, { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME });
  assert.equal(body.to, "recipient@example.com");
  assert.equal(body.templateId, undefined);
  assert.equal(body.mailSettings, undefined);
  assert.ok(body.html.includes("#invitation"));
  assert.deepEqual(body.trackingSettings.clickTracking, { enable: false, enableText: false });
  assert.equal(body.trackingSettings.openTracking.enable, false);
  assert.deepEqual(body.customArgs, { notification: "invite", delivery_id: "job-1" });
});
test("200 validation and missing receipt cannot masquerade as a submitted live email", async () => {
  for (const response of [[{ statusCode: 200 }], [{ statusCode: 202, headers: {} }]]) {
    await assert.rejects(setup(response).email.send({ kind: "invite", to: "a@example.com", data, deliveryId: "test" }), { code: "SendGridSubmissionUnconfirmed" });
  }
  const { calls, email } = setup([{ statusCode: 200 }]);
  assert.equal(await email.send({ kind: "invite", to: "a@example.com", data, deliveryId: "test" }, { sandbox: true }), null);
  assert.deepEqual(calls[0].mailSettings, { sandboxMode: { enable: true } });
});
test("provider failures are classified without leaking credentials, recipients or response bodies", async () => {
  for (const [status, code, permanent] of [[400, "SendGridRequestRejected", true], [401, "SendGridAuthenticationFailed", true],
    [403, "SendGridSenderOrPermissionDenied", true], [429, "SendGridRateLimited", false], [503, "SendGridUnavailable", false],
    ["ETIMEDOUT", "SendGridSubmissionUnconfirmed", false]]) {
    const error = Object.assign(new Error("private key and recipient"), { code: status, response: { body: { errors: [env.SENDGRID_API_KEY] } } });
    const { email } = setup(error);
    await assert.rejects(email.send({ kind: "invite", to: "a@example.com", data, deliveryId: "test" }), failure => {
      assert.equal(failure.code, code); assert.equal(failure.permanent, permanent);
      assert.ok(!JSON.stringify(failure).includes(env.SENDGRID_API_KEY));
      assert.ok(!failure.message.includes("private")); return true;
    });
  }
});
test("missing secrets or header injection fail before constructing a send request", () => {
  for (const change of [{ SENDGRID_API_KEY: "" }, { EMAIL_FROM: "bad\r\n@example.com" }, { EMAIL_FROM_NAME: "bad\r\nBcc:test" }]) {
    assert.throws(() => emailSettings({ ...env, ...change }), { code: "SendGridNotConfigured" });
  }
});
