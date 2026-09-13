import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import useSWR from "swr";
import { PageLayout } from "../../page-layout";
import PurchaseResult from "../../purchase-result";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { apiRequest, authedFetcher } from "../../../lib/portal-api";
import "../../../styles/components/credit-purchase.css";

const PACKAGES = { credit: { title: "Buy API credit", amount: 50 }, growth: { title: "Buy Growth", amount: 5000 }, enterprise: { title: "Buy Enterprise", amount: 12000 } };

export default function CreditPurchase() {
  const { idToken, userEmail } = useAuthCombined();
  const [params] = useSearchParams();
  const kind = Object.hasOwn(PACKAGES, params.get("package")) ? params.get("package") : "credit";
  const selected = PACKAGES[kind];
  const [amount, setAmount] = useState(String(selected.amount));
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [locked, setLocked] = useState(false);
  const { data: context, error: contextError } = useSWR(idToken ? ["/portal-context", idToken] : null, authedFetcher);
  // Growth and Enterprise are arranged by invoice through the team, not this
  // self-service form -- reached only via a stale link/bookmark now that the
  // pricing page sends these straight to email.
  const contactLed = kind === "growth" || kind === "enterprise";
  const blocked = kind === "growth" && context?.current_plan_key === "enterprise";
  const invoice = Number(amount) >= 5000;
  const amountError = kind === "credit" && (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) < 50)
    ? "The minimum credit purchase is £50."
    : "";
  const storageKey = `wallet-purchase:${userEmail}:${kind}`;
  useEffect(() => {
    if (!idToken || !userEmail) return;
    let cancelled = false;
    const stored = sessionStorage.getItem(storageKey);
    if (!stored) { setAmount(String(PACKAGES[kind].amount)); setLocked(false); setResult(null); return; }
    let request;
    try { request = JSON.parse(stored); }
    catch { setError("Purchase details could not be recovered. Contact support before paying again."); return; }
    setAmount(String(request.amountGbp));
    setLocked(true);
    apiRequest("/wallet/purchases", idToken).then(({ purchases }) => {
      if (cancelled) return;
      const prior = purchases.find(item => item.request_id === request.requestId);
      if (prior?.status === "paid") {
        sessionStorage.removeItem(storageKey);
        setLocked(false); setResult(null); setAccepted(false);
      } else if (prior?.payment_provider === "invoice") setResult(prior);
    }).catch(() => { if (!cancelled) setError("We could not refresh your earlier purchase. Retry it without starting another payment."); });
    return () => { cancelled = true; };
  }, [storageKey, idToken, userEmail, kind]);
  async function submit(event) {
    event.preventDefault();
    setError("");
    if (amountError) return;
    const value = Number(amount);
    setBusy(true);
    try {
      let request;
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        request = JSON.parse(stored);
        if (request.amountGbp !== value || request.purchaseKind !== kind) {
          throw new Error("An earlier purchase is awaiting confirmation. Return to its original amount before retrying.");
        }
      } else {
        request = { requestId: crypto.randomUUID(), purchaseKind: kind, amountGbp: value };
        sessionStorage.setItem(storageKey, JSON.stringify(request));
      }
      setLocked(true);
      const response = await apiRequest("/wallet/purchases", idToken, { method: "POST", body: JSON.stringify(request) });
      setResult(response);
      if (response.checkoutUrl) {
        const url = new URL(response.checkoutUrl);
        if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("Checkout could not be verified.");
        window.location.assign(url.href);
      } else if (response.status === "paid") {
        sessionStorage.removeItem(storageKey);
      }
    } catch (failure) {
      if (failure.status === 422) { sessionStorage.removeItem(storageKey); setLocked(false); }
      setError(failure.message || "Purchase confirmation is unavailable. Retry this same request.");
    }
    finally { setBusy(false); }
  }
  function startOver() {
    sessionStorage.removeItem(storageKey);
    setLocked(false);
    setResult(null);
    setError("");
    setAccepted(false);
    setAmount(String(selected.amount));
  }
  const quickAmounts = [50, 100, 250, 500];
  return <PageLayout><main className="credit-purchase">
    <div className="credit-purchase__container">
      <Link to="/plans" className="credit-purchase__back">← Back to pricing</Link>
      <header><h1>{selected.title}</h1><p>Prepaid credit. No recurring charges or overages.</p></header>
      {error && <div role="alert" className="credit-purchase__error">{error}</div>}
      {contextError && <div role="alert" className="credit-purchase__error">We could not verify your account. Please refresh before purchasing.</div>}
      {contactLed ? <div className="credit-purchase__card">
          <section>
            <h2>{selected.title.replace("Buy ", "")} is arranged by invoice</h2>
            <p>Email our team to set up {selected.title.replace("Buy ", "")} pricing; this page does not take card payment for it.</p>
            <a className="credit-purchase__button" href={`mailto:welcome@openopps.com?subject=${encodeURIComponent(`${selected.title.replace("Buy ", "")} plan enquiry`)}`}>Email welcome@openopps.com</a>
          </section>
        </div> : blocked ? <div className="credit-purchase__card">
          <section>
            <h2>Your Enterprise pricing is still active</h2>
            <p>You can buy additional credit now. Growth becomes available when your Enterprise pricing period ends.</p>
            <Link to="/credit" className="credit-purchase__button credit-purchase__button--secondary">Buy credit</Link>
          </section>
        </div> :
        result && !result.checkoutUrl ? <PurchaseResult
          status={result.status === "paid" ? "success" : "pending"}
          title={result.status === "paid" ? "Credit added" : "Invoice requested"}
          description={result.status === "paid" ? "Your credit and applicable pricing are ready." : "Credit is added only when your payment clears. Your current pricing stays in place until then."}
          amountPence={result.amount_gbp_pence}
          reference={result.request_id}
        >
          {result.status !== "paid" && <a className="purchase-result__button purchase-result__button--outline" href={`mailto:welcome@openopps.com?subject=${encodeURIComponent(`API invoice ${result.request_id}`)}`}>Contact our team about this invoice</a>}
          <Link to="/dashboard" className="purchase-result__button">View your usage and balance</Link>
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
            <dl className="credit-purchase__summary">
              <div><dt>Payment</dt><dd>{invoice ? "Invoice from our team" : "Card through Stripe"}</dd></div>
              <div><dt>Credit expiry</dt><dd>12 months from your latest credit purchase</dd></div>
            </dl>
            <p className="credit-purchase__fineprint">Each purchase extends your unexpired purchased balance. Development credit keeps its separate expiry and is charged at Basic rates.</p>
            <label className="credit-purchase__consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} required /><span>I understand that credit is non-refundable and expires under these terms.</span></label>
            <button type="submit" className="credit-purchase__submit" disabled={busy || !accepted || !idToken || !context || Boolean(contextError) || Boolean(amountError)}>{busy ? "Confirming purchase…" : locked ? "Retry this purchase" : invoice ? "Request invoice" : "Continue to card payment"}</button>
            {locked && !busy && <button type="button" className="credit-purchase__link-button" onClick={startOver}>
              {kind === "credit" ? "Use a different amount instead" : "Start a new request instead"}
            </button>}
          </form></div>}
    </div>
  </main></PageLayout>;
}
