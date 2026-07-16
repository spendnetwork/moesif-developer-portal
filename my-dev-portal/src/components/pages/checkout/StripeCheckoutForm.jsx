import React, { useState, useEffect } from "react";
import { loadStripe } from "@stripe/stripe-js";

import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";

const stripePromise = loadStripe(
  import.meta.env.REACT_APP_STRIPE_PUBLISHABLE_KEY
);

// used on embedded checkout example code:
// https://docs.stripe.com/checkout/embedded/quickstart

function StripeCheckoutForm({ priceId, planId, user, idToken, quantity }) {
  const [clientSecret, setClientSecret] = useState("");

  useEffect(() => {
    // Create a Checkout Session as soon as the page loads
    if (!idToken || (!priceId && !planId) || !user?.email) {
      return;
    }

    const params = new URLSearchParams({ email: user.email });
    if (planId) {
      params.set("plan_id", planId);
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
      .then((res) => res.json())
      .then((data) => {
        setClientSecret(data.clientSecret);
      })
      .catch((err) => {
        console.error("Failed to create checkout session", err);
      });
  }, [priceId, planId, user, idToken, quantity]);

  return (
    <div id="checkout">
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
