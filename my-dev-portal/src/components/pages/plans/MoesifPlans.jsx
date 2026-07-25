import React from "react";
import { Link } from "react-router-dom";
import { LineLoader } from "../../line-loader";
import NoPriceFound from "./NoPriceFound";
import PriceTile from "./PriceTile";
import PlanTile from "./PlanTile";
import { useAuth0 } from "@auth0/auth0-react";
import { SignupButton } from "../../buttons/signup-button";
import usePlans from "../../../hooks/usePlans";

const PLAN_KEY_ORDER = ["basic", "growth", "enterprise"];

function getCatalogPlanKey(plan) {
  const configured = plan?.metadata?.plan_key;
  if (configured) return configured.trim().toLowerCase();
  const name = (plan?.name || "").toLowerCase();
  return PLAN_KEY_ORDER.find((key) => name.includes(key));
}

function MoesifPlans(props) {
  const { isAuthenticated } = useAuth0();

  const { plans, plansLoading: loading, plansError: error } = usePlans();

  const getActionButton = (price, plan, options) => {
    // Helper to determine if price needs quantity
    const needsQuantity = (() => {
      // Stripe price object: usage_type === 'metered' means do NOT include quantity
      // For other pricing models, quantity is required
      // If price has price meter or usage_aggregator, quantity is not needed
      if (price.usage_type === "metered") return false;
      if (price.price_meter) return false;
      if (price.usage_aggregator) return false;
      // Otherwise, quantity is needed
      return true;
    })();

    const quantityParam = needsQuantity ? "&quantity=1" : "";

    if (options?.disable) {
      return (
        <button disabled className="button__price-action">
          Sign Up <span className="button__price-action-note">example</span>
        </button>
      );
    }
    if (isAuthenticated) {
      return (
        <Link
          to={`/checkout?price_id_to_purchase=${encodeURIComponent(
            price.id
          )}&plan_id_to_purchase=${encodeURIComponent(plan?.id)}${quantityParam}`}
        >
          <button className="button__price-action">Select</button>
        </Link>
      );
    } else {
      return <SignupButton isPriceAction />;
    }
  };

  const getPlanActionButton = (plan) => {
    if (isAuthenticated) {
      return (
        <Link to={`/checkout?plan_id_to_purchase=${encodeURIComponent(plan.id)}`}>
          <button className="button__price-action">Select plan</button>
        </Link>
      );
    }
    return <SignupButton isPriceAction />;
  };

  const tierPlans = (plans || [])
    .filter((plan) => plan.status === "active")
    .map((plan) => ({ plan, planKey: getCatalogPlanKey(plan) }))
    .filter(({ planKey }) => Boolean(planKey))
    .sort(
      (a, b) =>
        PLAN_KEY_ORDER.indexOf(a.planKey) - PLAN_KEY_ORDER.indexOf(b.planKey)
    );

  if (loading) {
    return <LineLoader />;
  }

  return (
    <div className="plans-section">
      <div className="page-heading">
        <p className="page-eyebrow">Pricing</p>
        <h1>Open Opportunities API plans</h1>
        <p>
          Choose the access level that matches your commitment and expected
          usage.
        </p>
      </div>
      {error && (
        <div className="alert-error" role="alert">
          We could not load the plans. Please refresh the page or try again
          shortly.
        </div>
      )}
      {!loading && !error && (!plans || plans.length === 0) && <NoPriceFound />}
      <div className="plans--container">
        {tierPlans.length > 0
          ? tierPlans.map(({ plan, planKey }) => (
              <PlanTile
                key={plan.id}
                plan={plan}
                planKey={planKey}
                actionButton={getPlanActionButton(plan)}
              />
            ))
          : plans &&
            plans
              .filter((plan) => plan.status === "active")
              .map((plan) =>
                plan?.prices?.map((price) => (
                  <PriceTile
                    key={`${plan.id}${price.id}`}
                    plan={plan}
                    price={price}
                    actionButton={getActionButton(price, plan)}
                  />
                ))
              )
              .flat()}
      </div>
    </div>
  );
}

export default MoesifPlans;
