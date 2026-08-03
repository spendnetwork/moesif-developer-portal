import React from "react";

import { useAuth0 } from "@auth0/auth0-react";
import { PageLayout } from "../../page-layout";
import { PageLoader } from "../../page-loader";
import NoticeBox from "../../notice-box";
import profileIcon from "../../../images/icons/user.svg";

const C = {
  green: "#034737",
  mint: "#A9FF9B",
  head: "#23383A",
  body: "#23302C",
  muted: "#647873",
  line: "#DDE5E0",
  lineSoft: "#EEF2EF",
};

function initials(name, email) {
  const source = (name || email || "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function Auth0Settings(props) {
  const {
    user,
    isAuthenticated,
    isLoading,
  } = useAuth0();

  const { openStripeManagement } = props;

  if (isLoading) {
    return (
      <PageLayout>
        <PageLoader />
      </PageLayout>
    );
  }

  const organisation =
    user?.["https://spendnetwork.com/org_name"] ||
    user?.org_name ||
    user?.organization ||
    null;
  const memberSince = formatDate(user?.updated_at || user?.created_at);

  return (
    <PageLayout>
      <div style={{ maxWidth: 680 }}>
        <div style={styles.eyebrow}>Account</div>
        <h1 style={styles.h1}>Settings</h1>
        <p style={styles.lead}>
          Your profile and where to manage payment details.
        </p>

        {isAuthenticated && user ? (
          <>
            <div style={styles.card}>
              <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                {user.picture ? (
                  <img
                    src={user.picture}
                    alt={user.name || "Profile"}
                    style={styles.avatarImg}
                  />
                ) : (
                  <div style={styles.avatar}>
                    {initials(user.name, user.email)}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 17, fontWeight: 500, color: C.head }}>
                    {user.name || "Your account"}
                  </span>
                  {user.email && (
                    <span style={{ fontSize: 14, color: C.muted }}>
                      {user.email}
                    </span>
                  )}
                </div>
              </div>
              {(organisation || memberSince) && (
                <div style={styles.metaGrid}>
                  {organisation && (
                    <div style={styles.metaItem}>
                      <span style={styles.metaLabel}>Organisation</span>
                      <span style={styles.metaValue}>{organisation}</span>
                    </div>
                  )}
                  {memberSince && (
                    <div style={styles.metaItem}>
                      <span style={styles.metaLabel}>Member since</span>
                      <span style={styles.metaValue}>{memberSince}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={styles.billingCard}>
              <div>
                <div style={styles.billingTitle}>Billing</div>
                <p style={styles.billingBody}>
                  Invoices, payment method and receipts are managed in the
                  Stripe customer portal.
                </p>
              </div>
              <button
                type="button"
                disabled={!user.email}
                onClick={() => openStripeManagement(user.email)}
                style={{
                  ...styles.outlineBtn,
                  opacity: user.email ? 1 : 0.55,
                  cursor: user.email ? "pointer" : "default",
                }}
              >
                Manage billing
              </button>
            </div>
          </>
        ) : (
          <NoticeBox
            iconSrc={profileIcon}
            title="No profile found"
            description="We could not load your profile. Please refresh the page or sign in again."
          />
        )}
      </div>
    </PageLayout>
  );
}

const styles = {
  eyebrow: {
    fontSize: 12,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: C.muted,
    marginBottom: 10,
  },
  h1: {
    margin: "0 0 8px",
    fontSize: 32,
    lineHeight: 1.15,
    fontWeight: 500,
    letterSpacing: "-0.02em",
    color: C.head,
  },
  lead: { margin: "0 0 24px", fontSize: 15, color: C.muted },
  card: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 24,
    marginBottom: 16,
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 999,
    background: C.mint,
    color: C.green,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 19,
    fontWeight: 500,
    flex: "none",
  },
  avatarImg: {
    width: 56,
    height: 56,
    borderRadius: 999,
    objectFit: "cover",
    flex: "none",
  },
  metaGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 20,
    paddingTop: 22,
    marginTop: 22,
    borderTop: `1px solid ${C.lineSoft}`,
  },
  metaItem: { display: "flex", flexDirection: "column", gap: 5 },
  metaLabel: {
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: C.muted,
  },
  metaValue: { fontSize: 14, color: C.body },
  billingCard: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 24,
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  billingTitle: {
    fontSize: 15,
    fontWeight: 500,
    color: C.head,
    marginBottom: 5,
  },
  billingBody: { margin: 0, fontSize: 13.5, color: C.muted },
  outlineBtn: {
    background: "transparent",
    border: "1px solid #C9D6CF",
    color: C.head,
    fontSize: 14,
    fontWeight: 500,
    padding: "10px 16px",
    borderRadius: 8,
    whiteSpace: "nowrap",
  },
};

export default Auth0Settings;
