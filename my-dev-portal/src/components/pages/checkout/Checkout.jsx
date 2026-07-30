import React, { useEffect } from "react";

import useAuthCombined from "../../../hooks/useAuthCombined";
import { PageLoader } from "../../page-loader";
import { PageLayout } from "../../page-layout";
import StripeCheckoutForm from "./StripeCheckoutForm";
import { Navigate } from "react-router-dom";
import CustomCheckoutForm from "./CustomCheckoutForm";
import BasicTopUpCheckout from "./BasicTopUpCheckout";

function Checkout(props) {
  const { isLoading, user, idToken } = useAuthCombined();

  const queryString = window.location.search;
  const urlParams = new URLSearchParams(queryString);
  const urlPriceIdToPurchase = urlParams.get("price_id_to_purchase");
  const urlPlanIdToPurchase = urlParams.get("plan_id_to_purchase");
  const urlQuantity = urlParams.get("quantity");
  const purchaseType = urlParams.get("purchase_type");
  const isBasicTopUp = purchaseType === "basic_credit_top_up";

  useEffect(() => {
    window.moesif?.track("about-to-checkout", {
      price_id: urlPriceIdToPurchase,
      plan_id: urlPlanIdToPurchase,
      quantity: urlQuantity,
    });
  }, [urlPriceIdToPurchase, urlPlanIdToPurchase, urlQuantity]);

  if (isLoading || !idToken) {
    return (
      <PageLayout>
        <PageLoader />
      </PageLayout>
    );
  }

  if (!urlPriceIdToPurchase && !urlPlanIdToPurchase) {
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
        {isBasicTopUp &&
        import.meta.env.REACT_APP_PAYMENT_PROVIDER !== "custom" ? (
          <BasicTopUpCheckout
            planId={urlPlanIdToPurchase}
            user={user}
            idToken={idToken}
          />
        ) : import.meta.env.REACT_APP_PAYMENT_PROVIDER === "custom" ? (
          <CustomCheckoutForm
            key={urlPriceIdToPurchase}
            priceId={urlPriceIdToPurchase}
            planId={urlPlanIdToPurchase}
            user={user}
            idToken={idToken}
          />
        ) : (
          <StripeCheckoutForm
            key={urlPriceIdToPurchase || urlPlanIdToPurchase}
            priceId={urlPriceIdToPurchase}
            planId={urlPlanIdToPurchase}
            quantity={urlQuantity}
            user={user}
            idToken={idToken}
          />
        )}
      </div>
    </PageLayout>
  );
}

export default Checkout;
