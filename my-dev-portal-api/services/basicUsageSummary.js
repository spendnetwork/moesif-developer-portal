const BASIC_USAGE_CACHE_TTL_MS = 45 * 1000;
const BASIC_USAGE_CACHE_MAX_ENTRIES = 1000;
const basicUsageCache = new Map();

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function metricKey(price) {
  const metadata = price?.metadata || {};
  const explicit =
    metadata.usage_metric ||
    metadata.billable_metric ||
    metadata.unit_name ||
    metadata.price_key;
  const source = String(explicit || price?.nickname || price?.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (source.includes("aggregate")) return "aggregate_call";
  if (source.includes("attachment")) return "attachment";
  if (source.includes("record") || source.includes("document")) {
    return "records_returned";
  }
  if (source.includes("api_call") || source.includes("api_calls")) {
    return "api_call";
  }
  return source;
}

const METRIC_LABELS = {
  api_call: "API calls",
  records_returned: "Records returned",
  aggregate_call: "Aggregate calls",
  attachment: "Attachments",
};

function priceUnitAmountPence(price) {
  const minorUnits = finiteNumber(
    price?.unit_amount_decimal ?? price?.unit_amount
  );
  if (minorUnits != null) return minorUnits;
  const majorUnits = finiteNumber(price?.price_in_decimal);
  return majorUnits == null ? null : majorUnits * 100;
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
  for (const entries of grouped.values()) {
    entries.sort((left, right) => reportTimestamp(left) - reportTimestamp(right));
    const latest = entries[entries.length - 1];
    const definition = priceDefinitions.get(latest.price_id);
    if (!definition) continue;

    const cumulative = finiteNumber(latest.report_total_usage);
    const quantity =
      cumulative != null
        ? cumulative
        : entries.reduce(
            (total, report) => total + (finiteNumber(report.meter_usage) || 0),
            0
          );
    const reportedAmount = finiteNumber(latest.amount);
    const amount =
      definition.unitAmountPence != null
        ? Math.round(quantity * definition.unitAmountPence)
        : Math.round((reportedAmount || 0) * 100);
    lines.push({
      key: definition.key,
      label: definition.label,
      quantity,
      amount,
    });
  }

  const order = ["api_call", "records_returned", "aggregate_call", "attachment"];
  return lines.sort(
    (left, right) => order.indexOf(left.key) - order.indexOf(right.key)
  );
}

function buildBasicUsageSummary({
  balance,
  totalPurchasedPence,
  reports,
  planCatalogue,
  analyticsAvailable = true,
  now = Date.now(),
}) {
  const remainingPence = Math.max(0, Math.round((balance.available || 0) * 100));
  const currentPence = Math.max(0, Math.round((balance.current || 0) * 100));
  const purchasedPence = Math.max(
    remainingPence,
    currentPence,
    Number.isFinite(totalPurchasedPence) ? totalPurchasedPence : 0
  );
  const usedPence = Math.max(0, purchasedPence - remainingPence);
  const lines = analyticsAvailable
    ? summarizeMeterReports(reports, basicPriceDefinitions(planCatalogue))
    : [];
  const apiCalls = lines.find((line) => line.key === "api_call");
  const periodStart = unixSeconds(
    balance.subscription?.current_period_start ||
      balance.subscription?.subscription_period_start ||
      balance.subscription?.created_at
  );

  return {
    hasSubscription: true,
    billingModel: "prepaid_credit",
    currency: balance.currency,
    period: {
      start: periodStart,
      end: Math.floor(now / 1000),
    },
    accrued: lines.reduce((total, line) => total + line.amount, 0),
    requestCount: analyticsAvailable ? apiCalls?.quantity || 0 : null,
    lines,
    credit: {
      granted: purchasedPence,
      used: usedPence,
      remaining: remainingPence,
      current: currentPence,
      pending: Math.round((balance.pending || 0) * 100),
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
      if (now - value.fetchedAt >= BASIC_USAGE_CACHE_TTL_MS) {
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

async function getBasicPrepaidUsageSummary(context, deps) {
  const key = cacheKey(context);
  const cached = basicUsageCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < BASIC_USAGE_CACHE_TTL_MS) {
    return cached.summary;
  }

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
    analyticsAvailable:
      analytics[1].status === "fulfilled" && analytics[2].status === "fulfilled",
  });
  setCached(key, summary);
  return summary;
}

module.exports = {
  basicPriceDefinitions,
  buildBasicUsageSummary,
  getBasicPrepaidUsageSummary,
  invalidateBasicUsageSummary,
  summarizeMeterReports,
};
