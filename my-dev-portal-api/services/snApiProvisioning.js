function requireConfig(name, { url = false } = {}) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for SN API provisioning`);
  return url ? value.replace(/\/$/, "") : value;
}

const requestTimeoutMs = Number.parseInt(
  process.env.SN_API_REQUEST_TIMEOUT_MS || "10000",
  10
);

function requestSignal() {
  return AbortSignal.timeout(
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : 10000
  );
}

function unixTimestampToIso(value) {
  return value ? new Date(value * 1000).toISOString() : undefined;
}

function subscriptionPeriod(subscription) {
  const allItems = subscription?.items?.data || [];
  const meteredItems = allItems.filter(
    (item) => item.price?.recurring?.usage_type === "metered"
  );
  const items = meteredItems.length ? meteredItems : allItems;
  const starts = items.map((item) => item.current_period_start).filter(Number.isFinite);
  const ends = items.map((item) => item.current_period_end).filter(Number.isFinite);
  return {
    start: starts.length ? Math.min(...starts) : subscription?.current_period_start,
    end: ends.length ? Math.max(...ends) : subscription?.current_period_end,
  };
}

function getPlanKey(price, product) {
  const configured = price?.metadata?.plan_key || product?.metadata?.plan_key;
  if (configured) {
    const normalized = String(configured).trim().toLowerCase();
    if (["basic", "growth", "enterprise"].includes(normalized)) {
      return normalized;
    }
    throw new Error(`Unsupported plan_key metadata: ${configured}`);
  }

  const name = `${product?.name || ""} ${price?.nickname || ""}`.toLowerCase();
  for (const planKey of ["enterprise", "growth", "basic"]) {
    if (name.includes(planKey)) return planKey;
  }
  throw new Error(
    "Unable to determine plan_key. Add plan_key metadata to the Stripe price or product."
  );
}

function getOrganizationName(authUser, customer) {
  return (
    customer?.name ||
    authUser?.organization_name ||
    authUser?.org_name ||
    authUser?.email?.split("@")[1] ||
    authUser?.email
  );
}

async function provisionSnApiCustomer({
  authUser,
  customer,
  subscription,
  price,
  product,
  rotateApiKey = false,
  subscriptionStatusOverride = null,
}) {
  const snApiBaseUrl = requireConfig("SN_API_BASE_URL", { url: true });
  const provisioningToken = requireConfig("SN_API_PROVISIONING_TOKEN");
  if (!authUser?.sub || !authUser?.email) {
    throw new Error("Authenticated Auth0 user id and email are required");
  }
  if (!customer?.id || !subscription?.id) {
    throw new Error("Stripe customer and subscription are required");
  }

  const customerEmail = customer.email || authUser.email;
  if (customerEmail.toLowerCase() !== authUser.email.toLowerCase()) {
    throw new Error("Stripe customer does not match the authenticated user");
  }

  const period = subscriptionPeriod(subscription);
  const response = await fetch(
    `${snApiBaseUrl}/api/v3/developer-portal/provision`,
    {
      method: "POST",
      signal: requestSignal(),
      headers: {
        "Content-Type": "application/json",
        "X-Developer-Portal-Token": provisioningToken,
      },
      body: JSON.stringify({
        auth0_user_id: authUser.sub,
        email: authUser.email,
        full_name: authUser.name || authUser.nickname || authUser.email,
        organization_name: getOrganizationName(authUser, customer),
        stripe_customer_id: customer.id,
        stripe_subscription_id: subscription.id,
        stripe_product_id: product?.id,
        stripe_price_id: price?.id,
        plan_key: getPlanKey(price, product),
        subscription_status:
          subscriptionStatusOverride || subscription.status,
        current_period_start: unixTimestampToIso(period.start),
        current_period_end: unixTimestampToIso(period.end),
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
        rotate_api_key: rotateApiKey,
        metadata: { source: "moesif_developer_portal" },
      }),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`SN API provisioning failed (${response.status})`);
    error.status = response.status;
    error.detail = body?.detail;
    throw error;
  }
  return body;
}

async function provisionSnApiPrepaidCustomer({
  authUser,
  customer,
  product,
  subscriptionStatus = "active",
}) {
  const snApiBaseUrl = requireConfig("SN_API_BASE_URL", { url: true });
  const provisioningToken = requireConfig("SN_API_PROVISIONING_TOKEN");
  if (!authUser?.sub || !authUser?.email) {
    throw new Error("Authenticated Auth0 user id and email are required");
  }
  if (!customer?.id || !product?.id) {
    throw new Error("Stripe customer and Basic product are required");
  }
  if (
    customer.email &&
    customer.email.toLowerCase() !== authUser.email.toLowerCase()
  ) {
    throw new Error("Stripe customer does not match the authenticated user");
  }

  const response = await fetch(
    `${snApiBaseUrl}/api/v3/developer-portal/provision`,
    {
      method: "POST",
      signal: requestSignal(),
      headers: {
        "Content-Type": "application/json",
        "X-Developer-Portal-Token": provisioningToken,
      },
      body: JSON.stringify({
        auth0_user_id: authUser.sub,
        email: authUser.email,
        full_name: authUser.name || authUser.nickname || authUser.email,
        organization_name: getOrganizationName(authUser, customer),
        stripe_customer_id: customer.id,
        stripe_subscription_id: null,
        stripe_product_id: product.id,
        stripe_price_id: null,
        plan_key: "basic",
        subscription_status: subscriptionStatus,
        cancel_at_period_end: false,
        metadata: {
          source: "moesif_developer_portal",
          billing_model: "prepaid_credit",
        },
      }),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      `SN API prepaid provisioning failed (${response.status})`
    );
    error.status = response.status;
    error.detail = body?.detail;
    throw error;
  }
  return body;
}

async function checkSnApiEmailAvailability(authUser) {
  if (!authUser?.sub || !authUser?.email) {
    throw new Error("Authenticated Auth0 user id and email are required");
  }
  return snApiKeyRequest(
    `/api/v3/developer-portal/email-availability?email=${encodeURIComponent(
      authUser.email
    )}&auth0_user_id=${encodeURIComponent(authUser.sub)}`
  );
}

async function snApiKeyRequest(path, { method = "GET", body } = {}) {
  const snApiBaseUrl = requireConfig("SN_API_BASE_URL", { url: true });
  const provisioningToken = requireConfig("SN_API_PROVISIONING_TOKEN");
  const response = await fetch(`${snApiBaseUrl}${path}`, {
    method,
    signal: requestSignal(),
    headers: {
      "Content-Type": "application/json",
      "X-Developer-Portal-Token": provisioningToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseBody =
    response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      responseBody?.detail || responseBody?.message || "SN API key request failed"
    );
    error.status = response.status;
    throw error;
  }
  return responseBody;
}

async function getSnApiPortalContext(authUser) {
  if (!authUser?.sub) {
    throw new Error("Authenticated Auth0 user id is required");
  }
  return snApiKeyRequest(
    `/api/v3/developer-portal/portal-context?auth0_user_id=${encodeURIComponent(
      authUser.sub
    )}`
  );
}

function listSnApiKeys(authUser) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/portal-api-keys?auth0_user_id=${encodeURIComponent(
      authUser.sub
    )}`
  );
}

function createSnApiKey(authUser, { name, description }) {
  return snApiKeyRequest("/api/v3/developer-portal/portal-api-keys", {
    method: "POST",
    body: {
      auth0_user_id: authUser.sub,
      name,
      description: description || null,
    },
  });
}

function revokeSnApiKey(authUser, apiKeyId) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/portal-api-keys/${apiKeyId}?auth0_user_id=${encodeURIComponent(
      authUser.sub
    )}`,
    { method: "DELETE" }
  );
}

function rotateSnApiKey(authUser, apiKeyId) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/portal-api-keys/${apiKeyId}/rotate`,
    {
      method: "POST",
      body: { auth0_user_id: authUser.sub },
    }
  );
}

function createSnApiPlanChange(authUser, planChange) {
  return snApiKeyRequest("/api/v3/developer-portal/plan-changes", {
    method: "POST",
    body: { auth0_user_id: authUser.sub, ...planChange },
  });
}

function getSnApiCurrentPlanChange(authUser) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/plan-changes/current?auth0_user_id=${encodeURIComponent(
      authUser.sub
    )}`
  );
}

function registerSnApiPortalAccount(authUser) {
  if (!authUser?.sub || !authUser?.email) {
    throw new Error("Authenticated Auth0 user id and email are required");
  }
  return snApiKeyRequest("/api/v3/developer-portal/register", {
    method: "POST",
    body: {
      auth0_user_id: authUser.sub,
      email: authUser.email,
      full_name: authUser.name || authUser.nickname || authUser.email,
      organization_name:
        authUser.organization_name ||
        authUser.org_name ||
        authUser.email.split("@")[1] ||
        authUser.email,
    },
  });
}

function getSnApiPlanChangeByCustomer(stripeCustomerId) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/plan-changes/by-customer/${encodeURIComponent(
      stripeCustomerId
    )}`
  );
}

function listSnApiDuePlanChanges(limit = 100) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/plan-changes/due?limit=${encodeURIComponent(limit)}`
  );
}

function claimSnApiDuePlanChanges(
  workerId,
  limit = 100,
  leaseSeconds = 300
) {
  return snApiKeyRequest("/api/v3/developer-portal/plan-changes/claim-due", {
    method: "POST",
    body: {
      worker_id: workerId,
      limit,
      lease_seconds: leaseSeconds,
    },
  });
}

function updateSnApiPlanChange(requestId, update) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/plan-changes/${encodeURIComponent(requestId)}`,
    { method: "PATCH", body: update }
  );
}

function createSnApiManualCommitment(authUser, commitment) {
  return snApiKeyRequest("/api/v3/developer-portal/manual-commitments", {
    method: "POST",
    body: { auth0_user_id: authUser.sub, ...commitment },
  });
}

function getSnApiCurrentManualCommitment(authUser) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/manual-commitments/current?auth0_user_id=${encodeURIComponent(
      authUser.sub
    )}`
  );
}

function confirmSnApiManualCommitmentPayment(requestId, payment) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/manual-commitments/${encodeURIComponent(
      requestId
    )}/confirm-payment`,
    { method: "POST", body: payment }
  );
}

function updateSnApiManualCommitmentMoesifSync(requestId, update) {
  return snApiKeyRequest(
    `/api/v3/developer-portal/manual-commitments/${encodeURIComponent(
      requestId
    )}/moesif-sync`,
    { method: "PATCH", body: update }
  );
}

function overrideSnApiManualPlanDowngrade(authUser, override) {
  return snApiKeyRequest(
    "/api/v3/developer-portal/manual-plan-downgrades/override",
    {
      method: "POST",
      body: { auth0_user_id: authUser.sub, ...override },
    }
  );
}

function updateSnApiSubscriptionStatus(subscription, customerId) {
  const period = subscriptionPeriod(subscription);
  return snApiKeyRequest(
    `/api/v3/developer-portal/subscriptions/${encodeURIComponent(
      subscription.id
    )}/status`,
    {
      method: "PATCH",
      body: {
        stripe_customer_id: customerId,
        status: subscription.status,
        current_period_start: unixTimestampToIso(period.start),
        current_period_end: unixTimestampToIso(period.end),
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      },
    }
  );
}

module.exports = {
  provisionSnApiCustomer,
  provisionSnApiPrepaidCustomer,
  checkSnApiEmailAvailability,
  getSnApiPortalContext,
  registerSnApiPortalAccount,
  listSnApiKeys,
  createSnApiKey,
  revokeSnApiKey,
  rotateSnApiKey,
  createSnApiPlanChange,
  getSnApiCurrentPlanChange,
  getSnApiPlanChangeByCustomer,
  listSnApiDuePlanChanges,
  claimSnApiDuePlanChanges,
  updateSnApiPlanChange,
  createSnApiManualCommitment,
  getSnApiCurrentManualCommitment,
  confirmSnApiManualCommitmentPayment,
  updateSnApiManualCommitmentMoesifSync,
  overrideSnApiManualPlanDowngrade,
  updateSnApiSubscriptionStatus,
  subscriptionPeriod,
};
