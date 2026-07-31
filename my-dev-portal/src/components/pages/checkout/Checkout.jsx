import React, { useEffect } from "react";

import useAuthCombined from "../../../hooks/useAuthCombined";
import { PageLoader } from "../../page-loader";
import { PageLayout } from "../../page-layout";
import StripeCheckoutForm from "./StripeCheckoutForm";
import { Navigate } from "react-router-dom";
import BasicTopUpCheckout from "./BasicTopUpCheckout";

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

  return (
    <PageLayout>
      <div className="page-heading">
        <p className="page-eyebrow">Billing</p>
        <h1>
          {isBasicActivation
            ? "Start Basic"
            : isBasicTopUp
              ? "Add API credit"
              : "Subscribe"}
        </h1>
        <p>
          {isBasicActivation
            ? "Choose your initial prepaid credit amount to confirm and activate Basic."
            : isBasicTopUp
              ? "Choose how much prepaid credit to add to your Basic account."
              : "Complete your purchase to activate API access."}
        </p>
      </div>
      <div className="page-layout__focus">
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
    </PageLayout>
  );
}

export default Checkout;
