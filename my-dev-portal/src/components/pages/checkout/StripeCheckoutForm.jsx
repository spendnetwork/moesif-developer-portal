import React, { useState, useEffect, useRef } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { useNavigate } from "react-router-dom";

import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";

const stripePromise = loadStripe(
  import.meta.env.REACT_APP_STRIPE_PUBLISHABLE_KEY
);

// used on embedded checkout example code:
// https://docs.stripe.com/checkout/embedded/quickstart

function StripeCheckoutForm({
  priceId,
  planId,
  user,
  idToken,
  quantity,
  topUpAmount,
}) {
  const navigate = useNavigate();
  const checkoutRequestId = useRef(crypto.randomUUID());
  const [clientSecret, setClientSecret] = useState("");
  const [checkoutError, setCheckoutError] = useState("");

  useEffect(() => {
    // Create a Checkout Session as soon as the page loads
    if (!idToken || (!priceId && !planId) || !user?.email) {
      return;
    }

    const params = new URLSearchParams({ email: user.email });
    params.set("request_id", checkoutRequestId.current);
    if (planId) {
      params.set("plan_id", planId);
      if (topUpAmount) params.set("amount_gbp", topUpAmount);
    } else {
      params.set("price_id", priceId);
      if (quantity) params.set("quantity", quantity);
    }

    fetch(
      `${
        import.meta.env.REACT_APP_DEV_PORTAL_API_SERVER
      }/create-stripe-checkout-session?${params.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      }
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || "Unable to start checkout");
        }
        if (data.updated || data.scheduled) {
          return data;
        }
        if (!data.clientSecret) throw new Error("Unable to start checkout");
        return data;
      })
      .then((data) => {
        if (data.updated || data.scheduled) {
          navigate("/usage", { replace: true });
          return;
        }
        setCheckoutError("");
        setClientSecret(data.clientSecret);
      })
      .catch((err) => {
        console.error("Failed to create checkout session", err);
        setCheckoutError(err.message || "Unable to start checkout");
      });
  }, [priceId, planId, user, idToken, quantity, topUpAmount, navigate]);

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
