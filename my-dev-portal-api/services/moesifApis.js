const moesif = require("moesif-nodejs");

const moesifManagementToken = process.env.MOESIF_MANAGEMENT_TOKEN;
const moesifApiEndpoint = "https://api.moesif.com";

function basicPrepaidSubscriptionId(stripeCustomerId) {
  return `openopps_basic_prepaid_${stripeCustomerId}`;
}

async function readMoesifResponse(response, operation) {
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }

  if (!response.ok) {
    const detail = JSON.stringify(body || { message: response.statusText });
    const error = new Error(`${operation} failed (${response.status}): ${detail}`);
    error.status = response.status;
    error.detail = body;
    const normalized = detail.toLowerCase();
    if (
      [401, 403].includes(response.status) &&
      (normalized.includes("create:billing_meters") ||
        normalized.includes("create:billing_reports"))
    ) {
      error.code = "moesif_management_scope_missing";
    }
    throw error;
  }
  return body;
}

let profileMiddleware;

function getProfileMiddleware() {
  if (!profileMiddleware) {
    profileMiddleware = moesif({
      applicationId: process.env.MOESIF_APPLICATION_ID,
      identifyUser: (req) => req.user?.id,
    });
  }
  return profileMiddleware;
}

function syncToMoesif({
  companyId,
  userId,
  email,
  auth0UserId,
  stripeCustomerId,
  planKey,
}) {
  const moesifMiddleware = getProfileMiddleware();
  if (companyId) {
    moesifMiddleware.updateCompany({
      companyId,
      metadata: {
        stripe_customer_id: stripeCustomerId,
        ...(planKey ? { plan_key: planKey } : {}),
      },
    });
  }
  if (userId) {
    moesifMiddleware.updateUser({
      userId,
      companyId,
      metadata: {
        email,
        auth0_user_id: auth0UserId,
        stripe_customer_id: stripeCustomerId,
        ...(planKey ? { plan_key: planKey } : {}),
      },
    });
  }
}

async function sendPrepaidSubscriptionToMoesif({
  companyId,
  stripeCustomerId,
  planId,
  priceIds,
  currentPeriodStart,
  currentPeriodEnd,
}) {
  const subscriptionId = basicPrepaidSubscriptionId(stripeCustomerId);
  const response = await fetch("https://api.moesif.net/v1/subscriptions", {
    method: "POST",
    headers: {
      "X-Moesif-Application-Id": process.env.MOESIF_APPLICATION_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subscription_id: subscriptionId,
      company_id: String(companyId),
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
      status: "active",
      items: priceIds.map((priceId) => ({ plan_id: planId, price_id: priceId })),
      metadata: {
        billing_model: "prepaid_credit",
        plan_key: "basic",
        stripe_customer_id: stripeCustomerId,
      },
    }),
  });
  await readMoesifResponse(response, "Moesif prepaid subscription update");
  return subscriptionId;
}

async function createMoesifBalanceTransaction({
  companyId,
  subscriptionId,
  amountGbp,
  transactionId,
  description,
}) {
  const response = await fetch(
    `${moesifApiEndpoint}/~/billing/reports/balance_transactions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${moesifManagementToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        company_id: String(companyId),
        subscription_id: subscriptionId,
        amount: amountGbp,
        type: "credit",
        transaction_id: transactionId,
        description: description || "Open Opportunities Basic credit top-up",
      }),
    }
  );
  return readMoesifResponse(response, "Moesif balance credit");
}

async function getMoesifPrepaidBalance({ companyId, stripeCustomerId }) {
  const response = await fetch(
    `${moesifApiEndpoint}/v1/search/~/companies/${encodeURIComponent(
      companyId
    )}/subscriptions`,
    { headers: { Authorization: `Bearer ${moesifManagementToken}` } }
  );
  const body = await readMoesifResponse(response, "Moesif balance lookup");
  const subscriptions = Array.isArray(body)
    ? body
    : body?.data || body?.subscriptions || [];
  const expectedId = basicPrepaidSubscriptionId(stripeCustomerId);
  const subscription = subscriptions.find(
    (candidate) =>
      candidate.subscription_id === expectedId || candidate.external_id === expectedId
  );
  if (!subscription) {
    const error = new Error("Basic prepaid subscription was not found in Moesif");
    error.code = "moesif_prepaid_subscription_not_found";
    error.status = 404;
    throw error;
  }
  return {
    subscriptionId: expectedId,
    subscription,
    currency: String(subscription.currency || "GBP").toUpperCase(),
    current: Number(subscription.balance?.current_balance || 0),
    pending: Number(subscription.balance?.pending_activity || 0),
    available: Number(subscription.balance?.available_balance || 0),
  };
}

async function getPlansFromMoesif() {
  const provider = process.env.APP_PAYMENT_PROVIDER || "stripe";
  const response = await fetch(
    `${moesifApiEndpoint}/v1/~/billing/catalog/plans?includes=prices&provider=${encodeURIComponent(
      provider
    )}`,
    { headers: { Authorization: `Bearer ${moesifManagementToken}` } }
  );
  return readMoesifResponse(response, "Moesif plan catalogue lookup");
}

async function getInfoForEmbeddedWorkspaces({ companyId, workspaceId }) {
  if (!workspaceId) {
    const error = new Error("Moesif embedded workspace is not configured");
    error.code = "moesif_workspace_not_configured";
    throw error;
  }
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  const expiration = new Date(to);
  expiration.setUTCDate(expiration.getUTCDate() + 7);

  const response = await fetch(
    `${moesifApiEndpoint}/v1/portal/~/workspaces/${encodeURIComponent(
      workspaceId
    )}/access_token?expiration=${encodeURIComponent(expiration.toISOString())}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${moesifManagementToken}`,
      },
      body: JSON.stringify({
        template: {
          values: { company_id: [String(companyId)] },
          from: from.toISOString(),
          to: to.toISOString(),
        },
      }),
    }
  );
  return readMoesifResponse(response, "Moesif embedded workspace token");
}

module.exports = {
  syncToMoesif,
  getPlansFromMoesif,
  getInfoForEmbeddedWorkspaces,
  sendPrepaidSubscriptionToMoesif,
  createMoesifBalanceTransaction,
  getMoesifPrepaidBalance,
  basicPrepaidSubscriptionId,
  readMoesifResponse,
};
