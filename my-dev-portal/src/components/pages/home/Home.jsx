import React, { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Check, FileText, Plug, Tags } from "lucide-react";

import { PageLayout } from "../../page-layout";
import { SignupButton } from "../../buttons/signup-button";
import { LoginButton } from "../../buttons/login-button";
import { PageLoader } from "../../page-loader";
import useAuthCombined from "../../../hooks/useAuthCombined";
import SessionExpiredNotice from "../../session-expired-notice";
import { ApiExample, API_DOCS_URL } from "../../api-example";
import "../../../styles/components/home.css";

// The same headline figures as openopps.com, so the two never disagree.
const FACTS = [
  { value: "1050+", label: "procurement sources" },
  { value: "180+", label: "countries covered" },
  { value: "Twice a day", label: "data refreshed" },
  { value: "JSON", label: "over a REST API" },
];

const HERO_POINTS = ["Prepaid API access from £50", "Card, or invoice from £5,000", "No usage overages"];

const DATA = [
  { icon: FileText, title: "Tender details", body: "Titles, descriptions, buyer details, values, deadlines and documents, where available." },
  { icon: Plug, title: "From your own systems", body: "Search and download tenders directly into your product, pipeline or warehouse." },
  { icon: Tags, title: "Search across sources", body: "Filter by CPV code, country and language, with optional deduplication across sources." },
];

// Who builds with the API, in the same terms as openopps.com.
const USE_CASES = [
  { key: "product", label: "Product teams", title: "Put live tenders inside your product",
    body: "Give your users search, alerts and buyer pages without building a single scraper.",
    points: ["Search 1050+ sources from one endpoint", "Filter by country, CPV code and language", "Updated twice a day"] },
  { key: "data", label: "Data and analytics", title: "Load procurement data where you analyse it",
    body: "Pull tenders into your warehouse or notebooks for market sizing, pipeline and win-rate reporting.",
    points: ["Structured JSON records", "Buyer, value and deadline where available", "Page through large result sets"] },
  { key: "resellers", label: "Resellers", title: "Build procurement data into what you sell",
    body: "Offer tender data from 1050+ sources to your own customers through one API.",
    points: ["CPV codes where the source provides them", "Optional deduplication across sources", "Lower rates with Growth and Enterprise"] },
  { key: "ai", label: "AI and automation", title: "Feed tenders to your AI workflows",
    body: "Route alerts, summarise notices and research markets with procurement data as the input.",
    points: ["Tender descriptions for summarising", "Structured fields for routing rules", "Usage costs tracked by metric"] },
];

const FAQS = [
  { q: "How is usage charged?",
    a: "Requests are charged from prepaid credit at your plan's rates, and one request can use more than one billable metric. Your usage page shows API activity, credit remaining and costs by metric. The Plans page lists the rates." },
  { q: "What happens when my credit runs out?",
    a: "Requests stop when your available credit cannot cover them, which can happen with a small balance left. There are no usage overages. You can top up by card at any time from £50." },
  { q: "Can I pay by invoice?",
    a: "Yes. Growth and Enterprise can be paid by card or invoice, and credit top-ups of £5,000 or more are invoiced. Credit is added once payment clears." },
  { q: "How long does credit last?",
    a: "Purchased credit lasts 12 months from your latest purchase, and each purchase extends your unexpired balance." },
  { q: "What do Growth and Enterprise change?",
    a: "Both include credit and 12 months of lower rates. Paid by card, they renew annually until cancelled; paid by invoice, they don't renew automatically. When the 12 months end, any remaining credit carries on at Basic rates." },
  { q: "Can my team share one account?",
    a: "Yes. Your company's admins can invite teammates from Settings. Everyone shares the company's credit and has their own API keys." },
];

const STEPS = [
  { title: "Create an account", body: "Sign up with your work email and confirm the terms." },
  { title: "Add credit", body: "Buy credit by card from £50. Invoice payment is available for purchases of £5,000 or more." },
  { title: "Create a key and call the API", body: "Generate an API key and make your first request. Track API activity, credit remaining and usage costs by metric." },
];

function UseCases() {
  const [active, setActive] = useState(USE_CASES[0].key);
  const current = USE_CASES.find((item) => item.key === active);
  return (
    <section className="home-section" aria-labelledby="home-uses">
      <p className="home-eyebrow">Who it's for</p>
      <h2 id="home-uses">Built for teams that work with tenders</h2>
      <div className="home-uses">
        <div className="home-uses__tabs" role="tablist" aria-label="Use cases">
          {USE_CASES.map((item) => (
            <button key={item.key} type="button" role="tab" id={`use-${item.key}`} aria-selected={active === item.key}
              aria-controls="use-panel" className="home-uses__tab" onClick={() => setActive(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="home-uses__panel" role="tabpanel" id="use-panel" aria-labelledby={`use-${current.key}`}>
          <h3>{current.title}</h3>
          <p>{current.body}</p>
          <ul>
            {current.points.map((point) => (
              <li key={point}><Check size={15} strokeWidth={2.4} aria-hidden="true" />{point}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Home() {
  const { isAuthenticated, isLoading } = useAuthCombined();

  if (isLoading) return <PageLoader />;
  if (isAuthenticated) return <Navigate replace to="/dashboard" />;

  return (
    <PageLayout isHome>
      <main className="home">
        <section className="home-hero">
          <div className="home-hero__copy">
            <SessionExpiredNotice />
            <p className="home-eyebrow">Open Opportunities API</p>
            <h1>Build with procurement data</h1>
            <p className="home-hero__lead">
              Tenders from 1050+ sources across 180+ countries, as clean JSON. Create an account, add credit
              and make your first call in minutes.
            </p>
            <div className="home-hero__actions">
              <SignupButton className="home-button home-button--primary" />
              <LoginButton className="home-button home-button--outline" />
            </div>
            <ul className="home-hero__points">
              {HERO_POINTS.map((point) => (
                <li key={point}><Check size={15} strokeWidth={2.4} aria-hidden="true" />{point}</li>
              ))}
            </ul>
            <p className="home-hero__links">
              <Link to="/plans">See plans and pricing</Link>
              <span aria-hidden="true">·</span>
              <a href={API_DOCS_URL} target="_blank" rel="noreferrer">Read the API documentation</a>
            </p>
          </div>
          <ApiExample />
        </section>

        <ul className="home-facts" aria-label="Coverage">
          {FACTS.map((fact) => (
            <li key={fact.label}><strong>{fact.value}</strong><span>{fact.label}</span></li>
          ))}
        </ul>

        <section className="home-section" aria-labelledby="home-data">
          <p className="home-eyebrow">The data</p>
          <h2 id="home-data">What you can build with</h2>
          <div className="home-grid">
            {DATA.map((item) => (
              <article key={item.title} className="home-card">
                <span className="home-card__icon" aria-hidden="true"><item.icon size={19} strokeWidth={1.8} /></span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <UseCases />

        <section className="home-section" aria-labelledby="home-steps">
          <p className="home-eyebrow">Getting started</p>
          <h2 id="home-steps">From sign-up to first call</h2>
          <ol className="home-steps">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="home-steps__number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="home-section home-faq" aria-labelledby="home-faq">
          <div>
            <p className="home-eyebrow">Questions</p>
            <h2 id="home-faq">Frequently asked</h2>
            <p className="home-faq__intro">
              Anything else? <a href="mailto:welcome@openopps.com">Email our team</a>.
            </p>
          </div>
          <div className="home-faq__list">
            {FAQS.map((item, index) => (
              <details key={item.q} open={index === 0}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="home-closing">
          <div>
            <h2>Need higher volumes or a custom feed?</h2>
            <p>Growth and Enterprise packages lower your rates for 12 months. Talk to us about anything larger.</p>
          </div>
          <div className="home-closing__actions">
            <Link className="home-button home-button--light" to="/plans">Compare plans</Link>
            <a className="home-button home-button--ghost" href="mailto:welcome@openopps.com">Contact us</a>
          </div>
        </section>
      </main>
    </PageLayout>
  );
}

export default Home;
