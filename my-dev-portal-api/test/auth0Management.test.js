const test = require("node:test");
const assert = require("node:assert/strict");
const mgmt = require("../services/auth0Management");

const ENV_KEYS = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_MANAGEMENT_CLIENT_ID", "AUTH0_MANAGEMENT_CLIENT_SECRET"];

function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  mgmt.__resetTokenCache();
  return Promise.resolve(fn()).finally(() => {
    for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    mgmt.__resetTokenCache();
  });
}

const configured = {
  AUTH0_DOMAIN: "tenant.uk.auth0.com", AUTH0_CLIENT_ID: "spa123",
  AUTH0_MANAGEMENT_CLIENT_ID: "m2m", AUTH0_MANAGEMENT_CLIENT_SECRET: "secret",
};

test("isConfigured reflects presence of management credentials", async () => {
  await withEnv({ AUTH0_DOMAIN: "tenant.uk.auth0.com" }, () => assert.equal(mgmt.isConfigured(), false));
  await withEnv(configured, () => assert.equal(mgmt.isConfigured(), true));
});

test("resendVerificationEmail without config throws a 503 the caller can degrade on", async () => {
  await withEnv({ AUTH0_DOMAIN: "tenant.uk.auth0.com" }, async () => {
    await assert.rejects(() => mgmt.resendVerificationEmail("auth0|1"),
      err => err.status === 503 && err.code === "verification_resend_unconfigured");
  });
});

test("resendVerificationEmail requires a user id", async () => {
  await withEnv(configured, async () => {
    await assert.rejects(() => mgmt.resendVerificationEmail(""), err => err.status === 400);
  });
});

test("resendVerificationEmail fetches a token then posts the verification-email job", async () => {
  await withEnv(configured, async () => {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      if (url.endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      return new Response("{}", { status: 201 });
    };
    try {
      assert.equal(await mgmt.resendVerificationEmail("auth0|42"), true);
    } finally { global.fetch = original; }

    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith("/oauth/token"));
    assert.equal(calls[0].body.grant_type, "client_credentials");
    assert.equal(calls[0].body.audience, "https://tenant.uk.auth0.com/api/v2/");
    assert.ok(calls[1].url.endsWith("/api/v2/jobs/verification-email"));
    assert.equal(calls[1].headers.authorization, "Bearer tok");
    assert.equal(calls[1].body.user_id, "auth0|42");
    assert.equal(calls[1].body.client_id, "spa123"); // link scoped to the SPA app
  });
});

test("the management token is cached across calls", async () => {
  await withEnv(configured, async () => {
    let tokenRequests = 0;
    const original = global.fetch;
    global.fetch = async (url) => {
      if (url.endsWith("/oauth/token")) { tokenRequests++; return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }); }
      return new Response("{}", { status: 201 });
    };
    try {
      await mgmt.resendVerificationEmail("auth0|1");
      await mgmt.resendVerificationEmail("auth0|2");
    } finally { global.fetch = original; }
    assert.equal(tokenRequests, 1);
  });
});

test("a failed verification-email job surfaces the upstream status", async () => {
  await withEnv(configured, async () => {
    const original = global.fetch;
    global.fetch = async (url) => {
      if (url.endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      return new Response("rate limited", { status: 429 });
    };
    try {
      await assert.rejects(() => mgmt.resendVerificationEmail("auth0|1"), err => err.status === 429);
    } finally { global.fetch = original; }
  });
});
