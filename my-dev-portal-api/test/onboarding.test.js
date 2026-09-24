const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createOnboarding } = require("../services/onboarding");

async function fixture(t, changes = {}) {
  const calls = [];
  const deps = {
    getSnApiPortalContext: async () => ({}),
    registerSnApiPortalAccount: async user => calls.push({ registered: user.sub }),
    invitationRequest: async (path, options) => { calls.push({ path, body: options?.body }); return { enabled: true, required: !options }; },
    ...changes,
  };
  const onboarding = createOnboarding(deps);
  const app = express();
  const auth = (req, res, next) => { req.user = { sub: "auth0|actual", email: "actual@example.com", email_verified: true }; next(); };
  onboarding.install(app, auth, express.json());
  for (const path of ["/wallet/purchases", "/api-keys", "/api-keys/1/resume", "/invitations/accept", "/register/stripe/cs_test", "/api-keys/1/pause"]) {
    app.post(path, auth, onboarding.requireTerms, (_req, res) => res.json({ success: true }));
  }
  app.delete("/api-keys/1", auth, onboarding.requireTerms, (_req, res) => res.json({ success: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, request: (path, body, method = "POST") => fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }) };
}

test("onboarding registers a missing account before returning terms", async t => {
  let attempts = 0;
  const { calls, request } = await fixture(t, { invitationRequest: async () => {
    if (++attempts === 1) throw { status: 404, code: "terms_account_not_found" };
    return { required: true, enabled: true };
  } });
  assert.equal((await request("/onboarding", undefined, "GET")).status, 200);
  assert.equal(calls[0].registered, "auth0|actual");
});

test("terms gate blocks direct protected requests but preserves payment and security recovery", async t => {
  const { request } = await fixture(t);
  for (const path of ["/wallet/purchases", "/api-keys", "/api-keys/1/resume", "/invitations/accept"]) {
    const result = await request(path);
    assert.equal(result.status, 403);
    assert.equal((await result.json()).code, "terms_acceptance_required");
  }
  for (const path of ["/register/stripe/cs_test", "/api-keys/1/pause"]) assert.equal((await request(path)).status, 200);
  assert.equal((await request("/api-keys/1", undefined, "DELETE")).status, 200);
});

test("acceptance identity comes from verified token, never request fields", async t => {
  const { calls, request } = await fixture(t);
  assert.equal((await request("/onboarding/accept", { agreed: false })).status, 422);
  assert.equal((await request("/onboarding/accept", { agreed: true, version: "v1", sha256: "a".repeat(64), auth0_user_id: "attacker", email: "attacker@example.com", email_verified: false })).status, 200);
  assert.deepEqual(calls.at(-1).body, { agreed: true, version: "v1", sha256: "a".repeat(64), auth0_user_id: "auth0|actual", email: "actual@example.com", email_verified: true });
});

test("backend loss fails closed without leaking sensitive errors", async t => {
  const { request } = await fixture(t, { invitationRequest: async () => { throw new Error("secret connection string"); } });
  const result = await request("/api-keys");
  assert.equal(result.status, 503);
  assert.ok(!(await result.text()).includes("secret"));
});

test("a malformed success cannot open access or repeatedly create users", async t => {
  const { calls, request } = await fixture(t, { invitationRequest: async () => ({}) });
  assert.equal((await request("/wallet/purchases")).status, 503);
  assert.equal(calls.filter(call => call.registered).length, 0);
});
