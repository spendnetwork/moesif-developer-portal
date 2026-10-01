import { Link, useNavigate } from "react-router-dom";
import useSWR from "swr";
import { PageLayout } from "../../page-layout";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { authedFetcher } from "../../../lib/portal-api";
import "../../../styles/components/plan-options.css";

const TIERS = [
  { key: "basic", name: "Basic", price: "Credit from £50", rates: ["£0.13", "£0.26", "Not included", "£0.65"],
    note: "Default pricing with no commitment. Buy credit at any time. Adding credit does not change an active Growth or Enterprise pricing period." },
  { key: "growth", name: "Growth", price: "£5,000 credit purchase", rates: ["£0.10", "£0.20", "£0.35", "£0.50"],
    note: "Includes 12 months of Growth pricing from cleared payment. Buying this package again restarts those 12 months." },
  { key: "enterprise", name: "Enterprise", price: "£12,000 credit purchase", rates: ["£0.07", "£0.14", "£0.25", "£0.35"],
    note: "Includes 12 months of Enterprise pricing from cleared payment. Remaining credit returns to Basic pricing when the pricing period ends." },
];
const LABELS = ["Records / docs", "API calls", "Aggregate calls", "Attachments"];
const money = pence => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(pence / 100);
const longDate = value => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(value);
const RENEWAL_WINDOW_MS = 30 * 86400000;
const requestedOn = value => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(value));

export default function PlansView() {
  const navigate = useNavigate();
  const { idToken } = useAuthCombined();
  const { data: context, error } = useSWR(idToken ? ["/portal-context", idToken] : null, authedFetcher);
  const current = context?.current_plan_key;
  const { data: purchaseData } = useSWR(idToken ? ["/wallet/purchases", idToken] : null, authedFetcher);
  // A paid package needs no payment options until it is close to ending.
  const { data: usage } = useSWR(idToken ? ["/usage-summary", idToken] : null, authedFetcher);
  const pricingEndsAt = usage?.pricingEndsAt ? new Date(usage.pricingEndsAt) : null;
  const validEnd = pricingEndsAt && !Number.isNaN(pricingEndsAt.getTime());
  const renewalOpen = validEnd && pricingEndsAt.getTime() - Date.now() <= RENEWAL_WINDOW_MS;
  // An invoice request waiting for our team, per tier (Basic tops up with plain credit).
  const pendingFor = key => purchaseData?.purchases?.find(item => item.payment_provider === "invoice" &&
    item.status === "awaiting_payment" && item.purchase_kind === (key === "basic" ? "credit" : key));
  return <PageLayout><main className="plans-page">
    <header className="plans-page__heading"><div><h1>Open Opportunities API plans</h1>
      <p>Prepaid credit, with 12 months of lower rates on Growth and Enterprise. Usage stops when your credit runs out.</p></div></header>
    {error && <p role="alert">Your current pricing could not be verified. Refresh before choosing a package.</p>}
    <div id="plan-options" className="plan-options">
      {TIERS.map(tier => {
        const blocked = tier.key === "growth" && current === "enterprise";
        const packageTier = tier.key !== "basic";
        const pending = pendingFor(tier.key);
        const isCurrent = current === tier.key;
        const requestPath = `/credit?package=${packageTier ? tier.key : "credit"}&payment=invoice`;
        return <section key={tier.key} className={`plan-option${current === tier.key ? " plan-option--current" : ""}`} aria-labelledby={`plan-${tier.key}`}>
          <div className="plan-option__heading"><h2 id={`plan-${tier.key}`}>{tier.name}</h2>
            {current === tier.key && <span className="plan-option__badge">Current pricing</span>}</div>
          <p className="plan-option__commitment">{tier.price}</p>
          <dl className="plan-option__rates" aria-label="Usage rates per unit">{LABELS.map((label, i) => <div key={label}><dt>{label}</dt><dd>{tier.rates[i]}</dd></div>)}</dl>
          <p className="plan-option__note">{blocked ? "Growth is available when your Enterprise pricing period ends. You can still add credit without changing your rates." : tier.note}</p>
          {pending && <div className="plan-option__pending" role="status">
            <div className="plan-option__pending-title"><span aria-hidden="true" />Invoice requested</div>
            <p>{money(pending.amount_gbp_pence)} requested on {requestedOn(pending.created_at)}. Our team will confirm once your payment clears.</p>
          </div>}
          {pending ? <Link className="plan-choice-button plan-choice-button--link" to={requestPath}>View request</Link> :
          isCurrent ? <div className="plan-choice-button plan-choice-button--selected plan-choice-button--current" role="status">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            Current plan
          </div> :
          <button className="plan-choice-button" disabled={blocked || Boolean(error) || Boolean(idToken && !context)}
            onClick={() => navigate(`/credit?package=${packageTier ? tier.key : "credit"}`)}>
            {blocked ? "Available after Enterprise ends" : packageTier ? `Pay ${tier.key === "growth" ? "£5,000" : "£12,000"} by card` : "Buy credit"}
          </button>}
          <div className="plan-option__alternative">{!pending && !error && (!idToken || context) && (isCurrent
            ? packageTier
              ? renewalOpen
                ? <><span className="plan-option__active">Ends on {longDate(pricingEndsAt)}</span>
                    <Link to={`/credit?package=${tier.key}`}>Renew by card</Link><span aria-hidden="true"> · </span><Link to={requestPath}>Request an invoice</Link></>
                : validEnd && <span className="plan-option__active">Active until {longDate(pricingEndsAt)}</span>
              : <Link to="/credit?package=credit">Buy more credit</Link>
            : packageTier && !blocked && <Link to={requestPath}>Request an invoice instead</Link>)}</div>
        </section>;
      })}
    </div>
    <p style={{ color: "#526862", lineHeight: 1.6, marginTop: 24 }}>Growth and Enterprise can be paid by card or invoice. Credit-only top-ups use card below £5,000 and invoice from £5,000. Credit and pricing activate only after payment clears.</p>
  </main></PageLayout>;
}
