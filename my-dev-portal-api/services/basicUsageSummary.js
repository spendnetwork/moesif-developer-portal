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
  summarizeEventUsage,
} = require("./usageMetrics");

function unixSeconds(value) {
  if (!value) return null;
  if (typeof value === "number") return value;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
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

function subscriptionPriceIds(subscription) {
  const items = normalizeCollection(subscription?.items, ["data", "items"]);
  return new Set(
    items
      .map((item) =>
        typeof item?.price === "string"
          ? item.price
          : item?.price_id || item?.price?.id
      )
      .filter(Boolean)
  );
}

function subscriptionPlanIds(subscription) {
  const items = normalizeCollection(subscription?.items, ["data", "items"]);
  return new Set(
    items
      .map((item) =>
        typeof item?.plan === "string"
          ? item.plan
          : item?.plan_id || item?.plan?.id
      )
      .filter(Boolean)
  );
}

function basicPriceDefinitions(
  planCatalogue,
  allowedPriceIds = null,
  requestedPlanKey = "basic",
  allowedPlanIds = null
) {
  const plans = normalizeCollection(planCatalogue, ["hits", "data", "plans"]);
  const requested = String(requestedPlanKey || "").toLowerCase();
  const basicPlan = plans
    .filter((plan) => {
      const key = planKey(plan);
      return key === requested || key.includes(requested);
    })
    .map((plan) => ({
      plan,
      exactSubscriptionMatch: allowedPlanIds?.has(plan?.id) ? 1 : 0,
      meteredPriceCount: normalizeCollection(plan?.prices, ["data", "prices"])
        .filter(
          (price) =>
            price?.active !== false && priceUnitAmountPence(price) != null
        ).length,
    }))
    .sort(
      (left, right) =>
        right.exactSubscriptionMatch - left.exactSubscriptionMatch ||
        right.meteredPriceCount - left.meteredPriceCount
    )[0]?.plan;
  const prices = normalizeCollection(basicPlan?.prices, ["data", "prices"]);
  const definitions = new Map();
  const seenMetrics = new Set();
  const candidates = prices
    .filter(
      (price) =>
        price?.id &&
        (price.active !== false || allowedPriceIds?.has(price.id)) &&
        (!price.currency || String(price.currency).toLowerCase() === "gbp") &&
        (!allowedPriceIds?.size || allowedPriceIds.has(price.id))
    )
    .sort((left, right) => Number(right.created || 0) - Number(left.created || 0));
  for (const price of candidates) {
    const key = metricKey(price);
    if (!METRIC_LABELS[key] || seenMetrics.has(key)) continue;
    seenMetrics.add(key);
    definitions.set(price.id, {
      key,
      label: METRIC_LABELS[key],
      unitAmountPence: priceUnitAmountPence(price),
    });
  }
  return definitions;
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
  eventMetrics = null,
  analyticsAvailable = true,
  eventMetricsAvailable = eventMetrics != null,
  analyticsErrors = [],
  planKey: requestedPlanKey = "basic",
  billingModel = "prepaid_credit",
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
  const paidPurchasedPence = Number.isFinite(totalPurchasedPence)
    ? Math.max(0, Math.round(totalPurchasedPence))
    : null;
  const priceDefinitions = basicPriceDefinitions(
    planCatalogue,
    subscriptionPriceIds(balance.subscription),
    requestedPlanKey,
    subscriptionPlanIds(balance.subscription)
  );
  const hasPriceDefinitions = priceDefinitions.size > 0;
  const reportLines = analyticsAvailable
    ? summarizeMeterReports(reports, priceDefinitions)
    : [];
  const lines = eventMetricsAvailable && hasPriceDefinitions
    ? summarizeEventUsage(eventMetrics, priceDefinitions)
    : reportLines.map(({ reported: _reported, ...line }) => line);
  const accruedPence = hasPriceDefinitions
    ? lines.reduce((total, line) => total + line.amount, 0)
    : null;
  // Reconstruct total granted credit from the live Moesif balance plus usage.
  // This includes promotional credit without pretending it was purchased.
  const balanceBackedGrantedPence =
    hasBalance &&
    Number.isFinite(accruedPence) &&
    (paidPurchasedPence != null || eventMetricsAvailable)
      ? remainingPence + accruedPence
      : null;
  const grantedPence =
    billingModel === "prepaid_commitment" && paidPurchasedPence != null
      ? paidPurchasedPence
      : [paidPurchasedPence, balanceBackedGrantedPence]
          .filter(Number.isFinite)
          .reduce((highest, value) => Math.max(highest, value), null);
  const usedPence =
    grantedPence != null && Number.isFinite(accruedPence) ? accruedPence : null;
  const projectedRemainingPence =
    grantedPence != null && Number.isFinite(accruedPence)
      ? Math.max(0, grantedPence - accruedPence)
      : remainingPence;
  const periodStart = unixSeconds(
    balance.subscription?.current_period_start ||
      balance.subscription?.subscription_period_start ||
      balance.subscription?.created_at
  );
  // Basic credit has no recurring billing period. Its usage window starts when
  // prepaid access is activated and ends at the time of this snapshot.
  const periodEnd =
    billingModel === "prepaid_credit"
      ? Math.floor(now / 1000)
      : unixSeconds(balance.subscription?.current_period_end) ||
        Math.floor(now / 1000);
  const reportsAvailable =
    analyticsAvailable && reportLines.some((line) => line.reported);
  const analyticsStatus = eventMetricsAvailable && hasPriceDefinitions
    ? "ready"
    : reportsAvailable
      ? "partial"
      : "unavailable";

  return {
    hasSubscription: true,
    billingModel,
    currency: balance.currency,
    period: {
      start: periodStart,
      end: periodEnd,
    },
    accrued: accruedPence,
    lines,
    credit: {
      available: hasBalance,
      granted: grantedPence,
      used: usedPence,
      remaining: projectedRemainingPence,
      postedRemaining: remainingPence,
      current: currentPence,
      pending:
        hasBalance && Number.isFinite(balance.pending)
          ? Math.round(balance.pending * 100)
          : null,
      projectedRemaining: projectedRemainingPence,
    },
    analytics: {
      status: analyticsStatus,
      stale: false,
      updatedAt: new Date(now).toISOString(),
      sources: {
        billingReports: reportsAvailable ? "ready" : "unavailable",
        events: eventMetricsAvailable ? "ready" : "unavailable",
      },
      errors: [
        ...new Set(
          [
            ...analyticsErrors,
            hasPriceDefinitions ? null : "moesif_plan_prices_missing",
          ].filter(Boolean)
        ),
      ],
    },
  };
}

function cacheKey({ userId, companyId, stripeCustomerId }) {
  return `${userId}:${companyId}:${stripeCustomerId}`;
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

function invalidateBasicUsageSummary() {
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
    deps.getMoesifUsageMetrics({
      userId: context.userId,
      companyId: context.companyId,
      subscriptionId: balance.subscriptionId,
      from,
      to: "now",
    }),
    deps.getMoesifBillingReports({
      companyId: context.companyId,
      subscriptionId: balance.subscriptionId,
      from,
      to: new Date().toISOString(),
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
    reports: analytics[1].status === "fulfilled" ? analytics[1].value : [],
    planCatalogue: reference.planCatalogue,
    eventMetrics:
      analytics[0].status === "fulfilled" ? analytics[0].value : null,
    analyticsAvailable:
      analytics[1].status === "fulfilled" && reference.plansAvailable,
    eventMetricsAvailable:
      analytics[0].status === "fulfilled" && reference.plansAvailable,
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
  const preserveEventSnapshot =
    sources.events === "unavailable" && previous.lines?.length > 0;
  if (!preserveEventSnapshot) return summary;

  return {
    ...summary,
    lines: previous.lines,
    accrued: previous.accrued,
    credit: {
      ...summary.credit,
      used: previous.accrued,
      remaining:
        Number.isFinite(summary.credit?.granted)
          ? Math.max(0, summary.credit.granted - previous.accrued)
          : summary.credit?.remaining,
      projectedRemaining:
        Number.isFinite(summary.credit?.granted)
          ? Math.max(0, summary.credit.granted - previous.accrued)
          : summary.credit?.projectedRemaining,
    },
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

async function getManualPrepaidUsageSummary(context, deps) {
  const balance = await deps.getMoesifSubscriptionBalance({
    companyId: context.companyId,
    subscriptionId: context.subscriptionId,
  });
  const from =
    balance.subscription?.current_period_start ||
    balance.subscription?.subscription_period_start ||
    balance.subscription?.created_at;
  const results = await Promise.allSettled([
    deps.getMoesifUsageMetrics({
      userId: context.userId,
      companyId: context.companyId,
      subscriptionId: context.subscriptionId,
      from,
      to: "now",
    }),
    deps.getMoesifBillingReports({
      companyId: context.companyId,
      subscriptionId: context.subscriptionId,
      from,
      to: new Date().toISOString(),
    }),
    deps.getPlansFromMoesif("custom"),
  ]);
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  return buildBasicUsageSummary({
    balance,
    totalPurchasedPence: context.commitmentAmountPence,
    reports: results[1].status === "fulfilled" ? results[1].value : [],
    planCatalogue: results[2].status === "fulfilled" ? results[2].value : [],
    eventMetrics: results[0].status === "fulfilled" ? results[0].value : null,
    analyticsAvailable:
      results[1].status === "fulfilled" && results[2].status === "fulfilled",
    eventMetricsAvailable:
      results[0].status === "fulfilled" && results[2].status === "fulfilled",
    analyticsErrors: failures.map(
      (error) => error?.code || "usage_dependency_unavailable"
    ),
    planKey: context.planKey,
    billingModel: "prepaid_commitment",
  });
}

module.exports = {
  basicPriceDefinitions,
  buildBasicUsageSummary,
  getBasicPrepaidUsageSummary,
  getManualPrepaidUsageSummary,
  invalidateBasicUsageSummary,
  preserveLastKnownAnalytics,
  summarizeMeterReports,
};
