import React, { useState } from "react";
import useSWR from "swr";
import { Bell, Check, RefreshCw } from "lucide-react";
import { PageLayout } from "../../page-layout";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { apiRequest, authedFetcher } from "../../../lib/portal-api";
import "../../../styles/components/notifications.css";

export default function Notifications() {
  const { idToken } = useAuthCombined();
  const { data, error, isValidating, mutate } = useSWR(idToken ? ["/notifications", idToken] : null, authedFetcher,
    { refreshInterval: 60000, revalidateOnFocus: true, shouldRetryOnError: false, keepPreviousData: false });
  const [pending, setPending] = useState(null);
  const [actionError, setActionError] = useState("");
  async function markRead(id) {
    setPending(id);
    setActionError("");
    try {
      await apiRequest(`/notifications/${encodeURIComponent(id)}/read`, idToken, { method: "POST" });
      await mutate();
    } catch { setActionError("We could not mark this notification as read. Please try again."); }
    finally { setPending(null); }
  }
  return <PageLayout>
    <section className="notifications-page" aria-labelledby="notifications-title">
      <header className="notifications-heading">
        <div><p className="notifications-eyebrow">Account</p><h1 id="notifications-title">Notifications</h1></div>
        <button className="notifications-icon" type="button" onClick={() => mutate()} disabled={!idToken || isValidating}
          aria-label="Refresh notifications" title="Refresh notifications"><RefreshCw size={19} aria-hidden="true" /></button>
      </header>
      {(error || actionError) && <p role="alert" className="notifications-error">{actionError || (error.status === 403
        ? "Account notifications are available to company administrators."
        : "Notifications are temporarily unavailable. Please try again.")}</p>}
      {!data && !error && <p role="status">Loading notifications...</p>}
      {data?.length === 0 && <div className="notifications-empty"><Bell size={28} aria-hidden="true" /><h2>You are up to date</h2><p>No account notifications yet.</p></div>}
      {data?.length > 0 && <ol className="notifications-list">
        {data.map(item => <li key={item.id} className={`notification-row${item.read_at ? "" : " notification-row--unread"}`}>
          <span className="notification-indicator" aria-label={item.read_at ? "Read" : "Unread"} />
          <div className="notification-content"><h2>{item.heading}</h2><p>{item.message}</p>
            <time dateTime={item.created_at}>{new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.created_at))}</time>
          </div>
          {!item.read_at && <button className="notifications-icon" type="button" disabled={Boolean(pending)}
            onClick={() => markRead(item.id)} title="Mark as read" aria-label={`Mark as read: ${item.heading}`}>
            <Check size={19} aria-hidden="true" /></button>}
        </li>)}
      </ol>}
    </section>
  </PageLayout>;
}
