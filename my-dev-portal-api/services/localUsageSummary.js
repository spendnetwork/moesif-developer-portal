const METRICS = [
  ["api_call_quantity", "API calls"],
  ["records_returned", "Records returned"],
  ["aggregate_call_quantity", "Aggregate calls"],
  ["attachment", "Attachments"],
];

function summaryError() {
  const error = new Error("The API credit ledger is temporarily unavailable");
  error.code = "local_ledger_unavailable";
  error.status = 503;
  return error;
}

function nonnegative(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw summaryError();
  return value;
}

function unix(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function localUsageSummary(snapshot) {
  if (snapshot?.debit_owner !== "api") return null;
  if (!["development", "basic"].includes(snapshot.plan_key) || snapshot.currency !== "GBP") {
    throw summaryError();
  }
  const group = snapshot.plan_key === "development" ? "development" : "commercial";
  const balance = snapshot.balances?.[group];
  const granted = nonnegative(balance?.granted_gbp_pence);
  const totalRemaining = nonnegative(balance?.remaining_gbp_pence);
  const spendable = nonnegative(balance?.spendable_gbp_pence);
  const expired = nonnegative(balance?.expired_gbp_pence);
  const remaining = balance.eligible_gbp_pence == null
    ? Math.max(0, totalRemaining - expired)
    : nonnegative(balance.eligible_gbp_pence);
  const accrued = nonnegative(snapshot.usage?.cost_gbp_pence);
  const costs = snapshot.usage?.cost_by_metric_gbp_pence;
  const cost = key => costs?.[key] == null ? null : nonnegative(costs[key]);
  const lines = METRICS.map(([key, label]) => {
    const fields = key === "attachment" ? ["attachment_list_quantity", "attachment_download_quantity"] : [key];
    const amounts = fields.map(cost);
    const rates = fields.map(field => nonnegative(snapshot.rate_card?.[field]));
    return {
      key,
      label,
      included: key !== "aggregate_call_quantity",
      rate: rates.every(rate => rate === rates[0]) ? rates[0] : null,
      quantity: fields.reduce((sum, field) => sum + nonnegative(snapshot.usage?.measurements?.[field]), 0),
      // Never reprice historical events at today's rate. Only the API settles cost.
      amount: amounts.every(amount => amount !== null) ? amounts.reduce((sum, amount) => sum + amount, 0) : null,
    };
  });
  return {
    hasSubscription: true,
    planKey: snapshot.plan_key,
    subscriptionId: snapshot.subscription_id,
    billingModel: snapshot.plan_key === "development" ? "development_allowance" : "prepaid_credit",
    debitOwner: "api",
    currency: "GBP",
    period: { start: unix(snapshot.usage?.from || snapshot.current_period_start), end: unix(snapshot.usage?.to) },
    accrued,
    lines,
    credit: { granted, used: Math.max(0, granted - totalRemaining), remaining, spendable, expired },
    balances: snapshot.balances,
    historicalBalances: snapshot.historical_balances,
    accessBlockReason: snapshot.access_block_reason || null,
    analytics: { status: "ready", updatedAt: snapshot.as_of, source: "api_settled" },
  };
}

function localSubscription(snapshot) {
  const summary = localUsageSummary(snapshot);
  if (!summary) return null;
  return {
    subscription_id: summary.subscriptionId,
    plan_key: summary.planKey,
    // Exhaustion blocks requests, not portal management or plan selection.
    status: "active",
    billing_provider: "prepaid",
    billing_model: summary.billingModel,
    debit_owner: "api",
    current_period_start: snapshot.current_period_start || null,
    current_period_end: snapshot.current_period_end || null,
    access_block_reason: summary.accessBlockReason,
    items: summary.lines.map((line) => ({
      price_id: line.key,
      included: line.included,
      price: { name: line.label, currency: "GBP", price_in_decimal: line.rate === null ? null : line.rate / 100, pricing_model: "per_unit" },
    })),
    balance: { available_balance: summary.credit.remaining },
  };
}

module.exports = { localUsageSummary, localSubscription };
