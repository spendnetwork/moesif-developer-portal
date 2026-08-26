import React from "react";
import { formatIsoTimestamp, formatPrice } from "../../../common/utils";

const C = {
  head: "#23383A",
  body: "#23302C",
  muted: "#647873",
  line: "#DDE5E0",
  lineSoft: "#EEF2EF",
};

const STATUS_LABELS = {
  active: "Active",
  trialing: "Trial",
  past_due: "Past due",
  canceled: "Canceled",
  cancelled: "Canceled",
  incomplete: "Incomplete",
  unpaid: "Unpaid",
};

const STATUS_TONE = {
  active: { color: "#17633C", background: "#E3F5E9", border: "#C4E7D2" },
  trialing: { color: "#17633C", background: "#E3F5E9", border: "#C4E7D2" },
  past_due: { color: "#725300", background: "#FFF1B8", border: "#EFDE96" },
  unpaid: { color: "#725300", background: "#FFF1B8", border: "#EFDE96" },
  incomplete: { color: "#725300", background: "#FFF1B8", border: "#EFDE96" },
  canceled: { color: "#8B2C21", background: "#FDE8E5", border: "#F5CFC9" },
  cancelled: { color: "#8B2C21", background: "#FDE8E5", border: "#F5CFC9" },
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

function SubDisplay({ sub, plans, onManage }) {
  const items = sub?.items;
  if (!items || items.length === 0) return null;

  const status = String(sub.status || "active").toLowerCase();
  const tone = STATUS_TONE[status] || STATUS_TONE.active;
  const isPurePrepaid = sub.billing_model === "prepaid_credit";
  const isManualCommitment = sub.billing_model === "prepaid_commitment";
  const period = isPurePrepaid
    ? "Prepaid credit — no fixed billing period"
    : `Billing period ${formatIsoTimestamp(
        sub.current_period_start
      )} – ${formatIsoTimestamp(sub.current_period_end)}`;

  const lines = items.map((item) => {
    const foundPlan = plans.find((plan) => plan.id === item.plan_id);
    const price =
      foundPlan?.prices?.find((p) => p.id === item.price_id) || item.price;
    return {
      key: `${item.plan_id}-${item.price_id}`,
      label: price ? metricLabel(price) : "Line item",
      rate: price ? lineRate(price) : "Unavailable",
    };
  });

  return (
    <article style={styles.card}>
      <div style={styles.header}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 18, fontWeight: 500, color: C.head }}>
              {planName(items, plans)}
            </span>
            <span
              style={{
                fontSize: 11.5,
                color: tone.color,
                background: tone.background,
                border: `1px solid ${tone.border}`,
                padding: "3px 9px",
                borderRadius: 999,
              }}
            >
              {STATUS_LABELS[status] || sub.status}
            </span>
          </div>
          <div style={{ fontSize: 13.5, color: C.muted }}>{period}</div>
        </div>
        <button
          type="button"
          onClick={onManage}
          disabled={!onManage}
          className={isPurePrepaid || isManualCommitment ? "btn-outline" : "btn-solid"}
          style={isPurePrepaid || isManualCommitment ? styles.outlineBtn : styles.primaryBtn}
        >
          {isPurePrepaid
            ? "Add credit"
            : isManualCommitment
              ? "Contact billing"
              : "Manage billing"}
        </button>
      </div>

      <div style={styles.rateGrid}>
        {lines.map((line) => (
          <div key={line.key} style={styles.rateItem}>
            <span style={styles.rateLabel}>{line.label}</span>
            <span style={styles.rateValue}>{line.rate}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

const styles = {
  card: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 24,
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 24,
    marginBottom: 20,
  },
  rateGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
    gap: 20,
    paddingTop: 20,
    borderTop: `1px solid ${C.lineSoft}`,
  },
  rateItem: { display: "flex", flexDirection: "column", gap: 5 },
  rateLabel: {
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: C.muted,
  },
  rateValue: {
    fontSize: 14,
    color: C.body,
    fontVariantNumeric: "tabular-nums",
  },
  primaryBtn: {
    fontSize: 14,
    fontWeight: 500,
    padding: "10px 16px",
    borderRadius: 8,
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  outlineBtn: {
    fontSize: 14,
    fontWeight: 500,
    padding: "10px 16px",
    borderRadius: 8,
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
};

export default SubDisplay;
