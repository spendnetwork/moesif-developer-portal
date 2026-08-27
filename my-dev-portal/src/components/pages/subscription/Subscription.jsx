import React, { useMemo, useState } from "react";

import { PageLayout } from "../../page-layout";
import useSubscriptions from "../../../hooks/useSubscriptions";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { PageLoader } from "../../page-loader";
import { useNavigate } from "react-router-dom";
import usePlans from "../../../hooks/usePlans";
import SubDisplay from "./SubDisplay";
import { isSessionExpiredError } from "../../../lib/session-expiry";

const C = {
  head: "#23383A",
  muted: "#647873",
  line: "#DDE5E0",
};

function catalogPlanKey(plan) {
  const configured = plan?.metadata?.plan_key;
  if (configured) return configured.trim().toLowerCase();
  const name = (plan?.name || "").toLowerCase();
  return ["basic", "growth", "enterprise"].find((key) =>
    name.includes(key)
  );
}

function basicTopUpPath(productId) {
  const params = new URLSearchParams({
    plan_id_to_purchase: productId,
    purchase_type: "basic_credit_top_up",
  });
  return `/checkout?${params.toString()}`;
}

function Subscription() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, user, idToken } = useAuthCombined();
  const { subscriptions, finishedLoading, subscriptionsError } =
    useSubscriptions({ idToken });
  const { plansLoading, plans } = usePlans();
  const [topUpError, setTopUpError] = useState("");

  const basicProductId = useMemo(
    () => (plans || []).find((plan) => catalogPlanKey(plan) === "basic")?.id,
    [plans]
  );

  function startBasicTopUp() {
    setTopUpError("");
    if (!basicProductId) {
      setTopUpError(
        "Basic credit purchases are not available right now. Please try again shortly."
      );
      return;
    }
    navigate(basicTopUpPath(basicProductId));
  }

  const sessionExpired = isSessionExpiredError(subscriptionsError);

  if (
    isLoading ||
    !finishedLoading ||
    !isAuthenticated ||
    plansLoading ||
    !idToken ||
    sessionExpired
  ) {
    return (
      <PageLayout>
        <PageLoader />
      </PageLayout>
    );
  }

  const openStripeManagement = import.meta.env.REACT_APP_STRIPE_MANAGEMENT_URL
    ? () => {
        window.open(
          `${import.meta.env.REACT_APP_STRIPE_MANAGEMENT_URL}?prefilled_email=${encodeURIComponent(
            user?.email || ""
          )}`,
          "_blank",
          "noreferrer"
        );
      }
    : undefined;
  const contactBilling = () => {
    const email =
      import.meta.env.REACT_APP_SALES_CONTACT_EMAIL ||
      "welcome@openopps.com";
    window.location.href = `mailto:${email}?subject=${encodeURIComponent(
      "Open Opportunities API billing"
    )}`;
  };

  const hasSubs = subscriptions?.length > 0;

  return (
    <PageLayout>
      <div style={styles.header}>
        <div>
          <div style={styles.eyebrow}>Billing</div>
          <h1 style={styles.h1}>Subscriptions</h1>
          <p style={{ margin: 0, fontSize: 15, color: C.muted }}>
            Your active plans, their rates, and where to manage payment.
          </p>
        </div>
      </div>

      {subscriptionsError && (
        <div style={styles.errorCard} role="alert">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8B2C21" strokeWidth="1.6" style={{ flex: "none", marginTop: 1 }}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.8v5" />
            <circle cx="12" cy="16.2" r="0.8" fill="#8B2C21" stroke="none" />
          </svg>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: "#8B2C21", marginBottom: 4 }}>
              We couldn&rsquo;t load your subscriptions
            </div>
            <p style={{ margin: 0, fontSize: 13.5, color: "#8B2C21" }}>
              {subscriptionsError.code === "moesif_prepaid_subscription_not_found"
                ? "Your Basic payment is still synchronizing. Do not pay again; retry this page shortly."
                : "Nothing has changed on your account. Try again in a moment."}
            </p>
          </div>
        </div>
      )}

      {topUpError && (
        <div style={styles.errorCard} role="alert">
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: "#8B2C21" }}>
              {topUpError}
            </div>
          </div>
        </div>
      )}

      {!subscriptionsError && !hasSubs && (
        <div style={styles.emptyCard}>
          <div style={styles.emptyIcon}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.5">
              <rect x="3.5" y="6" width="17" height="12" rx="2.5" />
              <path d="M3.5 10.5h17" />
            </svg>
          </div>
          <div style={{ fontSize: 19, fontWeight: 500, color: C.head, marginBottom: 8 }}>
            No active subscription yet
          </div>
          <p style={styles.emptyBody}>
            Pick a plan and your subscription will appear here with its rates and
            billing period.
          </p>
          <button
            type="button"
            onClick={() => navigate("/plans")}
            className="btn-solid"
            style={styles.primaryBtn}
          >
            View plans
          </button>
        </div>
      )}

      {hasSubs && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {subscriptions.map((sub) => (
            <SubDisplay
              sub={sub}
              key={sub.subscription_id}
              plans={plans}
              onManage={
                sub.billing_model === "prepaid_credit"
                  ? startBasicTopUp
                  : sub.billing_model === "prepaid_commitment"
                    ? contactBilling
                  : openStripeManagement
              }
            />
          ))}
          <p style={{ margin: "4px 0 0", fontSize: 12.5, color: C.muted }}>
            {subscriptions.some((sub) => sub.billing_model === "prepaid_credit")
              ? "Basic payments are collected by Stripe and the available credit balance is verified with Moesif."
              : subscriptions.some(
                    (sub) => sub.billing_model === "prepaid_commitment"
                  )
                ? "Growth and Enterprise commitments are invoiced outside Stripe. Usage and available credit are metered in Moesif."
                : "Subscription status is verified directly with Stripe."}
          </p>
        </div>
      )}
    </PageLayout>
  );
}

const styles = {
  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 24,
    marginBottom: 28,
  },
  eyebrow: {
    fontSize: 12,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: C.muted,
    marginBottom: 10,
  },
  h1: {
    margin: "0 0 8px",
    fontSize: 32,
    lineHeight: 1.15,
    fontWeight: 500,
    letterSpacing: "-0.02em",
    color: C.head,
  },
  errorCard: {
    display: "flex",
    gap: 12,
    background: "#FDE8E5",
    border: "1px solid #F5CFC9",
    borderRadius: 12,
    padding: "18px 20px",
  },
  emptyCard: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: "72px 24px",
    textAlign: "center",
  },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: 999,
    background: "#F1F4F1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 20px",
  },
  emptyBody: {
    margin: "0 auto 22px",
    fontSize: 14,
    lineHeight: 1.6,
    color: C.muted,
    maxWidth: 360,
  },
  primaryBtn: {
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 20px",
    borderRadius: 8,
    cursor: "pointer",
  },
};

export default Subscription;
