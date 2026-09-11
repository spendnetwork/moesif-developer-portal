import React, { useState } from "react";

import StripeCheckoutForm from "./StripeCheckoutForm";
import { BASIC_MINIMUM_GBP, validateBasicAmount } from "../../../lib/basic-purchase";

function BasicTopUpCheckout({ planId, idToken, purchaseType }) {
  const [amount, setAmount] = useState("");
  const [confirmedAmount, setConfirmedAmount] = useState(null);
  const [error, setError] = useState("");

  function continueToPayment(event) {
    event.preventDefault();
    const numericAmount = Number(amount);
    const validationError = validateBasicAmount(amount);
    if (validationError) {
      setError(validationError);
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
            <span>
              {purchaseType === "basic_activation"
                ? "Initial API credit"
                : "Credit purchase"}
            </span>
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
          purchaseType={purchaseType}
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
            min={BASIC_MINIMUM_GBP}
            step="0.01"
            inputMode="decimal"
            placeholder="50.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            autoComplete="off"
            required
          />
        </div>
        <p>
          Minimum £50. No recurring fee; top up whenever you need more credit.
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
