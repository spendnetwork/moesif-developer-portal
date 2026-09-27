const test = require("node:test");
const assert = require("node:assert/strict");
const { renderEmail, createNotificationEmail } = require("../services/notificationEmail");
const { renderJob, createCustomerNotificationWorker } = require("../services/customerNotificationDelivery");

function job(threshold, funding) {
  return { id: `credit:35:${funding}:1:${threshold}`, kind: threshold === 100 ? "credit_exhausted" : "credit_low",
    channel: "email", company: "Example & Co", recipients: ["owner@example.com"],
    payload: { threshold, funding, remaining_gbp_pence: 5000 - threshold * 50,
      granted_gbp_pence: 5000, used_gbp_pence: threshold * 50, utilisation_percent: threshold } };
}

test("every threshold and both credit types render customer-specific HTML and plain text", () => {
  for (const funding of ["development", "paid"]) {
    for (const threshold of [50, 75, 80, 90, 100]) {
      const current = job(threshold, funding);
      const rendered = renderEmail(current.kind, renderJob(current, "https://portal.example.com"));
      assert.match(rendered.text, new RegExp(`Alert threshold: ${threshold}%`));
      assert.match(rendered.text, /Credit granted: £50.00/);
      assert.match(rendered.text, /https:\/\/portal.example.com\/billing/);
      assert.match(rendered.html, /Example &amp; Co/);
      assert.match(rendered.html, threshold === 100 ? /#b43c3c/ : /#ba831b/);
      assert.match(rendered.text, /not your combined balance/);
      assert.doesNotMatch(rendered.text, /Stripe customer|Moesif company|API access is blocked/);
      assert.match(rendered.text, funding === "development" ? /valid purchased credit/ : /valid development credit/);
    }
  }
});

test("the worker submits threshold emails through SendGrid and acknowledges its receipt", async () => {
  let claimed = false;
  const submitted = [], acknowledgements = [];
  const current = job(75, "development");
  const client = { setApiKey() {}, setTimeout() {}, send: async value => {
    submitted.push(value); return [{ statusCode: 202, headers: { "x-message-id": "test-receipt" } }];
  } };
  const email = createNotificationEmail({ client, env: { SENDGRID_API_KEY: "SG.test.synthetic", EMAIL_FROM: "welcome@openopps.com" } });
  await createCustomerNotificationWorker({ email, service: {
    settings: () => ({ origin: "https://portal.example.com" }),
    claim: async () => { if (claimed) return null; claimed = true; return current; },
    finish: async (_, result) => acknowledgements.push(result),
  } }).tick();
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].to, ["owner@example.com"]);
  assert.equal(submitted[0].isMultiple, true);
  assert.match(submitted[0].subject, /75% development/);
  assert.deepEqual(acknowledgements, [{ result: "sent", message_id: "test-receipt" }]);
});

test("missing old snapshot fields are unavailable rather than invented; names are escaped", () => {
  const current = job(50, "paid");
  current.company = '<script>alert("x")</script>\r\nExtra';
  delete current.payload.granted_gbp_pence;
  delete current.payload.used_gbp_pence;
  delete current.payload.utilisation_percent;
  const rendered = renderEmail(current.kind, renderJob(current, "https://portal.example.com"));
  assert.match(rendered.text, /Credit granted: Not available/);
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.doesNotMatch(rendered.subject, /[\r\n]/);
});
