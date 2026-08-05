// Stale-while-revalidate cache (see stripeApis.js for the same pattern).
const BASIC_USAGE_FRESH_TTL_MS = 10 * 1000;
const BASIC_USAGE_STALE_TTL_MS = 5 * 60 * 1000;
const BASIC_USAGE_CACHE_MAX_ENTRIES = 1000;
const basicUsageCache = new Map();
const basicUsageInflight = new Map();
const BASIC_REFERENCE_FRESH_TTL_MS = 3 * 60 * 1000;
const BASIC_REFERENCE_STALE_TTL_MS = 30 * 60 * 1000;
const basicReferenceCache = new Map();
const basicReferenceInflight = new Map();
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
      reported: entries.length > 0,
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
  eventCountAvailable = Number.isFinite(eventCount),
  analyticsErrors = [],
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
  const meterLines = analyticsAvailable
    ? summarizeMeterReports(reports, basicPriceDefinitions(planCatalogue))
    : [];
  const reportedMeterCount = meterLines.filter((line) => line.reported).length;
  const lines = meterLines.map(({ reported: _reported, ...line }) => line);
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
  const reportsPending =
    analyticsAvailable &&
    eventCountAvailable &&
    Number(eventCount) > 0 &&
    reportedMeterCount === 0;
  const unavailableSourceCount = [analyticsAvailable, eventCountAvailable].filter(
    (available) => !available
  ).length;
  const analyticsStatus = unavailableSourceCount
    ? unavailableSourceCount === 2
      ? "unavailable"
      : "partial"
    : reportsPending
      ? "pending"
      : "ready";

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
    analytics: {
      status: analyticsStatus,
      stale: false,
      updatedAt: new Date(now).toISOString(),
      sources: {
        billingReports: analyticsAvailable
          ? reportsPending
            ? "pending"
            : "ready"
          : "unavailable",
        events: eventCountAvailable ? "ready" : "unavailable",
      },
      errors: [...new Set(analyticsErrors.filter(Boolean))],
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

function setReferenceCached(key, reference) {
  const now = Date.now();
  if (basicReferenceCache.size >= BASIC_USAGE_CACHE_MAX_ENTRIES) {
    for (const [candidate, value] of basicReferenceCache) {
      if (now - value.fetchedAt >= BASIC_REFERENCE_STALE_TTL_MS) {
        basicReferenceCache.delete(candidate);
      }
    }
    if (basicReferenceCache.size >= BASIC_USAGE_CACHE_MAX_ENTRIES) {
      basicReferenceCache.delete(basicReferenceCache.keys().next().value);
    }
  }
  basicReferenceCache.set(key, { reference, fetchedAt: now });
}

async function computeBasicReferenceData(context, deps) {
  const results = await Promise.allSettled([
    deps.getBasicTopUpTotalPence(context.stripeCustomerId),
    deps.getPlansFromMoesif(),
  ]);
  return {
    totalPurchasedPence:
      results[0].status === "fulfilled" ? results[0].value : null,
    purchaseTotalAvailable: results[0].status === "fulfilled",
    planCatalogue: results[1].status === "fulfilled" ? results[1].value : [],
    plansAvailable: results[1].status === "fulfilled",
    failures: results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason),
  };
}

function refreshBasicReferenceData(key, context, deps) {
  if (basicReferenceInflight.has(key)) return basicReferenceInflight.get(key);
  const promise = computeBasicReferenceData(context, deps)
    .then((reference) => {
      setReferenceCached(key, reference);
      return reference;
    })
    .finally(() => basicReferenceInflight.delete(key));
  basicReferenceInflight.set(key, promise);
  return promise;
}

async function getBasicReferenceData(context, deps) {
  const key = context.stripeCustomerId;
  const cached = basicReferenceCache.get(key);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && age < BASIC_REFERENCE_FRESH_TTL_MS) {
    return cached.reference;
  }
  if (cached && age < BASIC_REFERENCE_STALE_TTL_MS) {
    refreshBasicReferenceData(key, context, deps).catch((error) =>
      console.error("Basic reference refresh failed:", error.message)
    );
    return cached.reference;
  }
  return refreshBasicReferenceData(key, context, deps);
}

function invalidateBasicUsageSummary({ companyId, stripeCustomerId } = {}) {
  if (companyId && stripeCustomerId) {
    basicUsageCache.delete(cacheKey({ companyId, stripeCustomerId }));
    basicReferenceCache.delete(stripeCustomerId);
    return;
  }
  basicUsageCache.clear();
  basicReferenceCache.clear();
}

async function computeBasicPrepaidUsageSummary(context, deps) {
  const [balance, reference] = await Promise.all([
    deps.getMoesifPrepaidBalance(context),
    getBasicReferenceData(context, deps),
  ]);
  const from =
    balance.subscription?.current_period_start ||
    balance.subscription?.subscription_period_start ||
    balance.subscription?.created_at;
  const analytics = await Promise.allSettled([
    deps.getMoesifBillingReports({
      companyId: context.companyId,
      subscriptionId: balance.subscriptionId,
      from,
      to: new Date().toISOString(),
    }),
    deps.getMoesifEventCount({
      companyId: context.companyId,
      from,
      to: "now",
    }),
  ]);
  const failures = [
    ...reference.failures,
    ...analytics
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason),
  ];
  if (failures.length) {
    console.error(
      "Basic usage analytics partially unavailable",
      failures.map((error) => error?.code || error?.message)
    );
  }
  const summary = buildBasicUsageSummary({
    balance,
    totalPurchasedPence: reference.totalPurchasedPence,
    reports: analytics[0].status === "fulfilled" ? analytics[0].value : [],
    planCatalogue: reference.planCatalogue,
    eventCount:
      analytics[1].status === "fulfilled" ? analytics[1].value : null,
    analyticsAvailable:
      analytics[0].status === "fulfilled" && reference.plansAvailable,
    eventCountAvailable: analytics[1].status === "fulfilled",
    analyticsErrors: failures.map(
      (error) => error?.code || "usage_dependency_unavailable"
    ),
  });
  return summary;
}

function preserveLastKnownAnalytics(summary, previous) {
  if (!previous || summary?.period?.start !== previous?.period?.start) {
    return summary;
  }

  const sources = summary.analytics?.sources || {};
  const preserveReports =
    sources.billingReports === "unavailable" ||
    (sources.billingReports === "pending" && previous.lines?.length > 0);
  const preserveEvents =
    sources.events === "unavailable" && Number.isFinite(previous.requestCount);
  if (!preserveReports && !preserveEvents) return summary;

  return {
    ...summary,
    ...(preserveReports
      ? { lines: previous.lines, accrued: previous.accrued }
      : {}),
    ...(preserveEvents ? { requestCount: previous.requestCount } : {}),
    analytics: {
      ...summary.analytics,
      stale: true,
      lastSuccessfulAt:
        previous.analytics?.updatedAt || previous.analytics?.lastSuccessfulAt,
    },
  };
}

function refreshBasicPrepaidUsageSummary(key, context, deps) {
  if (basicUsageInflight.has(key)) return basicUsageInflight.get(key);
  const previous = basicUsageCache.get(key)?.summary;
  const promise = computeBasicPrepaidUsageSummary(context, deps)
    .then((summary) => {
      const resilientSummary = preserveLastKnownAnalytics(summary, previous);
      setCached(key, resilientSummary);
      return resilientSummary;
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
  preserveLastKnownAnalytics,
  summarizeMeterReports,
};
