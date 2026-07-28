import React from "react";

import useUsageSummary from "../../../hooks/useUsageSummary";

// Stripe amounts are in minor units (pence); format to the major currency unit.
function formatMoney(minorUnits, currency) {
  const value = (Number(minorUnits) || 0) / 100;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: (currency || "GBP").toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(unixSeconds) {
  if (!unixSeconds) return "";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(unixSeconds * 1000));
}

function UsageSummary({ idToken }) {
  const { usage, usageLoading } = useUsageSummary({ idToken });

  if (usageLoading && !usage) {
    return (
      <section className="usage-summary" aria-hidden="true">
        <div className="usage-summary__cards">
          <div className="usage-summary__metric usage-summary__skeleton" />
          <div className="usage-summary__metric usage-summary__skeleton" />
        </div>
      </section>
    );
  }

  if (!usage || !usage.hasSubscription) {
    return null;
  }

  const { currency, period, accrued, lines, credit } = usage;
  const usedPct =
    credit && credit.granted > 0
      ? Math.min(100, Math.round((credit.used / credit.granted) * 100))
      : 0;

  return (
    <section className="usage-summary">
      <div className="usage-summary__cards">
        <div className="usage-summary__metric">
          <span className="usage-summary__label">Usage this period</span>
          <span className="usage-summary__value">
            {formatMoney(accrued, currency)}
          </span>
          {period?.start && period?.end && (
            <span className="usage-summary__sub">
              {formatDate(period.start)} – {formatDate(period.end)}
            </span>
          )}
        </div>

        {credit && (
          <div className="usage-summary__metric">
            <span className="usage-summary__label">Credit remaining</span>
            <span className="usage-summary__value">
              {formatMoney(credit.remaining, currency)}
            </span>
            <span className="usage-summary__sub">
              {formatMoney(credit.used, currency)} of{" "}
              {formatMoney(credit.granted, currency)} used
            </span>
            <div
              className="usage-summary__bar"
              role="progressbar"
              aria-valuenow={usedPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span
                className="usage-summary__bar-fill"
                style={{ width: `${usedPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {lines && lines.length > 0 && (
        <div className="usage-summary__breakdown">
          <p className="usage-summary__breakdown-title">This period by metric</p>
          <ul>
            {lines.map((line, index) => (
              <li key={`${line.label}-${index}`}>
                <span className="usage-summary__metric-name">{line.label}</span>
                <span className="usage-summary__metric-usage">
                  {line.quantity != null && (
                    <span className="usage-summary__qty">
                      {line.quantity.toLocaleString()} units
                    </span>
                  )}
                  <span>{formatMoney(line.amount, currency)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default UsageSummary;
