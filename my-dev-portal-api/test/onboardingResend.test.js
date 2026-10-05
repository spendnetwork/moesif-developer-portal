const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createOnboarding } = require("../services/onboarding");
const mgmt = require("../services/auth0Management");

function appWith(user) {
  const onboarding = createOnboarding({
    getSnApiPortalContext: async () => ({}),
    registerSnApiPortalAccount: async () => {},
    invitationRequest: async (_p, options) => ({ enabled: true, required: !options }),
  });
  const app = express();
  const auth = (req, _res, next) => { req.user = user; next(); };
  onboarding.install(app, auth, express.json());
  return app;
}

async function post(app, path) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally { server.close(); }
}

test("resend route refuses when the email is already verified", async () => {
  const res = await post(appWith({ sub: "auth0|1", email: "a@b.com", email_verified: true }), "/onboarding/resend-verification");
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "already_verified");
});

test("resend route degrades to 503 when Management API is unconfigured", async () => {
  const saved = { id: process.env.AUTH0_MANAGEMENT_CLIENT_ID, secret: process.env.AUTH0_MANAGEMENT_CLIENT_SECRET };
  delete process.env.AUTH0_MANAGEMENT_CLIENT_ID; delete process.env.AUTH0_MANAGEMENT_CLIENT_SECRET;
  mgmt.__resetTokenCache();
  try {
    const res = await post(appWith({ sub: "auth0|1", email: "a@b.com", email_verified: false }), "/onboarding/resend-verification");
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "verification_resend_unconfigured");
  } finally {
    if (saved.id !== undefined) process.env.AUTH0_MANAGEMENT_CLIENT_ID = saved.id;
    if (saved.secret !== undefined) process.env.AUTH0_MANAGEMENT_CLIENT_SECRET = saved.secret;
  }
});
