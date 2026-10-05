// Thin Auth0 Management API helper for the dev portal backend. Used only to
// (re)send the email-verification message for the authenticated user: Auth0's
// client-side SDKs can't trigger this, so it has to come from a server holding
// Management API credentials. Uses the global fetch available on Node >= 20 to
// avoid pulling in the full `auth0` SDK just for one endpoint.
//
// Required env (a Machine-to-Machine app authorized for the Auth0 Management
// API with the `update:users` / `create:user_tickets` scopes that the
// verification-email job needs):
//   AUTH0_DOMAIN                      (already used for token verification)
//   AUTH0_CLIENT_ID                   (the SPA app id; scopes the job's link)
//   AUTH0_MANAGEMENT_CLIENT_ID
//   AUTH0_MANAGEMENT_CLIENT_SECRET
//
// When the Management credentials are absent the helper reports itself as not
// configured so callers can degrade gracefully (503) rather than crash.

let cachedToken = null; // { value, expiresAt }

function managementConfig() {
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_MANAGEMENT_CLIENT_ID;
  const clientSecret = process.env.AUTH0_MANAGEMENT_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) return null;
  return { domain, clientId, clientSecret };
}

function isConfigured() {
  return managementConfig() !== null;
}

async function getManagementToken(config, now = Date.now()) {
  // Reuse a cached token until a minute before it expires.
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;
  const response = await fetch(`https://${config.domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      audience: `https://${config.domain}/api/v2/`,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`Auth0 management token request failed (${response.status})`);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  const data = await response.json();
  if (!data.access_token) throw new Error("Auth0 management token response had no access_token");
  cachedToken = { value: data.access_token, expiresAt: now + (Number(data.expires_in) || 0) * 1000 };
  return cachedToken.value;
}

// Trigger a fresh verification email for the given Auth0 user id (the token
// `sub`). Resolves on success; throws with a `.status` on failure. Throws a
// 503-flavoured error when Management credentials are not configured.
async function resendVerificationEmail(userId) {
  if (!userId) {
    const error = new Error("A user id is required to resend verification");
    error.status = 400;
    throw error;
  }
  const config = managementConfig();
  if (!config) {
    const error = new Error("Auth0 Management API is not configured");
    error.status = 503;
    error.code = "verification_resend_unconfigured";
    throw error;
  }
  const token = await getManagementToken(config);
  const body = { user_id: userId };
  // Scopes the verification link to the SPA app when that id is available.
  if (process.env.AUTH0_CLIENT_ID) body.client_id = process.env.AUTH0_CLIENT_ID;
  const response = await fetch(`https://${config.domain}/api/v2/jobs/verification-email`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`Auth0 verification-email job failed (${response.status})`);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  return true;
}

// Test seam: reset the in-memory token cache between cases.
function __resetTokenCache() {
  cachedToken = null;
}

module.exports = { resendVerificationEmail, isConfigured, getManagementToken, __resetTokenCache };
