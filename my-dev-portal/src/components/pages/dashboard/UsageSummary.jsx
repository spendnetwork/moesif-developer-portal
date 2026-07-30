import React, { useState } from "react";
import { Link } from "react-router-dom";

import useUsageSummary from "../../../hooks/useUsageSummary";
import usePlanChange from "../../../hooks/usePlanChange";
import { apiRequest } from "../../../lib/portal-api";

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

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function UsageSummary({ idToken }) {
  const { usage, usageLoading } = useUsageSummary({ idToken });
  const { planChange, refreshPlanChange } = usePlanChange({ idToken });
  const [cancellingChange, setCancellingChange] = useState(false);
  const [planChangeError, setPlanChangeError] = useState("");

  async function cancelPlanChange() {
    setCancellingChange(true);
    setPlanChangeError("");
    try {
      await apiRequest("/plan-change", idToken, { method: "DELETE" });
      await refreshPlanChange();
    } catch (error) {
      setPlanChangeError(error.message);
    } finally {
      setCancellingChange(false);
    }
  }

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

  const {
    currency,
    period,
    accrued,
    lines,
    credit,
    billingModel,
    requestCount,
  } = usage;
  const isPurePrepaid = billingModel === "prepaid_credit";
  const displayedAccrued = Array.isArray(lines)
    ? lines.reduce(
        (total, line) => total + Math.max(0, Number(line.amount) || 0),
        0
      )
    : accrued;
  const usedPct =
    credit && credit.granted > 0
      ? Math.min(100, Math.round((credit.used / credit.granted) * 100))
      : 0;
  // Includes the finalised used portion plus this period's projected drawdown.
  const projectedPct =
    credit && credit.granted > 0
      ? Math.min(
          100,
          Math.round(
            ((credit.granted - credit.projectedRemaining) / credit.granted) *
              100
          )
        )
      : 0;
  const showProjection =
    credit && credit.projectedRemaining < credit.remaining;

  return (
    <section className="usage-summary">
      {planChange && (
        <div className={`plan-change-notice plan-change-notice--${planChange.status}`}>
          <div>
            <strong>
              {planChange.status === "payment_failed"
                ? "Payment required"
                : `${planChange.to_plan_key} plan scheduled`}
            </strong>
            <p>
              {planChange.status === "payment_failed"
                ? "We could not collect the payment required to complete your plan change. Your current plan remains active."
                : `Your current ${planChange.from_plan_key} plan remains active until ${new Date(
                    planChange.effective_at
                  ).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}. The new plan activates only after the required payments succeed.`}
            </p>
          </div>
          <div className="plan-change-notice__actions">
            <span>{planChange.status.replaceAll("_", " ")}</span>
            {["scheduled", "awaiting_current_invoice", "payment_failed"].includes(
              planChange.status
            ) && (
              <button
                className="button button--outline-secondary"
                onClick={cancelPlanChange}
                disabled={cancellingChange}
              >
                {cancellingChange ? "Cancelling..." : "Cancel change"}
              </button>
            )}
            {planChange.status === "payment_failed" && (
              <Link to="/billing" className="button button--primary">
                Resolve payment
              </Link>
            )}
          </div>
        </div>
      )}
      {planChangeError && <div className="keys-error">{planChangeError}</div>}
      <div className="usage-summary__cards">
        {isPurePrepaid ? (
          <div className="usage-summary__metric">
            <span className="usage-summary__label">API requests</span>
            <span className="usage-summary__value">
              {requestCount == null ? "Updating" : formatCount(requestCount)}
            </span>
            <span className="usage-summary__sub">
              {period?.start
                ? `Since ${formatDate(period.start)}`
                : "Across all API keys in your company"}
            </span>
          </div>
        ) : (
          <div className="usage-summary__metric">
          <span className="usage-summary__label">Usage this period</span>
          <span className="usage-summary__value">
            {formatMoney(displayedAccrued, currency)}
          </span>
          {period?.start && period?.end && (
            <span className="usage-summary__sub">
              {formatDate(period.start)} – {formatDate(period.end)}
            </span>
          )}
          </div>
        )}

        {credit && (
          <div className="usage-summary__metric">
            <span className="usage-summary__label">Credit remaining</span>
            <span className="usage-summary__value">
              {formatMoney(credit.remaining, currency)}
            </span>
            {isPurePrepaid ? (
              <>
                <span className="usage-summary__sub">
                  {formatMoney(credit.used, currency)} of{" "}
                  {formatMoney(credit.granted, currency)} used
                </span>
                {credit.granted > 0 && (
                  <div
                    className="usage-summary__bar"
                    role="progressbar"
                    aria-label="Credit used"
                    aria-valuenow={usedPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span
                      className="usage-summary__bar-fill"
                      style={{ width: `${usedPct}%` }}
                    />
                  </div>
                )}
                <Link to="/plans" className="button button--outline-secondary">
                  Add credit
                </Link>
              </>
            ) : (
              <>
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
                    className="usage-summary__bar-projected"
                    style={{ width: `${projectedPct}%` }}
                  />
                  <span
                    className="usage-summary__bar-fill"
                    style={{ width: `${usedPct}%` }}
                  />
                </div>
                {showProjection && (
                  <span className="usage-summary__sub usage-summary__projection">
                    Projected after this period:{" "}
                    {formatMoney(credit.projectedRemaining, currency)}
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {lines && lines.length > 0 && (
        <div className="usage-summary__breakdown">
          <p className="usage-summary__breakdown-title">
            {isPurePrepaid ? "Usage by metric" : "This period by metric"}
          </p>
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
