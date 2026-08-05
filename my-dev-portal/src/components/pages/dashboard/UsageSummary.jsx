import React, { useState } from "react";
import { Link } from "react-router-dom";

import useUsageSummary from "../../../hooks/useUsageSummary";
import usePlanChange from "../../../hooks/usePlanChange";
import { apiRequest } from "../../../lib/portal-api";

function formatMoney(minorUnits, currency) {
  const value = Number(minorUnits) / 100;
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

function planChangeCopy(planChange) {
  if (planChange.status === "pending_review") {
    return {
      title: "Upgrade review requested",
      body: "Your current plan remains active while we review the commitment and prepare the invoice.",
    };
  }
  if (planChange.status === "approved") {
    return {
      title: "Upgrade approved",
      body: "We are preparing your commitment invoice. Your plan will change only after payment.",
    };
  }
  if (planChange.status === "invoice_open") {
    return {
      title: "Commitment invoice sent",
      body: "Your current plan remains active. The new rates and permissions start after the invoice is paid.",
    };
  }
  if (planChange.status === "payment_failed") {
    return {
      title: "Payment required",
      body: "The required invoice has not been paid. Your current plan and permissions remain unchanged.",
    };
  }
  if (planChange.change_type === "downgrade") {
    return {
      title: `${planChange.to_plan_key} downgrade scheduled`,
      body: `Your current plan remains active until ${new Date(
        planChange.effective_at
      ).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })}.`,
    };
  }
  return {
    title: `${planChange.to_plan_key} plan change in progress`,
    body: "Your current plan remains active until the required payment and access synchronization complete.",
  };
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

  const { currency, period, accrued, lines, credit, billingModel } = usage;
  const isPurePrepaid = billingModel === "prepaid_credit";
  const displayedAccrued = Array.isArray(lines)
    ? lines.reduce(
        (total, line) => total + Math.max(0, Number(line.amount) || 0),
        0
      )
    : accrued;
  const usedPct =
    credit && Number.isFinite(credit.used) && credit.granted > 0
      ? Math.min(100, Math.round((credit.used / credit.granted) * 100))
      : 0;
  const projectedPct =
    credit &&
    Number.isFinite(credit.projectedRemaining) &&
    credit.granted > 0
      ? Math.min(
          100,
          Math.round(
            ((credit.granted - credit.projectedRemaining) / credit.granted) *
              100
          )
        )
      : 0;
  const showProjection =
    credit &&
    Number.isFinite(credit.projectedRemaining) &&
    Number.isFinite(credit.remaining) &&
    credit.projectedRemaining < credit.remaining;
  const hasCreditBalance = credit && Number.isFinite(credit.remaining);
  const hasCreditHistory =
    credit &&
    Number.isFinite(credit.used) &&
    Number.isFinite(credit.granted);
  const changeCopy = planChange ? planChangeCopy(planChange) : null;

  return (
    <section className="usage-summary">
      {planChange && (
        <div
          className={`plan-change-notice plan-change-notice--${planChange.status}`}
        >
          <div>
            <strong>
              {changeCopy.title}
            </strong>
            <p>{changeCopy.body}</p>
          </div>
          <div className="plan-change-notice__actions">
            <span>{planChange.status.replaceAll("_", " ")}</span>
            {["pending_review", "approved", "scheduled", "payment_failed"].includes(
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
        <div className="usage-summary__metric usage-summary__metric--usage">
          <div className="usage-summary__metric-header">
            <div>
              <span className="usage-summary__label">Billable usage</span>
              <span className="usage-summary__sub">
                {period?.start && period?.end
                  ? `${formatDate(period.start)} - ${formatDate(period.end)}`
                  : "Across all API keys in your company"}
              </span>
            </div>
            <div className="usage-summary__total">
              <span className="usage-summary__label">Accrued</span>
              <span className="usage-summary__value">
                {formatMoney(displayedAccrued, currency)}
              </span>
            </div>
          </div>

          <div className="usage-summary__table-wrap">
            <table className="usage-summary__table">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Rate</th>
                  <th scope="col">Usage</th>
                  <th scope="col">Accrued</th>
                </tr>
              </thead>
              <tbody>
                {(lines || []).map((line, index) => (
                  <tr key={`${line.key || line.label}-${index}`}>
                    <th scope="row">{line.label}</th>
                    <td>
                      {Number.isFinite(line.rate)
                        ? `${formatMoney(line.rate, currency)} / unit`
                        : "Variable"}
                    </td>
                    <td>{formatCount(line.quantity)}</td>
                    <td>{formatMoney(line.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {credit && (
          <div className="usage-summary__metric">
            <span className="usage-summary__label">Credit remaining</span>
            <span className="usage-summary__value">
              {hasCreditBalance
                ? formatMoney(credit.remaining, currency)
                : "Updating"}
            </span>
            {isPurePrepaid ? (
              <>
                <span className="usage-summary__sub">
                  {hasCreditHistory
                    ? `${formatMoney(credit.used, currency)} of ${formatMoney(
                        credit.granted,
                        currency
                      )} used`
                    : "Confirming your credit ledger with Moesif"}
                </span>
                {hasCreditHistory && credit.granted > 0 && (
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
    </section>
  );
}

export default UsageSummary;
