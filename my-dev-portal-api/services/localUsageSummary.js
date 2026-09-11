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
  if (snapshot?.debit_owner !== "api" && snapshot?.usage?.balance_authority !== "local_ledger") return null;
  if (!["development", "basic", "growth", "enterprise", "test"].includes(snapshot.plan_key) || snapshot.currency !== "GBP") {
    throw summaryError();
  }
  const groups = snapshot.plan_key === "development" ? ["development"] : ["development", "commercial"];
  if (groups.some(group => !snapshot.balances?.[group])) throw summaryError();
  const balance = {};
  for (const field of ["granted_gbp_pence", "remaining_gbp_pence", "spendable_gbp_pence", "expired_gbp_pence"]) {
    balance[field] = groups.reduce((sum, group) => sum + nonnegative(snapshot.balances[group][field]), 0);
  }
  balance.eligible_gbp_pence = groups.reduce((sum, group) => {
    const part = snapshot.balances?.[group];
    return sum + nonnegative(part?.eligible_gbp_pence ?? Math.max(0, (part?.remaining_gbp_pence || 0) - (part?.expired_gbp_pence || 0)));
  }, 0);
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
      included: key !== "aggregate_call_quantity" || !["basic", "development"].includes(snapshot.plan_key),
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
    billingModel: snapshot.plan_key === "development" ? "development_allowance" : snapshot.billing_provider === "manual" ? "annual_commitment" : "prepaid_credit",
    debitOwner: snapshot.debit_owner,
    currency: "GBP",
    period: { start: unix(snapshot.usage?.from || snapshot.current_period_start), end: unix(snapshot.current_period_end || snapshot.usage?.to) },
    accrued,
    overage: nonnegative(snapshot.usage?.overage_gbp_pence ?? 0),
    lines,
    credit: { granted, used: Math.max(0, granted - totalRemaining), remaining, spendable, expired },
    balances: snapshot.balances,
    walletEnabled: snapshot.wallet_enabled === true,
    pricingEndsAt: snapshot.pricing_ends_at || null,
    paidCreditExpiresAt: snapshot.paid_credit_expires_at || null,
    historicalBalances: snapshot.historical_balances,
    accessBlockReason: snapshot.access_block_reason || null,
    analytics: { status: "ready", updatedAt: snapshot.as_of, source: snapshot.debit_owner === "api" ? "api_settled" : "local_ledger" },
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
    billing_provider: snapshot.billing_provider || "prepaid",
    billing_model: summary.billingModel,
    debit_owner: snapshot.debit_owner,
    has_activated_paid_plan: snapshot.has_activated_paid_plan,
    wallet_enabled: snapshot.wallet_enabled === true,
    pricing_ends_at: snapshot.pricing_ends_at || null,
    paid_credit_expires_at: snapshot.paid_credit_expires_at || null,
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
