const test = require("node:test");
const assert = require("node:assert/strict");
const { accountSlack } = require("../services/customerNotificationDelivery");
const { adminAction } = require("../services/slackNotification");
const env = { NODE_ENV: "production", ADMIN_PORTAL_BASE_URL: "https://admin.example.com" };

test("all account Slack messages share structured headings, identity fields and the admin button", () => {
  const payload = { name: "Alex", plan_key: "growth", funding: "paid", threshold: 90,
    amount_gbp_pence: 5000, available_gbp_pence: 8000, remaining_gbp_pence: 500,
    granted_gbp_pence: 5000, used_gbp_pence: 4500, utilisation_percent: 90,
    expires_at: "2027-01-01", credit_expires_at: "2027-01-01", notification_kind: "welcome", action: "paused" };
  for (const kind of ["welcome", "payment_confirmed", "access_paused", "access_restored", "development_granted",
    "credit_low", "credit_exhausted", "credit_expiring", "credit_expired", "pricing_expiring", "pricing_expired",
    "payment_failed", "api_key_changed", "purchase_requested", "delivery_failed"]) {
    const result = accountSlack({ kind, company: "<!channel>", organization_id: 37, payload }, "https://portal.example.com", env);
    assert.equal(result.blocks[0].type, "header", kind);
    assert.equal(result.blocks[1].type, "context", kind);
    assert.equal(result.blocks.at(-1).elements[0].url, "https://admin.example.com/customers/37", kind);
    assert.match(JSON.stringify(result.blocks[2].fields), /&lt;!channel&gt;/);
    assert.doesNotMatch(result.text, /<!channel>/);
    assert.ok(result.blocks.filter(block => block.fields).every(block => block.fields.length <= 10));
  }
});

test("admin links are trusted configuration, not customer-supplied URLs", () => {
  for (const url of ["javascript:alert(1)", "https://user:secret@example.com", "https://example.com?token=secret", "http://admin.example.com"]) {
    assert.throws(() => adminAction(37, { ...env, ADMIN_PORTAL_BASE_URL: url }), /InvalidAdminPortalUrl/);
  }
  assert.equal(adminAction(37, {}), null);
});

test("local admin links and pending invitations have explicit destinations", () => {
  assert.equal(adminAction(37, { NODE_ENV: "development", ADMIN_PORTAL_BASE_URL: "http://127.0.0.1:5173" }).elements[0].url,
    "http://127.0.0.1:5173/customers/37");
  assert.equal(adminAction(null, env).elements[0].url, "https://admin.example.com/customers/invitations");
});
