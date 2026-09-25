const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { shouldSkipMoesifEvent, maskMoesifEvent } = require("../services/moesifPrivacy");

const RAW_KEY = "oo_test_abcde_0123456789secret";

function keyEvent(uri) {
  return {
    request: { time: new Date(), verb: "POST", uri, headers: { authorization: "Bearer id-token", "content-type": "application/json" }, body: { name: "Integration" } },
    response: { time: new Date(), status: 201, headers: { "content-type": "application/json" }, body: { api_key: RAW_KEY, key: { id: 7, prefix: "oo_test_abcde" } } },
  };
}

function loadMoesifOptions() {
  const appPath = path.resolve(__dirname, "../app.js");
  const realRequire = createRequire(appPath);
  const app = { disable() {}, use() {}, listen() {}, get() {}, post() {}, delete() {}, put() {}, patch() {} };
  const express = Object.assign(() => app, { json: () => () => {}, raw: () => () => {} });
  const env = Object.fromEntries(["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "FRONT_END_DOMAIN", "MOESIF_APPLICATION_ID", "MOESIF_MANAGEMENT_TOKEN", "MOESIF_TEMPLATE_WORKSPACE_ID_LIVE_EVENT_LOG", "MOESIF_TEMPLATE_WORKSPACE_ID_TIME_SERIES", "SN_API_BASE_URL", "SN_API_PROVISIONING_TOKEN", "STRIPE_API_KEY"].map(key => [key, "fixture"]));
  env.PORTAL_STRIPE_WEBHOOK_SECRET = "whsec_fixture";
  env.ADMIN_PLAN_CHANGE_TOKEN = "admin-fixture";
  let options;
  vm.runInNewContext(fs.readFileSync(appPath, "utf8"), {
    require(name) {
      if (name === "express") return express;
      if (name === "dotenv") return { config() {} };
      if (name === "moesif-nodejs") return (config) => { options = config; return () => {}; };
      if (name === "cors") return () => () => {};
      if (name === "./services/authPlugin") return { authMiddleware() {} };
      if (["./services/moesifApis", "./services/commonUtils", "./services/stripeApis", "./services/snApiProvisioning"].includes(name)) return new Proxy({}, { get: () => () => {} });
      return realRequire(name);
    },
    process: { env, pid: 1 }, Buffer, URL, URLSearchParams, console: { log() {}, warn() {}, error() {} },
    setInterval: () => ({ unref() {} }), setImmediate: () => ({ unref() {} }), setTimeout: () => ({ unref() {} }),
  }, { filename: appPath });
  return options;
}

test("API key, webhook, wallet and admin routes are never sent to Moesif", () => {
  for (const reqPath of [
    "/api-keys", "/api-keys/7", "/api-keys/7/rotate", "/api-keys/7/pause",
    "/organization-api-keys", "/organization-api-keys/7/pause",
    "/stripe/webhook", "/wallet/purchases", "/admin/wallet-purchases/1/confirm", "/admin/invitations",
    "/create-stripe-checkout-session", "/register/stripe/cs_123",
  ]) {
    assert.equal(shouldSkipMoesifEvent({ path: reqPath }), true, reqPath);
  }
});

test("ordinary portal routes are still tracked", () => {
  for (const reqPath of ["/plans", "/subscriptions", "/sign-in", "/api-keys-help"]) {
    assert.equal(shouldSkipMoesifEvent({ path: reqPath }), false, reqPath);
  }
  for (const reqPath of ["/usage-summary", "/embed-charts", "/portal-context", "/onboarding/accept", "/invitations/accept", "/invitation-notifications/1/dismiss"]) {
    assert.equal(shouldSkipMoesifEvent({ path: reqPath }), true, reqPath);
  }
});

test("masking removes raw keys and secret headers from any event that is sent", () => {
  const event = maskMoesifEvent(keyEvent("https://portal.example.test/api-keys"));
  const serialised = JSON.stringify(event);
  assert.ok(!serialised.includes(RAW_KEY));
  assert.ok(!serialised.includes("id-token"));
  assert.equal(event.request.headers.authorization, "[REDACTED]");
  assert.equal(event.request.body.name, "Integration");
});

test("app.js wires the skip and masking rules into the Moesif middleware", () => {
  const options = loadMoesifOptions();
  assert.ok(options, "moesif middleware was configured");
  assert.equal(options.maskContent, maskMoesifEvent);
  for (const reqPath of ["/api-keys", "/api-keys/7/rotate"]) {
    assert.equal(options.skip({ path: reqPath }, {}), true, reqPath);
  }
  const masked = options.maskContent(keyEvent("https://portal.example.test/plans"));
  assert.ok(!JSON.stringify(masked).includes(RAW_KEY));
});
