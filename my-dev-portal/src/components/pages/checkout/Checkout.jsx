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
        <h1>{isBasicTopUp ? "Add API credit" : "Subscribe"}</h1>
        <p>
          {isBasicTopUp
            ? "Choose how much prepaid credit to add to your Basic account."
            : "Complete your purchase to activate API access."}
        </p>
      </div>
      <div className="page-layout__focus">
        {isBasicTopUp ? (
          <BasicTopUpCheckout
            planId={urlPlanIdToPurchase}
            idToken={idToken}
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
