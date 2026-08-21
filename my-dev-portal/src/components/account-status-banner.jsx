import React from "react";
import useSWR from "swr";
import useAuthCombined from "../hooks/useAuthCombined";
import { authedFetcher } from "../lib/portal-api";

const SUPPORT_EMAIL =
  import.meta.env.REACT_APP_SALES_CONTACT_EMAIL || "welcome@openopps.com";

// Global banner shown when an admin has paused the organisation's API access.
// Reads the same /portal-context the rest of the portal uses, and polls so a
// pause/resume from the admin tool appears without a manual page refresh.
export default function AccountStatusBanner() {
  const { idToken } = useAuthCombined();
  const { data } = useSWR(
    idToken ? ["/portal-context", idToken] : null,
    authedFetcher,
    { refreshInterval: 60000, revalidateOnFocus: true, shouldRetryOnError: false }
  );

  if (!data?.access_paused) return null;

  return (
    <div role="alert" style={styles.banner}>
      <span style={styles.dot} aria-hidden="true" />
      <div>
        <div style={styles.title}>API access suspended</div>
        <div style={styles.body}>
          Your organisation&rsquo;s API access is currently paused, so API
          requests are being rejected. Please contact{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={styles.link}>
            {SUPPORT_EMAIL}
          </a>{" "}
          to restore access.
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
    borderRadius: 10,
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
