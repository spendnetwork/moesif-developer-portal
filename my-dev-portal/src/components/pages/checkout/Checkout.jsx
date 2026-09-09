import React, { useEffect } from "react";

import useAuthCombined from "../../../hooks/useAuthCombined";
import { PageLoader } from "../../page-loader";
import { PageLayout } from "../../page-layout";
import StripeCheckoutForm from "./StripeCheckoutForm";
import { Navigate } from "react-router-dom";
import BasicTopUpCheckout from "./BasicTopUpCheckout";

const C = {
  head: "#23383A",
  muted: "#647873",
  line: "#DDE5E0",
  lineSoft: "#EEF2EF",
  page: "#F5F7F4",
};

function Checkout() {
  const { isLoading, idToken } = useAuthCombined();

  const queryString = window.location.search;
  const urlParams = new URLSearchParams(queryString);
  const urlPlanIdToPurchase = urlParams.get("plan_id_to_purchase");
  const purchaseType = urlParams.get("purchase_type");
  const isBasicTopUp = purchaseType === "basic_credit_top_up";
  const isBasicActivation = purchaseType === "basic_activation";
  const isBasicPurchase = isBasicActivation || isBasicTopUp;

  useEffect(() => {
    window.moesif?.track("about-to-checkout", {
      plan_id: urlPlanIdToPurchase,
    });
  }, [urlPlanIdToPurchase]);

  if (isLoading || !idToken) {
    return (
      <PageLayout>
        <PageLoader />
      </PageLayout>
    );
  }

  if (!urlPlanIdToPurchase) {
    return <Navigate replace to="/plans" />;
  }

  const title = isBasicActivation
    ? "Start Basic"
    : isBasicTopUp
      ? "Add API credit"
      : "Subscribe";
  const subtitle = isBasicActivation
    ? "Prepay £100 or more to start using the API."
    : isBasicTopUp
      ? "Add £100 or more to your Basic credit."
      : "Payment is handled by Stripe. We never see or store your card details.";
  const cardTitle = isBasicPurchase ? "Add prepaid credit" : "Complete your subscription";
  const cardHint = isBasicPurchase
    ? "One-off payment. No overage."
    : "Access activates as soon as payment succeeds";

  return (
    <PageLayout>
      <div style={{ maxWidth: 720 }}>
        <div style={styles.eyebrow}>Billing</div>
        <h1 style={styles.h1}>{title}</h1>
        <p style={{ margin: "0 0 24px", fontSize: 15, color: C.muted }}>
          {subtitle}
        </p>

        <div style={styles.card}>
          <div style={styles.cardHead}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 500, color: C.head }}>
                {cardTitle}
              </div>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>
                {cardHint}
              </div>
            </div>
            <span style={styles.pill}>Secure · Stripe</span>
          </div>
          <div style={{ padding: 24 }}>
            {isBasicPurchase ? (
              <BasicTopUpCheckout
                planId={urlPlanIdToPurchase}
                idToken={idToken}
                purchaseType={purchaseType}
              />
            ) : (
              <StripeCheckoutForm
                key={urlPlanIdToPurchase}
                planId={urlPlanIdToPurchase}
                idToken={idToken}
              />
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

const styles = {
  eyebrow: {
    fontSize: 12,
    letterSpacing: 0,
    textTransform: "uppercase",
    color: C.muted,
    marginBottom: 10,
  },
  h1: {
    margin: "0 0 8px",
    fontSize: 32,
    lineHeight: 1.15,
    fontWeight: 500,
    letterSpacing: 0,
    color: C.head,
  },
  card: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 24px",
    borderBottom: `1px solid ${C.lineSoft}`,
  },
  pill: {
    fontSize: 12,
    color: C.muted,
    background: C.page,
    border: `1px solid ${C.line}`,
    padding: "4px 10px",
    borderRadius: 999,
    whiteSpace: "nowrap",
  },
};

export default Checkout;
