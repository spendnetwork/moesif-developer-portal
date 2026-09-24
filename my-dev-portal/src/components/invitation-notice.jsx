import React from "react";
import useSWR from "swr";
import useAuthCombined from "../hooks/useAuthCombined";
import { apiRequest, authedFetcher } from "../lib/portal-api";

export default function InvitationNotice() {
  const { idToken } = useAuthCombined();
  const [error, setError] = React.useState("");
  const { data, mutate } = useSWR(idToken ? ["/invitation-notifications", idToken] : null, authedFetcher, { refreshInterval: 60000, shouldRetryOnError: false });
  if (!data?.items?.length) return null;
  return <section aria-label="Credit notifications" style={{ borderBottom: "1px solid #dde5e0", padding: "16px 0", marginBottom: 20 }}>
    {data.items.map(item => <div key={item.id} style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
      <p role="status">{new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(item.amount_gbp_pence / 100)} development credit granted. Valid until {new Date(item.credit_receipt.expires_at).toLocaleDateString("en-GB")}.</p>
      <button type="button" onClick={async () => { try { await apiRequest(`/invitation-notifications/${item.id}/dismiss`, idToken, { method: "POST" }); await mutate(); } catch { setError("We could not dismiss this notification. Try again."); } }}>Dismiss</button>
    </div>)}{error && <p role="alert">{error}</p>}
  </section>;
}
