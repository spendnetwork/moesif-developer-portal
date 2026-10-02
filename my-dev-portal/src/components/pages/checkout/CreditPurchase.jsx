import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import useSWR from "swr";
import { PageLayout } from "../../page-layout";
import PurchaseResult from "../../purchase-result";
import InvoiceRequest from "../../invoice-request";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { apiRequest, authedFetcher } from "../../../lib/portal-api";
import "../../../styles/components/credit-purchase.css";
import { PageHeader } from "../../page-header";

const PACKAGES = { credit: { title: "Buy API credit", amount: 50 }, growth: { title: "Buy Growth", amount: 5000 }, enterprise: { title: "Buy Enterprise", amount: 12000 } };

export default function CreditPurchase() {
  const { idToken, userEmail } = useAuthCombined();
  const [params] = useSearchParams();
  const kind = Object.hasOwn(PACKAGES, params.get("package")) ? params.get("package") : "credit";
  const selected = PACKAGES[kind];
  const [amount, setAmount] = useState(String(selected.amount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [locked, setLocked] = useState(false);
  const [recovering, setRecovering] = useState(true);
  const requestedMethod = params.get("payment") === "invoice" ? "invoice" : "card";
  const [paymentMethod, setPaymentMethod] = useState(requestedMethod);
  const submitting = useRef(false);
  const { data: context, error: contextError } = useSWR(idToken ? ["/portal-context", idToken] : null, authedFetcher);
  const { data: paymentOptions, error: paymentOptionsError } = useSWR(idToken ? ["/wallet/payment-options", idToken] : null, authedFetcher);
  // The server is the record of pending invoice requests, so they show in any tab or device.
  const { data: purchaseData, mutate: mutatePurchases } = useSWR(idToken ? ["/wallet/purchases", idToken] : null, authedFetcher);
  const pendingInvoice = purchaseData?.purchases?.find(item => item.payment_provider === "invoice" &&
    item.status === "awaiting_payment" && item.purchase_kind === kind);
  const blocked = kind === "growth" && context?.current_plan_key === "enterprise";
  const method = kind === "credit" ? (Number(amount) >= 5000 ? "invoice" : "card") : paymentMethod;
  const invoice = method === "invoice";
  const recurring = !invoice && kind !== "credit" && paymentOptions?.cardSubscriptions === true;
  const amountError = kind === "credit" && (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) < 50)
    ? "The minimum credit purchase is £50."
    : "";
  const storageKey = `wallet-purchase:${userEmail}:${kind}`;
  useEffect(() => {
    if (!idToken || !userEmail) return;
    let cancelled = false;
    setRecovering(true); setError(""); setResult(null);
    let stored;
    try { stored = sessionStorage.getItem(storageKey); }
    catch { setLocked(true); setError("Purchase recovery is unavailable. Enable browser storage before paying."); return; }
    if (!stored) { setAmount(String(PACKAGES[kind].amount)); setPaymentMethod(requestedMethod); setLocked(false); setRecovering(false); return; }
    let request;
    try {
      request = JSON.parse(stored);
      if (!request || request.purchaseKind !== kind || !Number.isFinite(request.amountGbp) || !request.requestId ||
          (request.paymentMethod && !["card", "invoice"].includes(request.paymentMethod))) throw new Error("Invalid saved request");
    } catch { setLocked(true); setError("Purchase details could not be recovered. Contact support before paying again."); return; }
    setAmount(String(request.amountGbp));
    setPaymentMethod(request.paymentMethod || (request.amountGbp >= 5000 ? "invoice" : "card"));
    setLocked(true);
    apiRequest("/wallet/purchases", idToken).then(({ purchases }) => {
      if (cancelled) return;
      const prior = purchases.find(item => item.request_id === request.requestId);
      if (prior?.status === "paid") {
        sessionStorage.removeItem(storageKey);
        setLocked(false); setResult(prior);
      } else if (prior?.status === "cancelled") {
        sessionStorage.removeItem(storageKey);
        setLocked(false);
        setError("Your earlier checkout expired without payment. You can start a new purchase.");
      } else if (prior?.payment_provider === "invoice") setResult(prior);
    }).catch(() => { if (!cancelled) setError("We could not refresh your earlier purchase. Retry it without starting another payment."); })
      .finally(() => { if (!cancelled) setRecovering(false); });
    return () => { cancelled = true; };
  }, [storageKey, idToken, userEmail, kind, requestedMethod]);
  async function submit(event) {
    event.preventDefault();
    setError("");
    if (amountError || blocked || recovering || !context || contextError || !paymentOptions || paymentOptionsError || submitting.current) return;
    submitting.current = true;
    const value = Number(amount);
    setBusy(true);
    try {
      let request;
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        request = JSON.parse(stored);
        if (request.amountGbp !== value || request.purchaseKind !== kind ||
            (request.paymentMethod || (request.amountGbp >= 5000 ? "invoice" : "card")) !== method) {
          throw new Error("An earlier purchase is awaiting confirmation. Return to its original amount before retrying.");
        }
      } else {
        request = { requestId: crypto.randomUUID(), purchaseKind: kind, amountGbp: value, paymentMethod: method };
        sessionStorage.setItem(storageKey, JSON.stringify(request));
      }
      setLocked(true);
      const response = await apiRequest("/wallet/purchases", idToken, { method: "POST", body: JSON.stringify(request) });
      if (!response || response.request_id !== request.requestId || response.purchase_kind !== kind ||
          response.amount_gbp_pence !== Math.round(value * 100) || response.payment_provider !== (method === "card" ? "stripe" : "invoice") ||
          !["paid", "awaiting_payment"].includes(response.status) ||
          (method === "card" && response.status !== "paid" && !response.checkoutUrl)) throw new Error("The checkout could not be confirmed. Retry this same purchase.");
      setResult(response);
      void mutatePurchases();
      if (response.checkoutUrl) {
        const url = new URL(response.checkoutUrl);
        if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("Checkout could not be verified.");
        window.location.assign(url.href);
      } else if (response.status === "paid") {
        sessionStorage.removeItem(storageKey);
      }
    } catch (failure) {
      if (failure.status === 422 || failure.code === "card_checkout_closed") { sessionStorage.removeItem(storageKey); setLocked(false); }
      setError(failure.message || "Purchase confirmation is unavailable. Retry this same request.");
    }
    finally { submitting.current = false; setBusy(false); }
  }
  function startOver() {
    sessionStorage.removeItem(storageKey);
    setLocked(false);
    setResult(null);
    setError("");
    setAmount(String(selected.amount));
  }
  const invoiceRequest = result?.payment_provider === "invoice" && ["awaiting_payment", "cancelled"].includes(result.status)
    ? result : pendingInvoice;
  function invoiceChanged(updated) {
    sessionStorage.removeItem(storageKey);
    setLocked(false);
    setResult(updated);
    void mutatePurchases(data => data && { ...data, purchases: data.purchases.map(item =>
      item.request_id === updated.request_id ? updated : item) });
  }
  const quickAmounts = [50, 100, 250, 500];
  return <PageLayout><main className="credit-purchase">
    <div className="credit-purchase__container">
      <Link to="/plans" className="credit-purchase__back">← Back to pricing</Link>
      <PageHeader eyebrow="Billing" title={selected.title} description={recurring ? "Annual subscription with prepaid credit. Requests stop when your available credit cannot cover them." : "Prepaid credit. No automatic top-ups; requests stop when your available credit cannot cover them."} />
      {error && <div role="alert" className="credit-purchase__error">{error}</div>}
      {contextError && <div role="alert" className="credit-purchase__error">We could not verify your account. Please refresh before purchasing.</div>}
      {paymentOptionsError && <div role="alert" className="credit-purchase__error">We could not verify the payment terms. Please refresh before purchasing.</div>}
      {blocked ? <div className="credit-purchase__card">
          <section>
            <h2>Your Enterprise pricing is still active</h2>
            <p>You can buy additional credit now. Growth becomes available when your Enterprise pricing period ends.</p>
            <Link to="/credit" className="credit-purchase__button credit-purchase__button--secondary">Buy credit</Link>
          </section>
        </div> :
        invoiceRequest ? <InvoiceRequest purchase={invoiceRequest} idToken={idToken} onChange={invoiceChanged} onStartOver={startOver} /> :
        result && !result.checkoutUrl ? <PurchaseResult
          status={result.status === "paid" ? "success" : "pending"}
          title={result.status === "paid" ? "Credit added" : "Invoice requested"}
          description={result.status === "paid" ? "Your credit and applicable pricing are ready." : "Credit is added only when your payment clears. Your current pricing stays in place until then."}
          amountPence={result.amount_gbp_pence}
          reference={result.request_id}
        >
          {result.status !== "paid" && <a className="purchase-result__button purchase-result__button--outline" href={`mailto:welcome@openopps.com?subject=${encodeURIComponent(`API invoice ${result.request_id}`)}`}>Contact our team about this invoice</a>}
          <Link to="/dashboard" className="purchase-result__button">View your usage and balance</Link>
          {result.status === "paid" && <button type="button" className="credit-purchase__link-button" onClick={startOver}>Make another purchase</button>}
        </PurchaseResult> : <div className="credit-purchase__card"><form onSubmit={submit}>
            <div className="credit-purchase__amount-field">
              <label htmlFor="credit-amount">Credit amount (GBP)</label>
              <div className="credit-purchase__amount"><span aria-hidden="true">£</span><input id="credit-amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} readOnly={kind !== "credit" || locked} required aria-invalid={Boolean(amountError)} aria-describedby={amountError ? "credit-amount-error" : undefined} /></div>
              {amountError && <p role="alert" id="credit-amount-error" className="credit-purchase__amount-error">{amountError}</p>}
              {kind === "credit" && !locked && <div className="credit-purchase__quick-amounts">
                {quickAmounts.map(value => (
                  <button type="button" key={value} className={`credit-purchase__chip${Number(amount) === value ? " is-active" : ""}`} onClick={() => setAmount(String(value))}>£{value}</button>
                ))}
              </div>}
              {!amountError && <p className="credit-purchase__hint">{kind === "credit" ? "Minimum £50. A credit top-up does not change your current pricing tier." : `Includes £${selected.amount.toLocaleString("en-GB")} of credit and 12 months of ${kind === "growth" ? "Growth" : "Enterprise"} pricing from cleared payment.`}</p>}
            </div>
            {kind !== "credit" && <fieldset className="credit-purchase__methods" disabled={locked || busy || recovering}>
              <legend>Payment method</legend>
              <label><input type="radio" name="payment-method" value="card" checked={paymentMethod === "card"} onChange={() => setPaymentMethod("card")} />Card through Stripe</label>
              <label><input type="radio" name="payment-method" value="invoice" checked={paymentMethod === "invoice"} onChange={() => setPaymentMethod("invoice")} />Invoice from our team</label>
            </fieldset>}
            <dl className="credit-purchase__summary">
              <div><dt>Payment</dt><dd>{invoice ? "Invoice from our team" : "Card through Stripe"}</dd></div>
              {recurring && <div><dt>Annual renewal</dt><dd>£{selected.amount.toLocaleString("en-GB")} automatically each year</dd></div>}
              <div><dt>Credit expiry</dt><dd>12 months from your latest credit purchase</dd></div>
            </dl>
            <p className="credit-purchase__fineprint">Each purchase extends your unexpired purchased balance. Development credit keeps its separate expiry and is charged at Basic rates.</p>
            {recurring && <p className="credit-purchase__fineprint">Your card is charged now and annually until renewal is cancelled. Credit is added after each successful payment. Contact welcome@openopps.com to stop renewal or change your subscription.</p>}
            <button type="submit" className="credit-purchase__submit" disabled={busy || recovering || !idToken || !context || !paymentOptions || Boolean(paymentOptionsError) || Boolean(contextError) || Boolean(amountError)}>{busy ? "Confirming purchase…" : recovering ? "Checking purchase…" : locked ? "Resume this purchase" : invoice ? "Request invoice" : recurring ? "Continue to annual subscription" : "Continue to card payment"}</button>
            {locked && <p className="credit-purchase__hint">Your existing purchase is saved. Resume it or contact our team before starting another payment.</p>}
          </form></div>}
    </div>
  </main></PageLayout>;
}
