import React from "react";

import { PageLayout } from "../../page-layout";
import useSubscriptions from "../../../hooks/useSubscriptions";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { PageLoader } from "../../page-loader";
import { Link } from "react-router-dom";
import usePlans from "../../../hooks/usePlans";
import SVG from "react-inlinesvg";
import noPriceIcon from "../../../images/icons/empty-state-price.svg";
import SubDisplay from "./SubDisplay";
import { isSessionExpiredError } from "../../../lib/session-expiry";

function Subscription(props) {
  const { isAuthenticated, isLoading, user, idToken, accessToken } =
    useAuthCombined();
  const { subscriptions, finishedLoading, subscriptionsError } =
    useSubscriptions({
      user,
      idToken,
      accessToken,
    });
  const { plansLoading, plans } = usePlans();

  // An expired token is not a load failure — SessionTimeout is already
  // logging the user out, so show the loader rather than a misleading
  // "we could not load your subscriptions" message.
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

  return (
    <PageLayout>
      <div className="page-heading">
        <p className="page-eyebrow">Billing</p>
        <h1>Subscriptions</h1>
        <p>Review your active plans, rates, and billing periods.</p>
      </div>
      {subscriptionsError && (
        <div className="alert-error" role="alert">
          We could not load your subscriptions. Please refresh the page or try
          again shortly.
        </div>
      )}
      {!subscriptionsError && (!subscriptions || subscriptions.length <= 0) && (
        <div className="empty-state">
          <SVG src={noPriceIcon} aria-hidden="true" />
          <h2>No active subscription yet</h2>
          <p>
            Your account is ready. Choose a plan to activate API access, then
            create a key and start making calls.
          </p>
          <p className="empty-state__hint">
            Just checked out? We will synchronize your access automatically.
          </p>
          <Link to="/plans">
            <button className="button button--primary">View plans</button>
          </Link>
        </div>
      )}
      {subscriptions?.length > 0 && (
        <div className="subscription-list">
          {subscriptions.map((sub) => (
            <SubDisplay
              sub={sub}
              key={sub.subscription_id}
              plans={plans}
              onManage={openStripeManagement}
            />
          ))}
        </div>
      )}
      {subscriptions?.length > 0 && (
        <p className="text-muted">
          Subscription status is verified directly with Stripe.
        </p>
      )}
    </PageLayout>
  );
}

export default Subscription;
