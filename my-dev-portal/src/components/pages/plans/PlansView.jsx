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

export default function PlansView() {
  const navigate = useNavigate();
  const { idToken } = useAuthCombined();
  const { data: context, error } = useSWR(idToken ? ["/portal-context", idToken] : null, authedFetcher);
  const current = context?.current_plan_key;
  return <PageLayout><main className="plans-page">
    <header className="plans-page__heading"><div><h1>Open Opportunities API plans</h1>
      <p>Prepaid credit, with 12 months of lower rates on Growth and Enterprise. No overages.</p></div></header>
    {error && <p role="alert">Your current pricing could not be verified. Refresh before choosing a package.</p>}
    <div id="plan-options" className="plan-options">
      {TIERS.map(tier => {
        const blocked = tier.key === "growth" && current === "enterprise";
        const packageTier = tier.key !== "basic";
        return <section key={tier.key} className={`plan-option${current === tier.key ? " plan-option--current" : ""}`} aria-labelledby={`plan-${tier.key}`}>
          <div className="plan-option__heading"><h2 id={`plan-${tier.key}`}>{tier.name}</h2>
            {current === tier.key && <span className="plan-option__badge">Current pricing</span>}</div>
          <p className="plan-option__commitment">{tier.price}</p>
          <dl className="plan-option__rates" aria-label="Usage rates per unit">{LABELS.map((label, i) => <div key={label}><dt>{label}</dt><dd>{tier.rates[i]}</dd></div>)}</dl>
          <p className="plan-option__note">{blocked ? "Growth is available when your Enterprise pricing period ends. You can still add credit without changing your rates." : tier.note}</p>
          <button className="plan-choice-button" disabled={blocked || Boolean(error) || Boolean(idToken && !context)}
            onClick={() => navigate(`/credit?package=${packageTier ? tier.key : "credit"}`)}>
            {blocked ? "Available after Enterprise ends" : packageTier ? `Pay ${tier.key === "growth" ? "£5,000" : "£12,000"} by card` : "Buy credit"}
          </button>
          <div className="plan-option__alternative">{packageTier && !blocked && !error && (!idToken || context) &&
            <Link to={`/credit?package=${tier.key}&payment=invoice`}>Request an invoice instead</Link>}</div>
        </section>;
      })}
    </div>
    <p style={{ color: "#526862", lineHeight: 1.6, marginTop: 24 }}>Growth and Enterprise can be paid by card or invoice. Credit-only top-ups use card below £5,000 and invoice from £5,000. Credit and pricing activate only after payment clears.</p>
  </main></PageLayout>;
}
