const moesif = require("moesif-nodejs");

const moesifManagementToken = process.env.MOESIF_MANAGEMENT_TOKEN;
const moesifApiEndpoint = "https://api.moesif.com";
const EMBED_WORKSPACE_CACHE_TTL_MS = 55 * 1000;
const EMBED_WORKSPACE_CACHE_MAX_ENTRIES = 2000;
const embedWorkspaceCache = new Map();
const embedWorkspaceInflight = new Map();

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
      operation === "Moesif usage metrics lookup"
    ) {
      // Some Moesif authorization responses omit the missing scope from the
      // body. The operation itself is unambiguous and requires read:events.
      error.code = "moesif_event_scope_missing";
    } else if (
      [401, 403].includes(response.status) &&
      (normalized.includes("create:billing_meters") ||
        normalized.includes("create:billing_reports") ||
        normalized.includes("read:billing_meters") ||
        normalized.includes("read:billing_reports"))
    ) {
      error.code = "moesif_management_scope_missing";
    }
    throw error;
  }
  return body;
}

function normalizeMoesifCollection(body, keys) {
  if (Array.isArray(body)) return body;
  for (const key of keys) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

function reportTimestamp(report) {
  const value =
    report?.updated_at ||
    report?.usage_end_time ||
    report?.created_at ||
    report?.last_success_time;
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestEndingBalance(reportBody) {
  const reports = normalizeMoesifCollection(reportBody, ["data", "reports"])
    .filter((report) => report?.success !== false && report?.ending_balance)
    .sort((left, right) => {
      const leftSequence = Number(left.ending_balance?.sequence_id);
      const rightSequence = Number(right.ending_balance?.sequence_id);
      if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence)) {
        return leftSequence - rightSequence;
      }
      return reportTimestamp(left) - reportTimestamp(right);
    });
  return reports.length ? reports[reports.length - 1] : null;
}

function normalizedBalance(value) {
  if (
    value?.current_balance == null ||
    value?.pending_activity == null ||
    value?.available_balance == null
  ) {
    return null;
  }
  const current = Number(value?.current_balance);
  const pending = Number(value?.pending_activity);
  const available = Number(value?.available_balance);
  if (![current, pending, available].every(Number.isFinite)) return null;
  return { current, pending, available };
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
  const reports = await getMoesifBillingReports({
    companyId,
    subscriptionId: expectedId,
    type: null,
  });
  const balanceReport = latestEndingBalance(reports);
  const balance =
    normalizedBalance(subscription.balance) ||
    normalizedBalance(balanceReport?.ending_balance);
  return {
    subscriptionId: expectedId,
    subscription,
    currency: String(
      balanceReport?.currency || subscription.currency || "GBP"
    ).toUpperCase(),
    balanceAvailable: Boolean(balance),
    current: balance?.current ?? null,
    pending: balance?.pending ?? null,
    available: balance?.available ?? null,
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

async function getMoesifBillingReports({
  companyId,
  subscriptionId,
  from,
  to,
  type = "usage",
}) {
  const params = new URLSearchParams({
    company_id: String(companyId),
    subscription_id: subscriptionId,
    success: "true",
  });
  if (type) params.set("type", type);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const response = await fetch(
    `${moesifApiEndpoint}/v1/~/billing/reports?${params.toString()}`,
    { headers: { Authorization: `Bearer ${moesifManagementToken}` } }
  );
  return readMoesifResponse(response, "Moesif billing report lookup");
}

function aggregationValue(body, key) {
  const value = Number(body?.aggregations?.[key]?.value);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function eventUsageMetricValues(body) {
  return {
    api_call: aggregationValue(body, "api_calls"),
    records_returned: aggregationValue(body, "records_returned"),
    aggregate_call: aggregationValue(body, "aggregate_calls"),
    attachment:
      aggregationValue(body, "attachment_list") +
      aggregationValue(body, "attachment_download"),
  };
}

async function getMoesifUsageMetrics({
  userId,
  companyId,
  subscriptionId,
  from,
  to,
}) {
  if (!userId || !companyId || !subscriptionId) {
    const error = new Error(
      "Moesif usage metrics require user, company, and subscription IDs"
    );
    error.code = "moesif_usage_identity_incomplete";
    throw error;
  }
  const params = new URLSearchParams({
    from: from || "-30d",
    to: to || "now",
  });
  const response = await fetch(
    `${moesifApiEndpoint}/v1/search/~/search/events?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${moesifManagementToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: {
          bool: {
            filter: [
              { term: { "user_id.raw": String(userId) } },
              { term: { "company_id.raw": String(companyId) } },
              { term: { "subscription_id.raw": String(subscriptionId) } },
            ],
          },
        },
        size: 0,
        aggs: {
          api_calls: {
            sum: { field: "metadata.api_call_quantity", missing: 0 },
          },
          records_returned: {
            sum: { field: "metadata.records_returned", missing: 0 },
          },
          aggregate_calls: {
            sum: { field: "metadata.aggregate_call_quantity", missing: 0 },
          },
          attachment_list: {
            sum: { field: "metadata.attachment_list_quantity", missing: 0 },
          },
          attachment_download: {
            sum: { field: "metadata.attachment_download_quantity", missing: 0 },
          },
        },
      }),
    }
  );
  return eventUsageMetricValues(
    await readMoesifResponse(response, "Moesif usage metrics lookup")
  );
}

async function createEmbeddedWorkspaceInfo({ companyId, workspaceId }) {
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
          // Built-in dynamic IDs are scalar values in Moesif's workspace API.
          // An array is accepted by the endpoint but does not match the
          // Dynamic Company ID sandbox criterion, producing an empty chart.
          values: { company_id: String(companyId) },
          from: from.toISOString(),
          to: to.toISOString(),
        },
      }),
    }
  );
  return readMoesifResponse(response, "Moesif embedded workspace token");
}

async function getInfoForEmbeddedWorkspaces({ companyId, workspaceId }) {
  const key = `${companyId}:${workspaceId}`;
  const cached = embedWorkspaceCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < EMBED_WORKSPACE_CACHE_TTL_MS) {
    return cached.info;
  }
  if (embedWorkspaceInflight.has(key)) return embedWorkspaceInflight.get(key);

  const promise = createEmbeddedWorkspaceInfo({ companyId, workspaceId })
    .then((info) => {
      if (embedWorkspaceCache.size >= EMBED_WORKSPACE_CACHE_MAX_ENTRIES) {
        embedWorkspaceCache.delete(embedWorkspaceCache.keys().next().value);
      }
      embedWorkspaceCache.set(key, { info, fetchedAt: Date.now() });
      return info;
    })
    .finally(() => embedWorkspaceInflight.delete(key));
  embedWorkspaceInflight.set(key, promise);
  return promise;
}

module.exports = {
  syncToMoesif,
  getPlansFromMoesif,
  getInfoForEmbeddedWorkspaces,
  sendPrepaidSubscriptionToMoesif,
  createMoesifBalanceTransaction,
  getMoesifUsageMetrics,
  getMoesifBillingReports,
  getMoesifPrepaidBalance,
  basicPrepaidSubscriptionId,
  eventUsageMetricValues,
  latestEndingBalance,
  normalizedBalance,
  readMoesifResponse,
};
