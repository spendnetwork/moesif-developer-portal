// Stale-while-revalidate cache (see stripeApis.js for the same pattern).
const BASIC_USAGE_FRESH_TTL_MS = 3 * 60 * 1000;
const BASIC_USAGE_STALE_TTL_MS = 30 * 60 * 1000;
const BASIC_USAGE_CACHE_MAX_ENTRIES = 1000;
const basicUsageCache = new Map();
const basicUsageInflight = new Map();
const {
  METRIC_LABELS,
  finiteNumber,
  metricKey,
  metricOrder,
  priceUnitAmountPence,
} = require("./usageMetrics");

function unixSeconds(value) {
  if (!value) return null;
  if (typeof value === "number") return value;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

function addOneMonth(unixSecondsValue) {
  const date = new Date(unixSecondsValue * 1000);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return Math.floor(date.getTime() / 1000);
}

function normalizeCollection(body, keys) {
  if (Array.isArray(body)) return body;
  for (const key of keys) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

function planKey(plan) {
  const metadata = plan?.metadata || {};
  return String(
    metadata.plan_key || metadata.tier || metadata.plan || plan?.name || ""
  ).toLowerCase();
}

function basicPriceDefinitions(planCatalogue) {
  const plans = normalizeCollection(planCatalogue, ["hits", "data", "plans"]);
  const basicPlan = plans.find((plan) => {
    const key = planKey(plan);
    return key === "basic" || key.includes("basic");
  });
  const prices = normalizeCollection(basicPlan?.prices, ["data", "prices"]);
  return new Map(
    prices
      .filter((price) => price?.id)
      .map((price) => {
        const key = metricKey(price);
        return [
          price.id,
          {
            key,
            label: METRIC_LABELS[key] || price.nickname || price.name || "Usage",
            unitAmountPence: priceUnitAmountPence(price),
          },
        ];
      })
  );
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

function summarizeMeterReports(reportBody, priceDefinitions) {
  const reports = normalizeCollection(reportBody, ["data", "reports"]).filter(
    (report) =>
      report &&
      report.success !== false &&
      (!report.type || String(report.type).toLowerCase() === "usage")
  );
  const grouped = new Map();
  for (const report of reports) {
    const key = report.price_id || report.billing_meter_id;
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(report);
  }

  const lines = [];
  for (const [priceId, definition] of priceDefinitions) {
    const entries = grouped.get(priceId) || [];
    entries.sort((left, right) => reportTimestamp(left) - reportTimestamp(right));
    const latest = entries[entries.length - 1] || null;

    const cumulative = finiteNumber(latest?.report_total_usage);
    const quantity =
      cumulative != null
        ? cumulative
        : entries.reduce(
            (total, report) => total + (finiteNumber(report.meter_usage) || 0),
            0
          );
    const reportedAmount = finiteNumber(latest?.amount);
    const amount =
      definition.unitAmountPence != null
        ? Math.round(quantity * definition.unitAmountPence)
        : Math.round((reportedAmount || 0) * 100);
    lines.push({
      key: definition.key,
      label: definition.label,
      rate: definition.unitAmountPence,
      quantity,
      amount,
    });
  }

  return lines.sort(metricOrder);
}

function buildBasicUsageSummary({
  balance,
  totalPurchasedPence,
  reports,
  planCatalogue,
  eventCount,
  analyticsAvailable = true,
  now = Date.now(),
}) {
  const hasBalance =
    balance.balanceAvailable !== false &&
    Number.isFinite(balance.available) &&
    Number.isFinite(balance.current);
  const remainingPence = hasBalance
    ? Math.max(0, Math.round(balance.available * 100))
    : null;
  const currentPence = hasBalance
    ? Math.max(0, Math.round(balance.current * 100))
    : null;
  const purchasedPence = Number.isFinite(totalPurchasedPence)
    ? Math.max(totalPurchasedPence, remainingPence || 0, currentPence || 0)
    : null;
  const usedPence =
    purchasedPence != null && remainingPence != null
      ? Math.max(0, purchasedPence - remainingPence)
      : null;
  const lines = analyticsAvailable
    ? summarizeMeterReports(reports, basicPriceDefinitions(planCatalogue))
    : [];
  const apiCalls = lines.find((line) => line.key === "api_call");
  const periodStart = unixSeconds(
    balance.subscription?.current_period_start ||
      balance.subscription?.subscription_period_start ||
      balance.subscription?.created_at
  );
  // The billing window is the monthly cycle, not "start .. now" (which collapses
  // to a single day on a fresh subscription). Prefer the cycle end from Moesif,
  // otherwise one month after the start.
  const periodEnd =
    unixSeconds(
      balance.subscription?.current_period_end ||
        balance.subscription?.subscription_period_end
    ) || (periodStart ? addOneMonth(periodStart) : Math.floor(now / 1000));

  return {
    hasSubscription: true,
    billingModel: "prepaid_credit",
    currency: balance.currency,
    period: {
      start: periodStart,
      end: periodEnd,
    },
    accrued: lines.reduce((total, line) => total + line.amount, 0),
    requestCount: Number.isFinite(eventCount)
      ? eventCount
      : apiCalls?.quantity ?? null,
    lines,
    credit: {
      available: hasBalance,
      granted: purchasedPence,
      used: usedPence,
      remaining: remainingPence,
      current: currentPence,
      pending:
        hasBalance && Number.isFinite(balance.pending)
          ? Math.round(balance.pending * 100)
          : null,
      projectedRemaining: remainingPence,
    },
  };
}

function cacheKey({ companyId, stripeCustomerId }) {
  return `${companyId}:${stripeCustomerId}`;
}

function setCached(key, summary) {
  const now = Date.now();
  if (basicUsageCache.size >= BASIC_USAGE_CACHE_MAX_ENTRIES) {
    for (const [candidate, value] of basicUsageCache) {
      if (now - value.fetchedAt >= BASIC_USAGE_STALE_TTL_MS) {
        basicUsageCache.delete(candidate);
      }
    }
    if (basicUsageCache.size >= BASIC_USAGE_CACHE_MAX_ENTRIES) {
      basicUsageCache.delete(basicUsageCache.keys().next().value);
    }
  }
  basicUsageCache.set(key, { summary, fetchedAt: now });
}

function invalidateBasicUsageSummary({ companyId, stripeCustomerId } = {}) {
  if (companyId && stripeCustomerId) {
    basicUsageCache.delete(cacheKey({ companyId, stripeCustomerId }));
    return;
  }
  basicUsageCache.clear();
}

async function computeBasicPrepaidUsageSummary(context, deps) {
  const balance = await deps.getMoesifPrepaidBalance(context);
  const from =
    balance.subscription?.current_period_start ||
    balance.subscription?.subscription_period_start ||
    balance.subscription?.created_at;
  const analytics = await Promise.allSettled([
    deps.getBasicTopUpTotalPence(context.stripeCustomerId),
    deps.getMoesifBillingReports({
      companyId: context.companyId,
      subscriptionId: balance.subscriptionId,
      from,
      to: new Date().toISOString(),
    }),
    deps.getPlansFromMoesif(),
    deps.getMoesifEventCount({
      companyId: context.companyId,
      from,
      to: "now",
    }),
  ]);
  const failures = analytics.filter((result) => result.status === "rejected");
  if (failures.length) {
    console.error(
      "Basic usage analytics partially unavailable",
      failures.map((result) => result.reason?.code || result.reason?.message)
    );
  }
  const summary = buildBasicUsageSummary({
    balance,
    totalPurchasedPence:
      analytics[0].status === "fulfilled" ? analytics[0].value : null,
    reports: analytics[1].status === "fulfilled" ? analytics[1].value : [],
    planCatalogue:
      analytics[2].status === "fulfilled" ? analytics[2].value : [],
    eventCount:
      analytics[3].status === "fulfilled" ? analytics[3].value : null,
    analyticsAvailable:
      analytics[1].status === "fulfilled" && analytics[2].status === "fulfilled",
  });
  return summary;
}

function refreshBasicPrepaidUsageSummary(key, context, deps) {
  if (basicUsageInflight.has(key)) return basicUsageInflight.get(key);
  const promise = computeBasicPrepaidUsageSummary(context, deps)
    .then((summary) => {
      setCached(key, summary);
      return summary;
    })
    .finally(() => basicUsageInflight.delete(key));
  basicUsageInflight.set(key, promise);
  return promise;
}

// Stale-while-revalidate: serve cached instantly, refresh in the background.
async function getBasicPrepaidUsageSummary(context, deps) {
  const key = cacheKey(context);
  const cached = basicUsageCache.get(key);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;

  if (cached && age < BASIC_USAGE_FRESH_TTL_MS) {
    return cached.summary;
  }
  if (cached && age < BASIC_USAGE_STALE_TTL_MS) {
    refreshBasicPrepaidUsageSummary(key, context, deps).catch((error) =>
      console.error("Basic usage background refresh failed:", error.message)
    );
    return cached.summary;
  }
  return refreshBasicPrepaidUsageSummary(key, context, deps);
}

module.exports = {
  basicPriceDefinitions,
  buildBasicUsageSummary,
  getBasicPrepaidUsageSummary,
  invalidateBasicUsageSummary,
  summarizeMeterReports,
};
