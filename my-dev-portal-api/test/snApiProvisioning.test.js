const test = require("node:test");
const assert = require("node:assert/strict");

const {
  registerSnApiPortalAccount,
  provisionSnApiLocalPrepaidCustomer,
  registerSnApiPaidCredit,
  getSnApiUsageSummary,
  setSnApiKeyPaused,
} = require("../services/snApiProvisioning");

test("pause and resume send authenticated identity and validate key ids", async (t) => {
  const env = { ...process.env };
  process.env.SN_API_BASE_URL = "https://api.example.test";
  process.env.SN_API_PROVISIONING_TOKEN = "fixture-token";
  t.after(() => {
    for (const name of ["SN_API_BASE_URL", "SN_API_PROVISIONING_TOKEN"]) {
      if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
    }
  });
  const calls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: 7, is_active: url.endsWith("resume") }) };
  });
  for (const paused of [true, false]) {
    const result = await setSnApiKeyPaused({ sub: "auth0|owner" }, "7", paused);
    assert.equal(result.is_active, !paused);
  }
  assert.equal(calls[0].url, "https://api.example.test/api/v3/developer-portal/portal-api-keys/7/pause");
  assert.equal(calls[1].url.endsWith("/7/resume"), true);
  assert.deepEqual(JSON.parse(calls[0].options.body), { auth0_user_id: "auth0|owner" });
  assert.equal(calls[0].options.headers["X-Developer-Portal-Token"], "fixture-token");
  for (const id of ["../1", "7?auth0_user_id=other", "0", "7/resume"]) {
    assert.throws(() => setSnApiKeyPaused({ sub: "auth0|owner" }, id, true), { status: 422 });
  }
  assert.equal(calls.length, 2);
});

test("registers an Auth0 account with SN API before billing", async (t) => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.SN_API_BASE_URL;
  const originalToken = process.env.SN_API_PROVISIONING_TOKEN;
  process.env.SN_API_BASE_URL = "https://api.example.test";
  process.env.SN_API_PROVISIONING_TOKEN = "provisioning-token";

  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        user_id: 11,
        organization_id: 15,
        moesif_user_id: "11",
        moesif_company_id: "15",
        auth0_user_id: "auth0|new-user",
        email: "new-user@example.com",
        billing_status: "pending",
      }),
    };
  };

  t.after(() => {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.SN_API_BASE_URL;
    else process.env.SN_API_BASE_URL = originalBaseUrl;
    if (originalToken === undefined) delete process.env.SN_API_PROVISIONING_TOKEN;
    else process.env.SN_API_PROVISIONING_TOKEN = originalToken;
  });

  const result = await registerSnApiPortalAccount({
    sub: "auth0|new-user",
    email: "new-user@example.com",
    name: "New User",
  });

  assert.equal(result.billing_status, "pending");
  assert.equal(
    request.url,
    "https://api.example.test/api/v3/developer-portal/register"
  );
  assert.equal(request.options.method, "POST");
  assert.equal(
    request.options.headers["X-Developer-Portal-Token"],
    "provisioning-token"
  );
  assert.deepEqual(JSON.parse(request.options.body), {
    auth0_user_id: "auth0|new-user",
    email: "new-user@example.com",
    full_name: "New User",
    organization_name: "example.com",
  });
});

test("local prepaid transport keeps stable API payloads and structured conflict codes", async (t) => {
  const originalFetch = global.fetch;
  const originalEnv = { base: process.env.SN_API_BASE_URL, token: process.env.SN_API_PROVISIONING_TOKEN };
  process.env.SN_API_BASE_URL = "https://api.example.test";
  process.env.SN_API_PROVISIONING_TOKEN = "fixture-token";
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of [["SN_API_BASE_URL", originalEnv.base], ["SN_API_PROVISIONING_TOKEN", originalEnv.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ debit_owner: "api" }) };
  };
  const provision = { request_id: "basic-fixture", auth0_user_id: "auth0|buyer", plan_key: "basic", expected_current_plan_key: "development", requested_by: "stripe_checkout", stripe_customer_id: "cus_buyer" };
  const payment = { auth0_user_id: "auth0|buyer", subscription_id: "prepaid_basic", stripe_customer_id: "cus_buyer", stripe_payment_intent_id: "pi_payment", amount_gbp_pence: 10000, currency: "GBP" };
  await provisionSnApiLocalPrepaidCustomer(provision);
  await registerSnApiPaidCredit(payment);
  await getSnApiUsageSummary({ sub: "auth0|buyer" });
  assert.equal(requests[0].url, "https://api.example.test/api/v3/developer-portal/prepaid/provision");
  assert.deepEqual(JSON.parse(requests[0].options.body), provision);
  assert.equal(requests[1].url, "https://api.example.test/api/v3/developer-portal/paid-credits");
  assert.deepEqual(JSON.parse(requests[1].options.body), payment);
  assert.equal(requests[2].url, "https://api.example.test/api/v3/developer-portal/usage-summary?auth0_user_id=auth0%7Cbuyer");
  assert.equal(requests[2].options.headers["X-Developer-Portal-Token"], "fixture-token");
  global.fetch = async () => ({ ok: false, status: 409, json: async () => ({ detail: { code: "credit_subscription_conflict" } }) });
  await assert.rejects(registerSnApiPaidCredit(payment), { status: 409, code: "credit_subscription_conflict" });
});
