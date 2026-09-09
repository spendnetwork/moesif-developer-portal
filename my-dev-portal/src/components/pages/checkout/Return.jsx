import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { PageLayout } from "../../page-layout";
import noPriceIcon from "../../../images/icons/empty-state-price.svg";
import NoticeBox from "../../notice-box";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { moesifIdentifyUserFrontEndIfPossible } from "../../../common/utils";
import { PageLoader } from "../../page-loader";
import { apiRequest } from "../../../lib/portal-api";

const wait = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function registerStripePurchase(sessionId, idToken) {
  const retryDelays = [0, 1000, 2000, 4000, 8000];
  let lastError;
  for (const delay of retryDelays) {
    if (delay) await wait(delay);
    try {
      return await apiRequest(`/register/stripe/${sessionId}`, idToken, {
        method: "POST",
      });
    } catch (error) {
      lastError = error;
      const retryable =
        error.code !== "moesif_configuration_error" &&
        error.code !== "email_identity_conflict" &&
        (error.status >= 500 || error.code === "checkout_incomplete");
      if (!retryable) throw error;
    }
  }
  throw lastError;
}

function Return() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [provisionError, setProvisionError] = useState(null);
  const [registrationAttempt, setRegistrationAttempt] = useState(0);
  const { idToken } = useAuthCombined();

  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get("session_id");
  const purchaseType = urlParams.get("purchase_type");
  const isBasicTopUp = purchaseType === "basic_credit_top_up";
  const isBasicActivation = purchaseType === "basic_activation";

  useEffect(() => {
    if (!sessionId || !idToken) return;
    window.moesif?.track("stripe-checkout-returned", {
      purchase_type: purchaseType || "subscription",
    });

    let cancelled = false;
    setLoading(true);
    setProvisionError(null);
    registerStripePurchase(sessionId, idToken)
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((error) => {
        if (!cancelled) setProvisionError(error);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          moesifIdentifyUserFrontEndIfPossible(idToken);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, idToken, purchaseType, registrationAttempt]);

  if (loading) return <PageLoader />;

  if (result?.status === "complete") {
    return (
      <PageLayout>
        <h1>
          {isBasicTopUp || isBasicActivation
            ? "Payment confirmed"
              : "Subscription active"}
        </h1>
        <NoticeBox
          iconSrc={noPriceIcon}
          title={
            isBasicTopUp || isBasicActivation
              ? "Credit purchase recorded"
                : "Access ready"
          }
          description={
            isBasicTopUp || isBasicActivation
              ? "Your Basic credit purchase has been recorded. Your account shows your current plan and available credit."
              : `Your subscription and API access are ready. A confirmation will be sent to ${result.customer_email}.`
          }
          actions={
            <Link to="/keys" rel="noreferrer noopener">
              <button className="button button--outline-secondary">
                Manage API keys
              </button>
            </Link>
          }
        />
      </PageLayout>
    );
  }

  const configurationError =
    provisionError?.code === "moesif_configuration_error";
  const identityConflict = provisionError?.code === "email_identity_conflict";
  return (
    <PageLayout>
      <h1>Checkout status</h1>
      <NoticeBox
        iconSrc={noPriceIcon}
        title={
          identityConflict
            ? "Use your original sign-in"
            : configurationError
              ? "Payment received"
              : provisionError
                ? "Access setup delayed"
                : "Checkout incomplete"
        }
        description={
          identityConflict
            ? provisionError.message
            : configurationError
              ? "Your payment is safe, but account setup needs support. Please do not pay again."
              : provisionError
                ? "We could not finish synchronizing your access yet. You can retry without making another payment."
                : "We could not confirm a completed checkout session."
        }
        actions={
          provisionError && !identityConflict && !configurationError ? (
            <button
              className="button button--primary"
              onClick={() => setRegistrationAttempt((attempt) => attempt + 1)}
            >
              Retry synchronization
            </button>
          ) : (
            <Link to={configurationError ? "/settings" : "/plans"}>
              <button className="button button--outline-secondary">
                {configurationError ? "Account settings" : "View plans"}
              </button>
            </Link>
          )
        }
      />
    </PageLayout>
  );
}

export default Return;
