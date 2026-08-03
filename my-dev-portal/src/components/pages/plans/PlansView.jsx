import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { PageLayout } from "../../page-layout";
import { PageLoader } from "../../page-loader";
import useAuthCombined from "../../../hooks/useAuthCombined";
import usePlans from "../../../hooks/usePlans";
import useSubscriptions from "../../../hooks/useSubscriptions";
import { apiRequest } from "../../../lib/portal-api";

// Design tokens (from the OpenOpps developer portal design).
const C = {
  green: "#034737",
  mint: "#A9FF9B",
  head: "#23383A",
  body: "#23302C",
  muted: "#647873",
  line: "#DDE5E0",
  lineSoft: "#EEF2EF",
  successText: "#17633C",
  successBg: "#E3F5E9",
  successLine: "#C4E7D2",
  pillBg: "#E9F5EE",
};

const PLAN_KEY_ORDER = ["basic", "growth", "enterprise"];

const TIERS = [
  {
    key: "basic",
    name: "Basic",
    commitment: "£0 commitment · pay as you go",
    rates: [
      ["Records / docs", "£0.13"],
      ["API calls", "£0.26"],
      ["Aggregate calls", "£0.46"],
      ["Attachments", "£0.65"],
    ],
    note: "Billed monthly in arrears. First-time Basic accounts receive a £500 development credit, and you can top up credit at any time.",
    variant: "outline",
  },
  {
    key: "growth",
    name: "Growth",
    commitment: "£5,000 / yr prepaid",
    rates: [
      ["Records / docs", "£0.10"],
      ["API calls", "£0.20"],
      ["Aggregate calls", "£0.35"],
      ["Attachments", "£0.50"],
    ],
    note: "Prepaid credit draws down as you use the API. Overage is billed monthly in arrears. Credit re-grants on renewal.",
    variant: "primary",
  },
  {
    key: "enterprise",
    name: "Enterprise",
    commitment: "£12,000 / yr prepaid",
    rates: [
      ["Records / docs", "£0.07"],
      ["API calls", "£0.14"],
      ["Aggregate calls", "£0.25"],
      ["Attachments", "£0.35"],
    ],
    note: "Our lowest unit rates, with prepaid credit and monthly overage. Includes onboarding support and a shared Slack channel.",
    variant: "outline",
  },
];

function catalogPlanKey(plan) {
  const configured = plan?.metadata?.plan_key;
  if (configured) return configured.trim().toLowerCase();
  const name = (plan?.name || "").toLowerCase();
  return PLAN_KEY_ORDER.find((key) => name.includes(key));
}

export default function PlansView() {
  const { idToken } = useAuthCombined();
  const { plans, plansLoading } = usePlans();
  const { subscriptions, finishedLoading } = useSubscriptions({ idToken });

  const navigate = useNavigate();
  const [pending, setPending] = useState(null); // tier key awaiting confirm
  const [scheduled, setScheduled] = useState(null); // tier key scheduled
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");

  // Lock background scroll while the confirm dialog is open.
  useEffect(() => {
    if (!pending) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [pending]);

  const productByKey = useMemo(() => {
    const map = {};
    (plans || []).forEach((plan) => {
      const key = catalogPlanKey(plan);
      if (key && !map[key]) map[key] = plan.id;
    });
    return map;
  }, [plans]);

  const currentPlan = useMemo(() => {
    const sub = Array.isArray(subscriptions)
      ? subscriptions.find((s) => s?.plan_key)
      : null;
    return sub?.plan_key || null;
  }, [subscriptions]);

  const hasActive = Boolean(currentPlan);

  if (plansLoading || (idToken && !finishedLoading)) {
    return (
      <PageLayout>
        <PageLoader />
      </PageLayout>
    );
  }

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4200);
  };

  async function requestChange(tierKey) {
    setError("");
    const productId = productByKey[tierKey];
    if (!productId) {
      setError("That plan is not available right now. Please try again shortly.");
      return;
    }

    // No active subscription yet -> take them through checkout to subscribe.
    if (!hasActive) {
      setPending(null);
      navigate(`/checkout?plan_id_to_purchase=${encodeURIComponent(productId)}`);
      return;
    }

    // Active subscription -> schedule a plan change for period end.
    setBusy(true);
    try {
      const result = await apiRequest(
        `/create-stripe-checkout-session?plan_id=${encodeURIComponent(productId)}`,
        idToken,
        { method: "POST" }
      );
      if (result?.scheduled) {
        setScheduled(tierKey);
        setPending(null);
        flash("Plan switch scheduled");
      } else if (result?.clientSecret) {
        setPending(null);
        navigate(`/checkout?plan_id_to_purchase=${encodeURIComponent(productId)}`);
      } else {
        setPending(null);
        flash("Plan switch requested");
      }
    } catch (e) {
      setError(
        e.message ||
          "We could not schedule the plan change. Please try again shortly."
      );
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  const pendingTier = TIERS.find((t) => t.key === pending);
  const scheduledTier = TIERS.find((t) => t.key === scheduled);

  return (
    <PageLayout>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div style={{ marginBottom: 28 }}>
          <div style={styles.eyebrow}>Pricing</div>
          <h1 style={styles.h1}>Open Opportunities API plans</h1>
          <p style={styles.lead}>
            Prepay to lower every unit rate. Changes take effect at the end of
            your billing period.
          </p>
        </div>

        {error && (
          <div style={styles.errorAlert} role="alert">
            {error}
          </div>
        )}

        {scheduledTier && (
          <div style={styles.scheduledBanner}>
            <span style={{ color: C.successText, fontSize: 14 }}>
              Scheduled — switching to {scheduledTier.name} at the end of your
              billing period. Your current rates apply until then.
            </span>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => {
                setScheduled(null);
                flash("Scheduled change cancelled");
              }}
              style={styles.linkGreen}
            >
              Cancel change
            </button>
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 16,
            alignItems: "start",
          }}
        >
          {TIERS.map((tier) => {
            const isCurrent = currentPlan === tier.key;
            return (
              <div
                key={tier.key}
                style={{
                  ...styles.card,
                  border: isCurrent
                    ? `1.5px solid ${C.green}`
                    : `1px solid ${C.line}`,
                }}
              >
                <div style={styles.cardHead}>
                  <div style={styles.tierName}>{tier.name}</div>
                  {isCurrent && <span style={styles.currentPill}>Current plan</span>}
                </div>
                <div style={styles.commitment}>{tier.commitment}</div>
                <div style={styles.rateList}>
                  {tier.rates.map(([label, value]) => (
                    <div key={label} style={styles.rateRow}>
                      <span style={{ color: C.muted }}>{label}</span>
                      <span style={{ color: C.head, fontVariantNumeric: "tabular-nums" }}>
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
                <p style={styles.note}>{tier.note}</p>

                {isCurrent ? (
                  tier.key === "basic" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <button style={styles.btnDisabled} disabled>
                        Current plan
                      </button>
                      <button
                        style={styles.btnOutline}
                        onClick={() => navigate("/subscription")}
                      >
                        Add credit
                      </button>
                    </div>
                  ) : (
                    <button style={styles.btnDisabled} disabled>
                      Current plan
                    </button>
                  )
                ) : (
                  <button
                    style={tier.variant === "primary" ? styles.btnPrimary : styles.btnOutlineStrong}
                    disabled={busy}
                    onClick={() => setPending(tier.key)}
                  >
                    {hasActive ? `Switch to ${tier.name}` : `Choose ${tier.name}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {pendingTier &&
        createPortal(
          <div style={styles.backdrop} onClick={() => !busy && setPending(null)}>
            <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
              <div style={styles.modalTitle}>
                {hasActive
                  ? `Switch to ${pendingTier.name}?`
                  : `Subscribe to ${pendingTier.name}`}
              </div>
              <p style={styles.modalLead}>
                {hasActive
                  ? "The change is scheduled for the end of your current billing period. Nothing changes today and your existing credit carries over."
                  : `You'll continue to secure checkout to start your ${pendingTier.name} subscription.`}
              </p>
              <div style={styles.modalSummary}>
                <div style={styles.summaryRow}>
                  <span style={{ color: C.muted }}>Commitment</span>
                  <span style={{ color: C.head }}>{pendingTier.commitment}</span>
                </div>
                {pendingTier.rates.slice(0, 2).map(([label, value]) => (
                  <div key={label} style={styles.summaryRow}>
                    <span style={{ color: C.muted }}>{label}</span>
                    <span style={{ color: C.head }}>{value}</span>
                  </div>
                ))}
              </div>
              {hasActive && (
                <p style={styles.modalFine}>
                  Usage before the change is billed at your current rates. Any
                  prepaid balance is prorated onto the new plan.
                </p>
              )}
              <div style={styles.modalActions}>
                <button
                  style={styles.btnOutlineAuto}
                  onClick={() => setPending(null)}
                  disabled={busy}
                >
                  {hasActive ? "Keep current plan" : "Cancel"}
                </button>
                <button
                  style={styles.btnPrimaryAuto}
                  onClick={() => requestChange(pendingTier.key)}
                  disabled={busy}
                >
                  {busy
                    ? "Working…"
                    : hasActive
                      ? "Schedule change"
                      : "Continue to checkout"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {toast &&
        createPortal(
          <div style={styles.toast}>
            <span style={styles.toastDot}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.successText} strokeWidth="2">
                <path d="M6 12.5l4 4 8-9" />
              </svg>
            </span>
            <span style={{ fontSize: 13.5, color: C.body }}>{toast}</span>
          </div>,
          document.body
        )}
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
  lead: { margin: 0, fontSize: 15, color: C.muted },
  card: {
    background: "#FFFFFF",
    borderRadius: 12,
    padding: 24,
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  tierName: { fontSize: 19, fontWeight: 500, color: C.head },
  currentPill: {
    fontSize: 11.5,
    color: C.green,
    background: C.pillBg,
    border: `1px solid ${C.successLine}`,
    padding: "4px 10px",
    borderRadius: 999,
  },
  commitment: { fontSize: 13.5, color: C.muted, marginBottom: 20 },
  rateList: {
    display: "flex",
    flexDirection: "column",
    gap: 11,
    paddingBottom: 20,
    borderBottom: `1px solid ${C.lineSoft}`,
  },
  rateRow: { display: "flex", justifyContent: "space-between", fontSize: 13.5 },
  note: { margin: "18px 0 22px", fontSize: 13, lineHeight: 1.55, color: C.muted },
  btnPrimary: {
    width: "100%",
    background: C.green,
    border: `1px solid ${C.green}`,
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 18px",
    borderRadius: 8,
    cursor: "pointer",
  },
  btnOutline: {
    width: "100%",
    background: "transparent",
    border: `1px solid #C9D6CF`,
    color: C.head,
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 18px",
    borderRadius: 8,
    cursor: "pointer",
  },
  btnOutlineStrong: {
    width: "100%",
    background: "transparent",
    border: `1px solid ${C.green}`,
    color: C.green,
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 18px",
    borderRadius: 8,
    cursor: "pointer",
  },
  btnDisabled: {
    width: "100%",
    background: "#F1F4F1",
    border: `1px solid ${C.line}`,
    color: "#8A9A94",
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 18px",
    borderRadius: 8,
    cursor: "default",
  },
  btnPrimaryAuto: {
    background: C.green,
    border: `1px solid ${C.green}`,
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 18px",
    borderRadius: 8,
    cursor: "pointer",
  },
  btnOutlineAuto: {
    background: "transparent",
    border: `1px solid #C9D6CF`,
    color: C.head,
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 18px",
    borderRadius: 8,
    cursor: "pointer",
  },
  scheduledBanner: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: C.successBg,
    border: `1px solid ${C.successLine}`,
    borderRadius: 10,
    padding: "14px 18px",
    marginBottom: 20,
  },
  linkGreen: {
    background: "transparent",
    border: "none",
    color: C.successText,
    fontSize: 13,
    textDecoration: "underline",
    cursor: "pointer",
    padding: 0,
  },
  errorAlert: {
    background: "#FDE8E5",
    border: "1px solid #F5CFC9",
    color: "#8B2C21",
    borderRadius: 10,
    padding: "14px 16px",
    marginBottom: 20,
    fontSize: 14,
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    background: "rgba(35,56,58,0.42)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modal: {
    width: "100%",
    maxWidth: 470,
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    boxShadow: "0 24px 60px rgba(35,56,58,0.24)",
    padding: 26,
  },
  modalTitle: { fontSize: 19, fontWeight: 500, color: C.head, marginBottom: 8 },
  modalLead: { margin: "0 0 18px", fontSize: 14, lineHeight: 1.6, color: C.muted },
  modalSummary: {
    background: "#F5F7F4",
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    padding: 16,
    marginBottom: 18,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  summaryRow: { display: "flex", justifyContent: "space-between", fontSize: 13.5 },
  modalFine: { margin: "0 0 20px", fontSize: 12.5, lineHeight: 1.55, color: C.muted },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10 },
  toast: {
    position: "fixed",
    right: 24,
    bottom: 24,
    zIndex: 1001,
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    padding: "13px 16px",
    boxShadow: "0 10px 28px rgba(35,56,58,0.14)",
  },
  toastDot: {
    width: 20,
    height: 20,
    borderRadius: 999,
    background: C.successBg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
  },
};
