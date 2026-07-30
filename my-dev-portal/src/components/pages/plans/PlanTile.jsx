import React from "react";

import { formatPrice } from "../../../common/utils";

const PLAN_DETAILS = {
  basic: {
    label: "Basic",
    commitment: "Flexible prepaid credit",
    note: "Choose any top-up amount. Usage stops at zero credit, with no overage bill.",
  },
  growth: {
    label: "Growth",
    commitment: "\u00a35,000 prepaid commitment",
    note: "Usage draws down your commitment; overage is billed in arrears.",
  },
  enterprise: {
    label: "Enterprise",
    commitment: "\u00a312,000 prepaid commitment",
    note: "Usage draws down your commitment; overage is billed in arrears.",
  },
};

function priceLabel(price) {
  const raw = price?.name || price?.nickname || "Usage";
  return raw.includes(" - ") ? raw.split(" - ").slice(1).join(" - ") : raw;
}

function unitRate(price) {
  const decimal =
    price?.price_in_decimal ?? price?.tiers?.[0]?.unit_price_in_decimal;
  if (decimal === null || decimal === undefined) return null;
  return formatPrice(decimal, price?.currency);
}

function PlanTile({ plan, planKey, actionButton }) {
  const details = PLAN_DETAILS[planKey] || {};
  const prices = plan?.prices || [];

  return (
    <div className="plan-tile">
      <div className="plan-tile__header">
        <span className="plan-tile__name">{details.label || plan?.name}</span>
        {details.commitment && (
          <span className="plan-tile__commitment">{details.commitment}</span>
        )}
      </div>
      <ul className="plan-tile__rates">
        {prices.map((price) => {
          const rate = unitRate(price);
          return (
            <li key={price.id}>
              <span className="plan-tile__metric">{priceLabel(price)}</span>
              <span className="plan-tile__rate">
                {rate ? `${rate} / unit` : "Usage-based"}
              </span>
            </li>
          );
        })}
      </ul>
      {details.note && <p className="plan-tile__note">{details.note}</p>}
      <div className="plan--bottom">{actionButton}</div>
    </div>
  );
}

export default PlanTile;
