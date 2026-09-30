import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/portal-api";
import "../styles/components/invoice-request.css";

const PACKAGES = {
  credit: { name: "Credit top-up", added: "credit is added" },
  growth: { name: "Growth", detail: "Includes 12 months of Growth pricing", added: "credit and Growth pricing are added" },
  enterprise: { name: "Enterprise", detail: "Includes 12 months of Enterprise pricing", added: "credit and Enterprise pricing are added" },
};

const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
function formatDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(date) : null;
}

function ClockIcon() {
  return <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>;
}
function CrossIcon() {
  return <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>;
}

// An invoice request waiting for our team: what was requested, what happens
// next, and a deliberately low-key way to withdraw it.
export default function InvoiceRequest({ purchase, idToken, onChange, onStartOver }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pack = PACKAGES[purchase.purchase_kind] || PACKAGES.credit;
  const requested = formatDate(purchase.created_at);
  const cancelled = purchase.status === "cancelled";

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const updated = await apiRequest(`/wallet/purchases/${purchase.request_id}/cancel`, idToken, { method: "POST" });
      setConfirming(false);
      onChange?.(updated);
    } catch (failure) {
      setError(failure.message || "The request could not be cancelled. Try again or contact our team.");
    } finally {
      setBusy(false);
    }
  }

  const details = <dl className="invoice-request__details">
    <div><dt>Package</dt><dd>{pack.name}{pack.detail && <small>{pack.detail}</small>}</dd></div>
    <div><dt>Amount</dt><dd className="invoice-request__amount">{money(purchase.amount_gbp_pence)}</dd></div>
    {requested && <div><dt>Requested</dt><dd>{requested}</dd></div>}
    <div><dt>Reference</dt><dd className="invoice-request__reference">{purchase.request_id}</dd></div>
  </dl>;

  if (cancelled) {
    return <section className="invoice-request invoice-request--cancelled" aria-live="polite">
      <header className="invoice-request__head">
        <span className="invoice-request__icon" aria-hidden="true"><CrossIcon /></span>
        <div>
          <h2>Request cancelled</h2>
          <p>We’ve let our team know. No invoice will be issued for this request, and your credit and pricing are unchanged.</p>
        </div>
      </header>
      {details}
      <div className="invoice-request__actions">
        <Link to="/plans" className="invoice-request__button">Back to plans</Link>
        {onStartOver && <button type="button" className="invoice-request__button invoice-request__button--outline" onClick={onStartOver}>Start a new request</button>}
      </div>
    </section>;
  }

  return <section className="invoice-request" aria-live="polite">
    <header className="invoice-request__head">
      <span className="invoice-request__icon" aria-hidden="true"><ClockIcon /></span>
      <div>
        <div className="invoice-request__title-row"><h2>Invoice requested</h2><span className="invoice-request__pill">Awaiting payment</span></div>
        <p>We’ve received your request. Our team will send your invoice and confirm here once payment clears.</p>
      </div>
    </header>
    {details}
    <ol className="invoice-request__steps" aria-label="What happens next">
      <li className="is-done"><span aria-hidden="true" />Request received</li>
      <li className="is-current"><span aria-hidden="true" />Our team sends your invoice</li>
      <li><span aria-hidden="true" />Payment clears and your {pack.added}</li>
    </ol>
    <p className="invoice-request__note">Your current balance and pricing stay as they are until then. There’s nothing else you need to do.</p>
    <div className="invoice-request__actions">
      <Link to="/dashboard" className="invoice-request__button">View usage and balance</Link>
      <a className="invoice-request__button invoice-request__button--outline"
        href={`mailto:welcome@openopps.com?subject=${encodeURIComponent(`API invoice ${purchase.request_id}`)}`}>Contact our team</a>
    </div>
    <footer className="invoice-request__footer">
      {error && <p role="alert" className="invoice-request__error">{error}</p>}
      {confirming ? <div className="invoice-request__confirm">
        <p>Cancel this invoice request? We’ll let our team know, and you can request again at any time.</p>
        <div>
          <button type="button" className="invoice-request__text-button" disabled={busy} onClick={() => setConfirming(false)}>Keep request</button>
          <button type="button" className="invoice-request__text-button invoice-request__text-button--danger" disabled={busy} onClick={cancel}>
            {busy ? "Cancelling…" : "Cancel request"}
          </button>
        </div>
      </div> : <button type="button" className="invoice-request__text-button" onClick={() => setConfirming(true)}>
        No longer need this? Cancel request
      </button>}
    </footer>
  </section>;
}
