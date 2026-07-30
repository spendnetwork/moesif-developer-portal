import React, { useState } from "react";

import StripeCheckoutForm from "./StripeCheckoutForm";

function BasicTopUpCheckout({ planId, idToken }) {
  const [amount, setAmount] = useState("");
  const [confirmedAmount, setConfirmedAmount] = useState(null);
  const [error, setError] = useState("");

  function continueToPayment(event) {
    event.preventDefault();
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 1) {
      setError("Enter an amount of at least GBP 1.00.");
      return;
    }
    if (Math.round(numericAmount * 100) / 100 !== numericAmount) {
      setError("Enter no more than two decimal places.");
      return;
    }
    setError("");
    setConfirmedAmount(numericAmount.toFixed(2));
  }

  if (confirmedAmount) {
    return (
      <div className="basic-top-up">
        <div className="basic-top-up__summary">
          <div>
            <span>Credit purchase</span>
            <strong>GBP {confirmedAmount}</strong>
          </div>
          <button
            type="button"
            className="button button--outline-secondary"
            onClick={() => setConfirmedAmount(null)}
          >
            Change amount
          </button>
        </div>
        <StripeCheckoutForm
          key={`${planId}-${confirmedAmount}`}
          planId={planId}
          topUpAmount={confirmedAmount}
          idToken={idToken}
        />
      </div>
    );
  }

  return (
    <form className="basic-top-up" onSubmit={continueToPayment}>
      <div className="basic-top-up__field">
        <label htmlFor="basic-top-up-amount">Credit amount</label>
        <div className="basic-top-up__amount">
          <span aria-hidden="true">GBP</span>
          <input
            id="basic-top-up-amount"
            name="amount"
            type="number"
            min="1"
            step="0.01"
            inputMode="decimal"
            placeholder="500.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            autoComplete="off"
            required
          />
        </div>
        <p>
          Your full payment becomes API credit. Credit does not expire and API
          usage pauses automatically when the balance reaches zero.
        </p>
      </div>
      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}
      <button type="submit" className="button button--primary">
        Continue to payment
      </button>
    </form>
  );
}

export default BasicTopUpCheckout;
