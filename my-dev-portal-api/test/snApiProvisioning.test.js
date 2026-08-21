const test = require("node:test");
const assert = require("node:assert/strict");

const {
  registerSnApiPortalAccount,
} = require("../services/snApiProvisioning");

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
