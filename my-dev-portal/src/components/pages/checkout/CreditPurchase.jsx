import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import useSWR from "swr";
import { PageLayout } from "../../page-layout";
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
  const blocked = kind === "growth" && context?.current_plan_key === "enterprise";
  const invoice = Number(amount) >= 5000;
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
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 50 || !/^\d+(\.\d{1,2})?$/.test(amount)) {
      setError("Enter at least £50, with no more than two decimal places."); return;
    }
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
  return <PageLayout><main className="credit-purchase">
    <Link to="/plans" className="credit-purchase__back">Back to pricing</Link>
    <header><h1>{selected.title}</h1><p>Prepaid credit. No recurring charges or overages.</p></header>
    {error && <div role="alert" className="credit-purchase__error">{error}</div>}
    {contextError && <div role="alert">We could not verify your account. Please refresh before purchasing.</div>}
    {blocked ? <section><h2>Your Enterprise pricing is still active</h2><p>You can buy additional credit now. Growth becomes available when your Enterprise pricing period ends.</p><Link to="/credit">Buy credit</Link></section> :
      result && !result.checkoutUrl ? <section aria-live="polite">
        <h2>{result.status === "paid" ? "Credit added" : "Invoice requested"}</h2>
        <p>{result.status === "paid" ? "Your credit and applicable pricing are ready." : "Credit is added only when your payment clears. Your current pricing stays in place until then."}</p>
        <dl><dt>Amount</dt><dd>£{(result.amount_gbp_pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 })}</dd><dt>Reference</dt><dd className="credit-purchase__reference">{result.request_id}</dd></dl>
        {result.status !== "paid" && <a href={`mailto:welcome@openopps.com?subject=${encodeURIComponent(`API invoice ${result.request_id}`)}`}>Contact our team about this invoice</a>}
        <p><Link to="/dashboard">View your usage and balance</Link></p>
      </section> : <form onSubmit={submit}>
        <label htmlFor="credit-amount">Credit amount (GBP)</label>
        <div className="credit-purchase__amount"><span aria-hidden="true">£</span><input id="credit-amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} readOnly={kind !== "credit" || locked} required /></div>
        <p>{kind === "credit" ? "Minimum £50. A credit top-up does not change your current pricing tier." : `Includes £${selected.amount.toLocaleString("en-GB")} of credit and 12 months of ${kind === "growth" ? "Growth" : "Enterprise"} pricing from cleared payment.`}</p>
        <dl><dt>Payment</dt><dd>{invoice ? "Invoice from our team" : "Card through Stripe"}</dd><dt>Credit expiry</dt><dd>12 months from your latest credit purchase</dd></dl>
        <p>Each purchase extends your unexpired purchased balance. Development credit keeps its separate expiry and is charged at Basic rates.</p>
        <label className="credit-purchase__consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} required /><span>I understand that credit is non-refundable and expires under these terms.</span></label>
        <button type="submit" disabled={busy || !accepted || !idToken || !context || Boolean(contextError)}>{busy ? "Confirming purchase…" : locked ? "Retry this purchase" : invoice ? "Request invoice" : "Continue to card payment"}</button>
      </form>}
  </main></PageLayout>;
}
