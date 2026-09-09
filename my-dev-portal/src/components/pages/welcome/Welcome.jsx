import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { PageLayout } from "../../page-layout";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { welcomeStorageKey } from "../../../common/constants";

const API_DOCS_URL =
  "https://docs.openopps.com/s/1e0ae5a0-98cd-4814-9a10-08fef3ce3c4b/doc/api-v30-documentation-v2-summary-records-P5dS1Xsr1g";

const C = {
  green: "#034737",
  head: "#23383A",
  body: "#23302C",
  muted: "#647873",
  line: "#DDE5E0",
  page: "#F5F7F4",
};

const STEPS = [
  {
    n: 1,
    title: "Discuss your access",
    body: "Contact us for credit to build and test your integration, or discuss a Growth or Enterprise plan.",
    linkLabel: "Explore access options",
    to: "/plans",
  },
  {
    n: 2,
    title: "Create an API key",
    body: "Up to two active keys, rotate them whenever you need.",
    linkLabel: "Go to API keys",
    to: "/keys",
  },
  {
    n: 3,
    title: "Make your first call",
    body: "One GET against /notices returns clean JSON.",
    linkLabel: "Read the docs",
    href: API_DOCS_URL,
  },
];

function Welcome() {
  const { user } = useAuthCombined();
  const navigate = useNavigate();

  useEffect(() => {
    if (user?.sub) {
      localStorage.setItem(
        welcomeStorageKey(user.sub),
        new Date().toISOString()
      );
    }
  }, [user]);

  return (
    <PageLayout>
      <div style={{ maxWidth: 760, paddingTop: 8 }}>
        <div style={styles.eyebrow}>Welcome</div>
        <h1 style={styles.h1}>Welcome to the Open Opportunities API</h1>
        <p style={styles.lead}>
          Procurement data from 900+ sources across 180+ countries, delivered as
          clean JSON.
        </p>

        <div style={styles.grid}>
          {STEPS.map((step) => (
            <div key={step.n} style={styles.card}>
              <div style={styles.badge}>{step.n}</div>
              <div style={styles.cardTitle}>{step.title}</div>
              <p style={styles.cardBody}>{step.body}</p>
              {step.href ? (
                <a
                  href={step.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-text-link"
                  style={styles.link}
                >
                  {step.linkLabel}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate(step.to)}
                  className="btn-text-link"
                  style={{ ...styles.link, background: "none", cursor: "pointer" }}
                >
                  {step.linkLabel}
                </button>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => navigate("/plans")}
            className="btn-solid"
            style={styles.primaryBtn}
          >
            Explore access options
          </button>
          <button
            type="button"
            onClick={() => navigate("/dashboard")}
            className="btn-outline"
            style={styles.outlineBtn}
          >
            Go to my dashboard
          </button>
        </div>
      </div>
    </PageLayout>
  );
}

const styles = {
  eyebrow: {
    fontSize: 12,
    letterSpacing: 0,
    textTransform: "uppercase",
    color: C.muted,
    marginBottom: 12,
  },
  h1: {
    margin: "0 0 14px",
    fontSize: 38,
    lineHeight: 1.15,
    fontWeight: 500,
    letterSpacing: 0,
    color: C.head,
  },
  lead: {
    margin: "0 0 40px",
    fontSize: 17,
    lineHeight: 1.6,
    color: C.muted,
    maxWidth: 560,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 16,
    marginBottom: 36,
  },
  card: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 22,
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 999,
    background: "#E9F5EE",
    color: C.green,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
    fontWeight: 500,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: 500,
    color: C.head,
    marginBottom: 6,
  },
  cardBody: {
    margin: "0 0 14px",
    fontSize: 13.5,
    lineHeight: 1.55,
    color: C.muted,
  },
  link: {
    display: "inline-block",
    fontSize: 13.5,
    paddingBottom: 1,
    borderRadius: 0,
    padding: 0,
    textDecoration: "none",
  },
  primaryBtn: {
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 20px",
    borderRadius: 8,
    cursor: "pointer",
  },
  outlineBtn: {
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 20px",
    borderRadius: 8,
    cursor: "pointer",
  },
};

export default Welcome;
