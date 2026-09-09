import React from "react";
import useSWR from "swr";
import useAuthCombined from "../hooks/useAuthCombined";
import { authedFetcher, publicFetcher } from "../lib/portal-api";
import { Link } from "react-router-dom";
import useUsageSummary from "../hooks/useUsageSummary";

const SUPPORT_EMAIL =
  import.meta.env.REACT_APP_SALES_CONTACT_EMAIL || "welcome@openopps.com";

// API access is independent of portal access, including when credit runs out.
export default function AccountStatusBanner() {
  const { idToken } = useAuthCombined();
  const { usage } = useUsageSummary({ idToken });
  const { data } = useSWR(
    idToken ? ["/portal-context", idToken] : null,
    authedFetcher,
    { refreshInterval: 60000, revalidateOnFocus: true, shouldRetryOnError: false }
  );

  const reason = usage ? usage.accessBlockReason : data?.access_block_reason;
  const planKey = usage ? usage.planKey : data?.current_plan_key;
  const isDevelopment = planKey === "development";
  const isBasic = planKey === "basic";
  const isExhausted = reason === "insufficient_credit";
  const paused = data?.access_paused || reason === "access_paused";
  const { data: catalog } = useSWR(idToken && isBasic && isExhausted ? "/plans" : null, publicFetcher);
  const basicProduct = catalog?.hits?.find(plan => plan.status === "active" &&
    (plan.metadata?.plan_key?.toLowerCase() === "basic" || /^basic\b/i.test(plan.name || "")));
  const topUpPath = basicProduct
    ? `/checkout?${new URLSearchParams({ plan_id_to_purchase: basicProduct.id, purchase_type: "basic_credit_top_up" })}`
    : "/subscription";
  if (!paused && (!planKey || !reason)) return null;

  return (
    <div role="alert" style={styles.banner}>
      <span style={styles.dot} aria-hidden="true" />
      <div>
        <div style={styles.title}>
          {paused ? "API access paused" : isExhausted ? isDevelopment ? "Development allowance exhausted" : "Prepaid credit exhausted" : "API access unavailable"}
        </div>
        <div style={styles.body}>
          API requests are blocked. Your portal, API keys and usage history remain
          available. Contact{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={styles.link}>
            {SUPPORT_EMAIL}
          </a>{" "}
          {isExhausted && !paused ? isDevelopment ? "to discuss development allowance or a Growth or Enterprise commitment, or " : "to discuss a Growth or Enterprise commitment, or " : "to restore access, or review "}
          <Link to={isBasic && isExhausted && !paused ? topUpPath : "/plans"} style={styles.link}>
            {isExhausted && !paused ? isBasic ? "Add credit from £100" : "choose Basic prepaid from £100" : "your plan options"}
          </Link>.
        </div>
      </div>
    </div>
  );
}

const styles = {
  banner: {
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
    background: "#FCE8E6",
    border: "1px solid #E2ABA3",
    borderRadius: 8,
    padding: "12px 16px",
    margin: "0 0 20px",
    color: "#8B2C21",
  },
  dot: {
    flex: "none",
    width: 10,
    height: 10,
    borderRadius: 999,
    background: "#C0392B",
    marginTop: 5,
  },
  title: { fontWeight: 600, fontSize: 14, marginBottom: 2 },
  body: { fontSize: 13, lineHeight: 1.5 },
  link: { color: "#8B2C21", textDecoration: "underline", fontWeight: 600 },
};
