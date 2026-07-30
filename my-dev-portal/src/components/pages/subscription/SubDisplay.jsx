import React from "react";
import { formatIsoTimestamp, formatPrice } from "../../../common/utils";

const STATUS_LABELS = {
  active: "Active",
  trialing: "Trial",
  past_due: "Past due",
  canceled: "Canceled",
  cancelled: "Canceled",
  incomplete: "Incomplete",
  unpaid: "Unpaid",
};

function metricLabel(price) {
  const raw = price?.name || price?.nickname || "Usage";
  return raw.includes(" - ") ? raw.split(" - ").slice(1).join(" - ") : raw;
}

function planName(items, plans) {
  for (const item of items) {
    const found = plans.find((plan) => plan.id === item.plan_id);
    if (found?.name) return found.name;
    if (item.plan?.name) return item.plan.name;
  }
  return "Your subscription";
}

function lineRate(price) {
  const decimal = price?.price_in_decimal;
  if (decimal === null || decimal === undefined) return "Usage-based";
  const amount = formatPrice(decimal, price?.currency);
  return price?.pricing_model === "per_unit" ? `${amount} / unit` : amount;
}

/**
 * Renders one subscription as a single summary card: plan name, status, billing
 * period, the per-metric rates, and a single Manage billing action. Actual
 * plan changes are handled in the Stripe billing portal.
 */
function SubDisplay({ sub, plans, onManage }) {
  const items = sub?.items;
  if (!items || items.length === 0) return null;

  const status = String(sub.status || "active").toLowerCase();
  const isPurePrepaid = sub.billing_model === "prepaid_credit";
  const period = isPurePrepaid
    ? "Prepaid credit with no fixed billing period"
    : `${formatIsoTimestamp(sub.current_period_start)} – ${formatIsoTimestamp(
        sub.current_period_end
      )}`;

  const lines = items.map((item) => {
    const foundPlan = plans.find((plan) => plan.id === item.plan_id);
    const price =
      foundPlan?.prices?.find((p) => p.id === item.price_id) || item.price;
    return {
      key: `${item.plan_id}-${item.price_id}`,
      label: price ? metricLabel(price) : "Line item",
      rate: price ? lineRate(price) : "Unavailable",
      resolved: Boolean(price),
    };
  });

  return (
    <article className="subscription-card">
      <div className="subscription-card__header">
        <div>
          <h2>{planName(items, plans)}</h2>
          <span className="subscription-card__period">{period}</span>
        </div>
        <span className={`subscription-status subscription-status--${status}`}>
          {STATUS_LABELS[status] || sub.status}
        </span>
      </div>

      <ul className="subscription-card__lines">
        {lines.map((line) => (
          <li key={line.key}>
            <span className="subscription-card__metric">{line.label}</span>
            <span className="subscription-card__rate">{line.rate}</span>
          </li>
        ))}
      </ul>

      <div className="subscription-card__footer">
        <span className="subscription-card__hint">
          {isPurePrepaid
            ? "Add credit whenever you need it. There is no recurring charge or overage."
            : "Change or cancel your plan in the billing portal."}
        </span>
        <button
          className="button button--outline-secondary"
          onClick={onManage}
          disabled={!onManage}
        >
          {isPurePrepaid ? "Add credit" : "Manage billing"}
        </button>
      </div>
    </article>
  );
}

export default SubDisplay;
