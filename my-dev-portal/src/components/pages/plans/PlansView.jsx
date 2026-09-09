import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import Modal from "react-modal";

import { PageLayout } from "../../page-layout";
import { PageLoader } from "../../page-loader";
import useAuthCombined from "../../../hooks/useAuthCombined";
import usePlans from "../../../hooks/usePlans";
import useSubscriptions from "../../../hooks/useSubscriptions";
import usePlanChange from "../../../hooks/usePlanChange";
import { apiRequest } from "../../../lib/portal-api";
import "../../../styles/components/plan-options.css";

// Design tokens (from the OpenOpps developer portal design).
const C = {
  green: "#034737",
  head: "#23383A",
  body: "#23302C",
  muted: "#647873",
  line: "#DDE5E0",
  successText: "#17633C",
  successBg: "#E3F5E9",
  successLine: "#C4E7D2",
};

const PLAN_KEY_ORDER = ["basic", "growth", "enterprise"];
const CONTACT_LED_PLAN_KEYS = new Set(["development", "growth", "enterprise"]);
// Fallback only; the real value comes from REACT_APP_SALES_CONTACT_EMAIL (.env).
const DEFAULT_SALES_CONTACT_EMAIL = "welcome@openopps.com";

const TIERS = [
  {
    key: "development",
    name: "Development",
    commitment: "Allowance by arrangement",
    rates: [["API access", "Core endpoints"], ["Usage rates", "Basic"]],
  },
  {
    key: "basic",
    name: "Basic",
    commitment: "Prepaid from £100 per purchase",
    note: "Purchase £100 or more in prepaid credit by card. No recurring fee or overage; access pauses when your credit runs out.",
    rates: [
      ["Records / docs", "£0.13"],
      ["API calls", "£0.26"],
      ["Aggregate calls", "Not included"],
      ["Attachments", "£0.65"],
    ],
  },
  {
    key: "growth",
    name: "Growth",
    commitment: "£5,000 / yr prepaid",
    note: "Prepaid API credit for a 12-month commitment, invoiced by our team. Includes core endpoints and aggregations. Your credit draws down as you use the API.",
    rates: [
      ["Records / docs", "£0.10"],
      ["API calls", "£0.20"],
      ["Aggregate calls", "£0.35"],
      ["Attachments", "£0.50"],
    ],
  },
  {
    key: "enterprise",
    name: "Enterprise",
    commitment: "£12,000 / yr prepaid",
    note: "Our lowest unit rates, with prepaid API credit for a 12-month commitment. Includes core endpoints and aggregations. Contact our team to arrange your invoice.",
    rates: [
      ["Records / docs", "£0.07"],
      ["API calls", "£0.14"],
      ["Aggregate calls", "£0.25"],
      ["Attachments", "£0.35"],
    ],
  },
];

const PAID_TIERS = PLAN_KEY_ORDER.map((key) => TIERS.find((tier) => tier.key === key));

function catalogPlanKey(plan) {
  const configured = plan?.metadata?.plan_key;
  if (configured) return configured.trim().toLowerCase();
  const name = (plan?.name || "").toLowerCase();
  return PLAN_KEY_ORDER.find((key) => name.includes(key));
}

function checkoutPath(productId, planKey) {
  const params = new URLSearchParams({ plan_id_to_purchase: productId });
  if (planKey === "basic") {
    params.set("purchase_type", "basic_activation");
  }
  return `/checkout?${params.toString()}`;
}

function basicTopUpPath(productId) {
  const params = new URLSearchParams({
    plan_id_to_purchase: productId,
    purchase_type: "basic_credit_top_up",
  });
  return `/checkout?${params.toString()}`;
}

export default function PlansView() {
  const { idToken, userEmail } = useAuthCombined();
  const { plans, plansLoading } = usePlans();
  const { subscriptions, finishedLoading } = useSubscriptions({ idToken });
  const { planChange, refreshPlanChange } = usePlanChange({ idToken });

  const navigate = useNavigate();
  const [pending, setPending] = useState(null); // tier key awaiting confirm
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");

  // React Modal handles focus trapping, Escape, and restoring focus to the action.
  useEffect(() => {
    Modal.setAppElement("#root");
  }, []);

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
  const hasCommitment = hasActive && !["basic", "development"].includes(currentPlan);
  const contactEmail =
    import.meta.env.REACT_APP_SALES_CONTACT_EMAIL ||
    DEFAULT_SALES_CONTACT_EMAIL;

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
    if (CONTACT_LED_PLAN_KEYS.has(tierKey)) {
      setError(
        `Growth and Enterprise are arranged with our team. Contact ${contactEmail} to continue.`
      );
      setPending(null);
      return;
    }

    const productId = productByKey[tierKey];
    if (!productId) {
      setError("That plan is not available right now. Please try again shortly.");
      return;
    }

    // No active subscription yet -> take them through checkout to subscribe.
    if (!hasCommitment) {
      setPending(null);
      navigate(checkoutPath(productId, tierKey));
      return;
    }

    // Existing accounts create a reviewed upgrade or a scheduled downgrade.
    setBusy(true);
    try {
      const result = await apiRequest(
        `/create-stripe-checkout-session?plan_id=${encodeURIComponent(productId)}`,
        idToken,
        { method: "POST" }
      );
      if (result?.scheduled) {
        setPending(null);
        await refreshPlanChange();
        flash(
          result.requiresReview
            ? "Upgrade request sent for review"
            : "Downgrade scheduled"
        );
      } else if (result?.clientSecret) {
        setPending(null);
        navigate(checkoutPath(productId, tierKey));
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
  const pendingRequiresContact = Boolean(
    pendingTier && CONTACT_LED_PLAN_KEYS.has(pendingTier.key)
  );
  const contactParams = new URLSearchParams({
    subject: `Open Opportunities API ${pendingTier?.name || "commitment"} plan enquiry`,
    body: [
      `I would like to discuss the Open Opportunities API ${pendingTier?.name || "commitment"} plan.`,
      "",
      `Account email: ${userEmail || "Not provided"}`,
      `Current plan: ${currentPlan || "None"}`,
    ].join("\n"),
  });
  const contactHref = `mailto:${contactEmail}?${contactParams.toString()}`;

  const renderPlanAction = (tier) => {
    const isCurrent = currentPlan === tier.key;
    const requiresContact = CONTACT_LED_PLAN_KEYS.has(tier.key);
    if (isCurrent && tier.key !== "basic") {
      return <button className="plan-choice-button" disabled>Current plan</button>;
    }
    return (
      <button
        className={`plan-choice-button${pending === tier.key ? " plan-choice-button--selected" : ""}`}
        disabled={busy || (!isCurrent && Boolean(planChange) && !requiresContact)}
        onClick={() => {
          if (isCurrent && tier.key === "basic") {
            if (!productByKey.basic) {
              setError("Basic credit purchases are not available right now. Please try again shortly.");
              return;
            }
            navigate(basicTopUpPath(productByKey.basic));
            return;
          }
          setPending(tier.key);
        }}
      >
        {isCurrent ? "Add credit" : requiresContact ? "Contact us" : hasCommitment ? `Schedule ${tier.name}` : `Choose ${tier.name}`}
      </button>
    );
  };

  return (
    <PageLayout>
      <div className="plans-page">
        <header className="plans-page__heading">
          <div>
            <h1>Open Opportunities API plans</h1>
            <p>Prepaid access, with lower unit rates on annual commitments.</p>
          </div>
        </header>

        {error && (
          <div style={styles.errorAlert} role="alert">
            {error}
          </div>
        )}

        {planChange && (
          <div style={styles.scheduledBanner}>
            <span style={{ color: C.successText, fontSize: 14 }}>
              {planChange.change_type === "upgrade"
                ? `Upgrade to ${planChange.to_plan_key} is ${planChange.status.replaceAll("_", " ")}. Your current plan remains active until its invoice is paid.`
                : `Downgrade to ${planChange.to_plan_key} is scheduled for ${new Date(planChange.effective_at).toLocaleDateString()}.`}
            </span>
            <div style={{ flex: 1 }} />
            <button
              disabled={["invoice_open", "activating"].includes(planChange.status)}
              onClick={() => {
                apiRequest("/plan-change", idToken, { method: "DELETE" })
                  .then(() => refreshPlanChange())
                  .then(() => flash("Plan change cancelled"))
                  .catch((cancelError) =>
                    setError(cancelError.message || "Unable to cancel the plan change")
                  );
              }}
              style={styles.linkGreen}
            >
              Cancel change
            </button>
          </div>
        )}

        <div id="plan-options" className="plan-options">
          {PAID_TIERS.map((tier) => (
            <section
              key={tier.key}
              className={`plan-option${currentPlan === tier.key ? " plan-option--current" : ""}`}
              aria-labelledby={`plan-${tier.key}`}
            >
              <div className="plan-option__heading">
                <h2 id={`plan-${tier.key}`}>{tier.name}</h2>
                {currentPlan === tier.key && <span className="plan-option__badge">Current plan</span>}
              </div>
              <p className="plan-option__commitment">{tier.commitment}</p>
              <dl className="plan-option__rates" aria-label="Usage rates per unit">
                {tier.rates.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="plan-option__note">{tier.note}</p>
              {renderPlanAction(tier)}
            </section>
          ))}
        </div>

        <section className="development-banner" aria-labelledby="development-access-heading">
          <div>
            <p className="development-banner__label">Development access{currentPlan === "development" ? " · Current plan" : ""}</p>
            <h2 id="development-access-heading">Testing the API?</h2>
            <p>Speak to our team about development credits.</p>
          </div>
          <button
            className="plan-choice-button"
            disabled={busy}
            onClick={() => setPending("development")}
          >Request access</button>
        </section>
      </div>

      {pendingTier && (
          <Modal
            isOpen
            className="plans-dialog"
            overlayClassName="plans-dialog-overlay"
            onRequestClose={() => !busy && setPending(null)}
            shouldCloseOnEsc={!busy}
            shouldCloseOnOverlayClick={!busy}
            style={{ overlay: styles.backdrop, content: styles.modal }}
            aria={{ labelledby: "plan-dialog-title", describedby: "plan-dialog-description" }}
          >
              <h2 id="plan-dialog-title" style={styles.modalTitle}>
                {pendingRequiresContact
                  ? `Talk to us about ${pendingTier.name}`
                  : hasCommitment
                  ? `Switch to ${pendingTier.name}?`
                  : `Start ${pendingTier.name}`}
              </h2>
              <p id="plan-dialog-description" style={styles.modalLead}>
                {pendingRequiresContact
                  ? pendingTier.key === "development"
                    ? "Tell us what you are building. Contact us for credit to build and test your integration, at Basic rates. No payment required."
                    : `${pendingTier.name} is arranged directly with our team. We will confirm the commercial terms and provide an invoice for the annual commitment.`
                  : hasCommitment
                    ? "The downgrade will take effect at the end of your current commitment period. Nothing changes today."
                  : "Continue to secure Stripe checkout for a one-off purchase of at least £100. No recurring charges or overage."}
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
              {pendingRequiresContact ? (
                <p style={styles.modalFine}>
                  Email us at{" "}
                  <a href={`mailto:${contactEmail}`} style={styles.emailLink}>
                    {contactEmail}
                  </a>
                  . Your current access will remain unchanged while we arrange
                  the plan.
                </p>
              ) : currentPlan === "development" ? (
                <p style={styles.modalFine}>
                  Your development allowance is not carried into Basic or reset by this purchase.
                </p>
              ) : hasCommitment ? (
                <p style={styles.modalFine}>
                  Existing credit remains on the account. New rates apply only
                  after the plan change is activated.
                </p>
              ) : null}
              <div style={styles.modalActions}>
                <button
                  style={styles.btnOutlineAuto}
                  onClick={() => setPending(null)}
                  disabled={busy}
                >
                  {hasCommitment && !pendingRequiresContact
                    ? "Keep current plan"
                    : "Cancel"}
                </button>
                <button
                  style={styles.btnPrimaryAuto}
                  onClick={() => {
                    if (pendingRequiresContact) {
                      window.location.assign(contactHref);
                      setPending(null);
                      return;
                    }
                    requestChange(pendingTier.key);
                  }}
                  disabled={busy}
                >
                  {pendingRequiresContact
                    ? "Email our team"
                    : busy
                      ? "Working…"
                      : hasCommitment
                        ? "Schedule downgrade"
                        : "Continue to checkout"}
                </button>
              </div>
          </Modal>
        )}

      {toast &&
        createPortal(
          <div style={styles.toast} role="status">
            <span style={{ fontSize: 13.5, color: C.body }}>{toast}</span>
          </div>,
          document.body
        )}
    </PageLayout>
  );
}

const styles = {
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
    flexWrap: "wrap",
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
    position: "relative",
    inset: "auto",
    width: "100%",
    maxWidth: 470,
    maxHeight: "calc(100dvh - 48px)",
    overflowY: "auto",
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    boxShadow: "0 24px 60px rgba(35,56,58,0.24)",
    padding: 26,
  },
  modalTitle: { fontSize: 19, fontWeight: 500, color: C.head, margin: "0 0 8px" },
  modalLead: { margin: "0 0 18px", fontSize: 14, lineHeight: 1.6, color: C.muted },
  modalSummary: {
    borderTop: `1px solid ${C.line}`,
    borderBottom: `1px solid ${C.line}`,
    padding: "16px 0",
    marginBottom: 18,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  summaryRow: { display: "grid", gridTemplateColumns: "minmax(84px, 1fr) minmax(0, 1.4fr)", gap: 12, fontSize: 13.5 },
  modalFine: { margin: "0 0 20px", fontSize: 12.5, lineHeight: 1.55, color: C.muted },
  emailLink: { color: C.green, fontWeight: 500 },
  modalActions: { display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 10 },
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
};
