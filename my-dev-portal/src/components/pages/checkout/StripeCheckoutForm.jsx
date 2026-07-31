import React, { useState, useEffect, useRef } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { useNavigate } from "react-router-dom";

import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";
import { apiRequest } from "../../../lib/portal-api";

const stripePromise = loadStripe(
  import.meta.env.REACT_APP_STRIPE_PUBLISHABLE_KEY
);

// used on embedded checkout example code:
// https://docs.stripe.com/checkout/embedded/quickstart

function StripeCheckoutForm({
  planId,
  idToken,
  topUpAmount,
  purchaseType,
}) {
  const navigate = useNavigate();
  const checkoutRequestId = useRef(crypto.randomUUID());
  const [clientSecret, setClientSecret] = useState("");
  const [checkoutError, setCheckoutError] = useState("");

  useEffect(() => {
    // Create a Checkout Session as soon as the page loads
    if (!idToken || !planId) {
      return;
    }

    const params = new URLSearchParams();
    params.set("request_id", checkoutRequestId.current);
    params.set("plan_id", planId);
    if (topUpAmount) params.set("amount_gbp", topUpAmount);
    if (purchaseType) params.set("purchase_type", purchaseType);

    apiRequest(
      `/create-stripe-checkout-session?${params.toString()}`,
      idToken,
      { method: "POST" }
    )
      .then((data) => {
        if (data.updated || data.scheduled) {
          return data;
        }
        if (!data.clientSecret) throw new Error("Unable to start checkout");
        return data;
      })
      .then((data) => {
        if (data.updated || data.scheduled) {
          navigate("/dashboard", { replace: true });
          return;
        }
        setCheckoutError("");
        setClientSecret(data.clientSecret);
      })
      .catch((err) => {
        console.error("Failed to create checkout session", err);
        setCheckoutError(err.message || "Unable to start checkout");
      });
  }, [planId, idToken, topUpAmount, purchaseType, navigate]);

  return (
    <div id="checkout">
      {checkoutError && (
        <div className="alert-error" role="alert">
          {checkoutError}
        </div>
      )}
      {clientSecret && (
        <EmbeddedCheckoutProvider
          stripe={stripePromise}
          options={{ clientSecret }}
        >
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      )}
    </div>
  );
}

export default StripeCheckoutForm;
