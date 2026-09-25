import React, { useState } from "react";
import useSWR from "swr";
import Modal from "react-modal";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { apiRequest, authedFetcher } from "../../../lib/portal-api";

const C = {
  green: "#034737",
  head: "#23383A",
  body: "#23302C",
  muted: "#647873",
  line: "#DDE5E0",
  lineSoft: "#EEF2EF",
  dangerBg: "#FDE8E5",
  dangerInk: "#8B2C21",
  warnBg: "#FFF1B8",
  warnInk: "#725300",
};

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

// Mirrors Keys.jsx's list + create-modal pattern: SWR list, apiRequest POST,
// mutate()-driven refresh.
export default function Team({ isOrgAdmin }) {
  const { idToken } = useAuthCombined();
  const membersKey = isOrgAdmin && idToken ? ["/team-members", idToken] : null;
  const invitesKey = isOrgAdmin && idToken ? ["/team-invitations", idToken] : null;
  const { data: membersData, mutate: mutateMembers } = useSWR(membersKey, authedFetcher);
  const { data: invitesData, mutate: mutateInvites } = useSWR(invitesKey, authedFetcher);
  const [modalOpen, setModalOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!isOrgAdmin) return null;

  async function invite(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiRequest("/team-invitations", idToken, {
        method: "POST",
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          email: email.trim().toLowerCase(),
          fullName: fullName.trim(),
        }),
      });
      setModalOpen(false);
      setEmail("");
      setFullName("");
      await mutateInvites();
    } catch (failure) {
      setError(failure.message || "This teammate could not be invited. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const members = membersData?.members || [];
  const pending = (invitesData?.items || []).filter((item) => item.status === "pending");

  return (
    <div style={styles.card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={styles.title}>Team</div>
          <p style={styles.body}>
            Everyone here shares this organization's billing, credit balance and usage. Each person manages their
            own API keys.
          </p>
        </div>
        <button type="button" className="btn-primary" style={styles.primaryBtn} onClick={() => setModalOpen(true)}>
          Invite teammate
        </button>
      </div>

      {members.length > 0 && (
        <ul style={styles.list}>
          {members.map((member) => (
            <li key={member.id} style={styles.listItem}>
              <div>
                <div style={styles.memberName}>{member.full_name || member.email}</div>
                <div style={styles.memberEmail}>{member.email}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {member.is_org_admin && <span style={{ ...styles.badge, background: C.lineSoft, color: C.green }}>Admin</span>}
                {!member.is_active && <span style={{ ...styles.badge, background: C.dangerBg, color: C.dangerInk }}>Suspended</span>}
                {member.pending_invitation_id && <span style={{ ...styles.badge, background: C.warnBg, color: C.warnInk }}>Invitation pending</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <>
          <div style={styles.subheading}>Invited, not yet joined</div>
          <ul style={styles.list}>
            {pending.map((item) => (
              <li key={item.id} style={styles.listItem}>
                <div>
                  <div style={styles.memberName}>{item.full_name}</div>
                  <div style={styles.memberEmail}>{item.email}</div>
                </div>
                <span style={{ ...styles.badge, background: C.warnBg, color: C.warnInk }}>
                  Expires {formatDate(item.expires_at)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <Modal
        isOpen={modalOpen}
        onRequestClose={() => !busy && setModalOpen(false)}
        contentLabel="Invite teammate"
        style={{ content: styles.modalContent, overlay: styles.modalOverlay }}
        ariaHideApp={false}
      >
        <h2 style={styles.modalTitle}>Invite a teammate</h2>
        <p style={styles.body}>
          They'll get an email to join this organization. No development credit is granted for joining.
        </p>
        <form onSubmit={invite}>
          <label style={styles.label}>
            Full name
            <input style={styles.input} type="text" required maxLength={200} value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </label>
          <label style={styles.label}>
            Email address
            <input style={styles.input} type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          {error && <p role="alert" style={{ color: C.dangerInk, fontSize: 13 }}>{error}</p>}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button type="button" className="btn-outline" disabled={busy} onClick={() => setModalOpen(false)} style={styles.outlineBtn}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy} style={styles.primaryBtn}>
              {busy ? "Sending invitation..." : "Send invitation"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

const styles = {
  card: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 24,
    marginBottom: 16,
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  title: { fontSize: 15, fontWeight: 500, color: C.head, marginBottom: 5 },
  body: { margin: 0, fontSize: 13.5, color: C.muted, maxWidth: 480 },
  subheading: { fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", color: C.muted, marginTop: 20, marginBottom: 8 },
  list: { listStyle: "none", margin: "16px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 2 },
  listItem: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
    padding: "10px 0", borderTop: `1px solid ${C.lineSoft}`,
  },
  memberName: { fontSize: 14, color: C.body, fontWeight: 500 },
  memberEmail: { fontSize: 13, color: C.muted },
  badge: { fontSize: 11.5, fontWeight: 500, padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap" },
  primaryBtn: { fontSize: 14, fontWeight: 500, padding: "10px 16px", borderRadius: 8, whiteSpace: "nowrap" },
  outlineBtn: { fontSize: 14, fontWeight: 500, padding: "10px 16px", borderRadius: 8, whiteSpace: "nowrap" },
  modalTitle: { margin: "0 0 8px", fontSize: 19, fontWeight: 500, color: C.head },
  label: { display: "block", fontSize: 13, color: C.muted, marginTop: 14 },
  input: {
    display: "block", width: "100%", boxSizing: "border-box", marginTop: 6, padding: "9px 11px",
    border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 14, color: C.body, font: "inherit",
  },
  modalContent: {
    position: "static", maxWidth: 420, margin: "10vh auto", padding: 24, borderRadius: 12,
    border: `1px solid ${C.line}`, inset: "auto",
  },
  modalOverlay: { background: "rgba(35,56,58,0.34)", display: "flex" },
};
