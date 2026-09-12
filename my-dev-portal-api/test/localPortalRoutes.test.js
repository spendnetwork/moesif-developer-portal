const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const Stripe = require("stripe");

function harness({ ledgerFailure = false, ledgerStatus = 503, currentPlan = "development", debitOwner = "api", prepaidEnabled = true, checkoutFailure } = {}) {
  const routes = new Map();
  const calls = [];
  const logs = [];
  const app = { disable() {}, use() {}, listen() {} };
  for (const method of ["get", "post", "delete"]) app[method] = (url, ...handlers) => routes.set(`${method}:${url}`, handlers.at(-1));
  const express = Object.assign(() => app, { json: () => () => {}, raw: () => () => {} });
  const context = { organization_id: 9, current_plan_key: currentPlan, current_subscription_id: "prepaid_dev", debit_owner: debitOwner, billing_status: "active", moesif_company_id: "9" };
  const snapshot = { prepaid_enabled: prepaidEnabled, plan_key: currentPlan, subscription_id: "prepaid_dev", debit_owner: debitOwner, currency: "GBP",
    balances: { development: { granted_gbp_pence: 10000, remaining_gbp_pence: 0, spendable_gbp_pence: 0, expired_gbp_pence: 0 } },
    rate_card: { api_call_quantity: 26, records_returned: 13, aggregate_call_quantity: 46, attachment_list_quantity: 65, attachment_download_quantity: 65 },
    usage: { cost_gbp_pence: 10000, measurements: { api_call_quantity: 0, records_returned: 0, aggregate_call_quantity: 0, attachment_list_quantity: 0, attachment_download_quantity: 0 } },
    access_block_reason: "insufficient_credit", as_of: "2026-09-07T00:00:00Z" };
  const stripeServices = new Proxy({ LIVE_SUBSCRIPTION_STATUSES: ["active"],
    verifyStripeSession: async () => { if (checkoutFailure) throw checkoutFailure; throw new Error("Unexpected verification"); },
    getPlanKeyForProduct: async () => { calls.push("product-plan-read"); return "basic"; },
    createBasicCreditCheckoutSession: async (...args) => { calls.push(["checkout", args]); return { id: "cs_fixture", client_secret: "fixture-secret" }; },
    getProductIdForPlanKey: async () => { calls.push("product-read"); return "prod_basic"; },
    constructStripeEvent: (body, signature, secret) => Stripe.webhooks.constructEvent(body, signature, secret) }, {
    get(target, key) { return target[key] || (() => { calls.push(`stripe:${key}`); throw new Error("Unexpected Stripe dependency"); }); },
  });
  const apiServices = {
    checkSnApiEmailAvailability: async () => ({ conflict: false }),
    getSnApiPortalContext: async () => context,
    createSnApiManualCommitment: async (_user, payload) => { calls.push(["commitment", payload]); return { status: "awaiting_invoice", amount_gbp_pence: payload.to_plan_key === "growth" ? 500000 : 1200000 }; },
    getSnApiUsageSummary: async () => { calls.push("ledger"); if (ledgerFailure) throw Object.assign(new Error("Ledger unavailable"), { status: ledgerStatus }); return snapshot; },
    listSnApiKeys: async () => ({ keys: [{ id: 1, name: "Existing integration" }], max_active_keys: 2 }),
    setSnApiKeyPaused: async (user, id, paused) => { calls.push({ user, id, paused }); return { id: Number(id), is_active: !paused }; },
  };
  const appPath = path.resolve(__dirname, "../app.js");
  const realRequire = createRequire(appPath);
  const env = Object.fromEntries(["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "FRONT_END_DOMAIN", "MOESIF_APPLICATION_ID", "MOESIF_MANAGEMENT_TOKEN", "MOESIF_TEMPLATE_WORKSPACE_ID_LIVE_EVENT_LOG", "MOESIF_TEMPLATE_WORKSPACE_ID_TIME_SERIES", "SN_API_BASE_URL", "SN_API_PROVISIONING_TOKEN", "STRIPE_API_KEY"].map(key => [key, "fixture"]));
  env.PORTAL_STRIPE_WEBHOOK_SECRET = "whsec_fixture";
  env.ADMIN_PLAN_CHANGE_TOKEN = "admin-fixture";
  vm.runInNewContext(fs.readFileSync(appPath, "utf8"), {
    require(name) {
      if (name === "express") return express;
      if (name === "dotenv") return { config() {} };
      if (["moesif-nodejs", "cors"].includes(name)) return () => () => {};
      if (name === "./services/stripeApis") return stripeServices;
      if (name === "./services/snApiProvisioning") return apiServices;
      if (name === "./services/authPlugin") return { authMiddleware() {} };
      if (["./services/moesifApis", "./services/commonUtils"].includes(name)) return {};
      return realRequire(name);
    },
    process: { env, pid: 1 }, Buffer, URL, URLSearchParams, console: { log() {}, warn() {}, error(...args) { logs.push(args); } },
    setInterval: () => ({ unref() {} }), setImmediate: () => ({ unref() {} }),
  }, { filename: appPath });
  return {
    calls,
    logs,
    async request(method, url, extra = {}) {
      let status = 200, body;
      const response = { status(value) { status = value; return this; }, json(value) { body = value; return this; }, send(value) { body = value; return this; } };
      await routes.get(`${method}:${url}`)({ user: { sub: "auth0|dev", email: "dev@example.test" }, portalContext: { ...context }, ...extra }, response);
      return { status, body };
    },
  };
}

test("exhausted development subscriptions, keys and usage stay readable without Stripe", async () => {
  const server = harness();
  const subs = await server.request("get", "/subscriptions");
  assert.equal(subs.status, 200);
  assert.equal(subs.body[0].plan_key, "development");
  const keys = await server.request("get", "/api-keys");
  assert.equal(keys.body.has_active_subscription, true);
  assert.equal(keys.body.api_access_allowed, false);
  assert.equal(keys.body.keys.length, 1);
  const usage = await server.request("get", "/usage-summary");
  assert.equal(usage.body.credit.remaining, 0);
  assert.equal(usage.body.debitOwner, "api");
  assert.ok(server.calls.every(call => call === "ledger"));
});

test("pause and resume bind actions to the signed-in user, ignoring supplied identity", async () => {
  const server = harness();
  for (const action of ["pause", "resume"]) {
    const response = await server.request("post", `/api-keys/:api_key_id/${action}`, {
      params: { api_key_id: "7" }, body: { auth0_user_id: "attacker", is_active: true },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.is_active, action === "resume");
  }
  assert.equal(server.calls.length, 2);
  assert.equal(server.calls[0].user.sub, "auth0|dev");
  assert.equal(server.calls[0].paused, true);
});

test("admin grant endpoint rejects public callers before any API calls", async () => {
  const server = harness();
  const response = await server.request("post", "/admin/development-credit", { headers: {}, body: { requested_by: "pretend-admin" } });
  assert.equal(response.status, 401);
  assert.equal(server.calls.length, 0);
});

test("admin move from Development or no plan to Basic only returns a customer payment link", async () => {
  for (const currentPlan of [null, "development"]) {
    const server = harness({ currentPlan });
    const response = await server.request("post", "/admin/plan-change", { headers: { "x-admin-service-token": "admin-fixture" }, body: { auth0_user_id: "auth0|dev", to_plan_key: "basic" } });
    assert.equal(response.status, 200);
    assert.equal(response.body.paymentRequired, true);
    assert.equal(response.body.planKey, currentPlan);
    assert.ok(response.body.paymentUrl.includes("purchase_type=basic_activation"));
    assert.deepEqual(server.calls, ["product-read"]);
  }
});

test("Development to Growth or Enterprise passes a full manual commitment request without a credit offset", async () => {
  for (const target of ["growth", "enterprise"]) {
    const server = harness();
    const response = await server.request("post", "/admin/plan-change", { headers: { "x-admin-service-token": "admin-fixture" }, body: { auth0_user_id: "auth0|dev", to_plan_key: target, actor_email: "admin@example.test" } });
    assert.equal(response.status, 200);
    assert.equal(response.body.requiresManualInvoice, true);
    assert.equal(response.body.manualCommitment.amount_gbp_pence, target === "growth" ? 500000 : 1200000);
    const [[kind, payload]] = server.calls;
    assert.equal(kind, "commitment");
    assert.deepEqual(Object.keys(payload).sort(), ["metadata", "request_id", "requested_by", "to_plan_key"]);
  }
});

test("ledger failure never falls back to Stripe or hides existing keys", async () => {
  const server = harness({ ledgerFailure: true });
  assert.equal((await server.request("get", "/usage-summary")).status, 503);
  const keys = await server.request("get", "/api-keys");
  assert.equal(keys.status, 200);
  assert.equal(keys.body.keys.length, 1);
  assert.ok(keys.body.entitlement_error);
  assert.ok(server.calls.every(call => call === "ledger"));
});

test("webhook invalid signature is rejected before any billing lookup", async () => {
  const server = harness();
  const response = await server.request("post", "/stripe/webhook", {
    body: Buffer.from(JSON.stringify({ type: "checkout.session.completed" })), headers: { "stripe-signature": "invalid" },
  });
  assert.equal(response.status, 400);
  assert.equal(server.calls.length, 0);
});

test("legacy Basic checkout is stopped before Stripe mutations or entitlement reconciliation", async () => {
  for (const purchaseType of ["basic_activation", "basic_credit_top_up"]) {
    const server = harness({ currentPlan: "basic", debitOwner: "admin" });
    const response = await server.request("post", "/create-stripe-checkout-session", { query: { plan_id: "prod_basic", amount_gbp: "100", purchase_type: purchaseType } });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "legacy_basic_migration_required");
    assert.match(response.body.message, /welcome@openopps.com/);
    assert.deepEqual(server.calls, ["product-plan-read", "ledger"]);
  }
});

test("API-owned unfunded Basic and exhausted Development can reach paid checkout", async () => {
  for (const currentPlan of ["development", "basic"]) {
    const server = harness({ currentPlan });
    const response = await server.request("post", "/create-stripe-checkout-session", { query: { plan_id: "prod_basic", amount_gbp: "100", purchase_type: currentPlan === "basic" ? "basic_credit_top_up" : "basic_activation" } });
    assert.equal(response.status, 200);
    assert.equal(response.body.clientSecret, "fixture-secret");
    assert.equal(server.calls.filter(call => Array.isArray(call) && call[0] === "checkout").length, 1);
  }
});

test("new Basic checkout fails before mutations for disabled, missing and 404 API readiness", async () => {
  for (const currentPlan of [null, "development", "basic"]) {
    for (const options of [{ prepaidEnabled: false }, { prepaidEnabled: null }, { ledgerFailure: true, ledgerStatus: 404 }]) {
      const server = harness({ currentPlan, ...options });
      const response = await server.request("post", "/create-stripe-checkout-session", { query: { plan_id: "prod_basic", amount_gbp: "100", purchase_type: currentPlan === "basic" ? "basic_credit_top_up" : "basic_activation" } });
      assert.equal(response.status, 503);
      assert.equal(response.body.code, "prepaid_checkout_unavailable");
      assert.deepEqual(server.calls, ["product-plan-read", "ledger"]);
    }
  }
});

test("verified Basic webhook failures log only safe identifiers, not Stripe or API payloads", async () => {
  const server = harness({ checkoutFailure: Object.assign(new Error("private-payment-body"), { code: "prepaid_not_enabled", data: { token: "private-api-token" } }) });
  const payload = JSON.stringify({ id: "evt_fixture", type: "checkout.session.completed", data: { object: { id: "cs_fixture", metadata: { purchase_type: "basic_activation" } } } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_fixture" });
  const response = await server.request("post", "/stripe/webhook", { body: Buffer.from(payload), headers: { "stripe-signature": signature } });
  assert.equal(response.status, 500);
  const logged = JSON.stringify(server.logs);
  assert.match(logged, /prepaid_not_enabled/);
  assert.match(logged, /evt_fixture/);
  assert.doesNotMatch(logged, /private-payment-body|private-api-token|cs_fixture/);
});
