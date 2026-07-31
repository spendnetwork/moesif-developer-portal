import React from "react";
import { Link } from "react-router-dom";
import { LineLoader } from "../../line-loader";
import NoPriceFound from "./NoPriceFound";
import PlanTile from "./PlanTile";
import { useAuth0 } from "@auth0/auth0-react";
import { SignupButton } from "../../buttons/signup-button";
import usePlans from "../../../hooks/usePlans";
import useAuthCombined from "../../../hooks/useAuthCombined";
import usePlanChange from "../../../hooks/usePlanChange";
import useSubscriptions from "../../../hooks/useSubscriptions";

const PLAN_KEY_ORDER = ["basic", "growth", "enterprise"];

function getCatalogPlanKey(plan) {
  const configured = plan?.metadata?.plan_key;
  const normalized = configured?.trim().toLowerCase();
  return PLAN_KEY_ORDER.includes(normalized) ? normalized : null;
}

function getCurrentPlanKey(subscriptions, plans) {
  const subscription = subscriptions?.[0];
  if (!subscription) return null;
  if (subscription.billing_model === "prepaid_credit") return "basic";

  const configured = String(
    subscription.plan_key || subscription.metadata?.plan_key || ""
  ).toLowerCase();
  if (PLAN_KEY_ORDER.includes(configured)) return configured;

  const subscribedProductIds = new Set(
    (subscription.items || [])
      .map((item) => item.plan_id)
      .filter(Boolean)
  );
  const currentPlan = (plans || []).find((plan) =>
    subscribedProductIds.has(plan.id)
  );
  return currentPlan ? getCatalogPlanKey(currentPlan) : null;
}

function MoesifPlans() {
  const { isAuthenticated } = useAuth0();
  const { idToken } = useAuthCombined();
  const { planChange } = usePlanChange({ idToken });
  const {
    subscriptions,
    finishedLoading: subscriptionsLoaded,
    subscriptionsError,
  } = useSubscriptions({ idToken });

  const {
    plans,
    plansLoading: loading,
    plansValidating: validating,
    plansError: error,
  } = usePlans();
  const currentPlanKey = getCurrentPlanKey(subscriptions, plans);

  const getPlanActionButton = (plan) => {
    const planKey = getCatalogPlanKey(plan);
    if (isAuthenticated) {
      if (subscriptionsError) {
        return (
          <button disabled className="button__price-action">
            Billing unavailable
          </button>
        );
      }
      if (planChange) {
        return (
          <button disabled className="button__price-action">
            Change scheduled
          </button>
        );
      }
      if (planKey === currentPlanKey) {
        if (planKey !== "basic") {
          return (
            <button disabled className="button__price-action">
              Current plan
            </button>
          );
        }
        return (
          <Link
            to={`/checkout?plan_id_to_purchase=${encodeURIComponent(
              plan.id
            )}&purchase_type=basic_credit_top_up`}
          >
            <button className="button__price-action">Add credit</button>
          </Link>
        );
      }
      if (planKey === "basic" && currentPlanKey) {
        return (
          <button
            disabled
            className="button__price-action"
            title="Basic becomes available when your current commitment ends"
          >
            Switch at renewal
          </button>
        );
      }
      return (
        <Link
          to={`/checkout?plan_id_to_purchase=${encodeURIComponent(plan.id)}${
            planKey === "basic" ? "&purchase_type=basic_activation" : ""
          }`}
        >
          <button className="button__price-action">
            {planKey === "basic" ? "Start Basic" : "Select plan"}
          </button>
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
  const invalidActivePlans = (plans || []).filter(
    (plan) => plan.status === "active" && !getCatalogPlanKey(plan)
  );

  // Keep the loader up while a first load (or its retries) is still in
  // flight so a transient failure does not flash a red error.
  if (
    loading ||
    (validating && !plans && error) ||
    (isAuthenticated && !subscriptionsLoaded)
  ) {
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
      {planChange && (
        <div className="plan-change-catalogue-notice">
          A change from {planChange.from_plan_key} to {planChange.to_plan_key} is
          already scheduled. Complete or cancel it before selecting another plan.
        </div>
      )}
      {error && !validating && (!plans || plans.length === 0) && (
        <div className="alert-error" role="alert">
          We could not load the plans. Please refresh the page or try again
          shortly.
        </div>
      )}
      {!loading && !error && (!plans || plans.length === 0) && <NoPriceFound />}
      {invalidActivePlans.length > 0 && (
        <div className="alert-error" role="alert">
          One or more active plans are missing valid plan_key metadata. Billing
          checkout is disabled for those plans until the catalogue is corrected.
        </div>
      )}
      <div className="plans--container">
        {tierPlans.map(({ plan, planKey }) => (
          <PlanTile
            key={plan.id}
            plan={plan}
            planKey={planKey}
            actionButton={getPlanActionButton(plan)}
          />
        ))}
      </div>
    </div>
  );
}

export default MoesifPlans;
