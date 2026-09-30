import React, { useState } from "react";
import useSWR from "swr";
import Modal from "react-modal";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { apiRequest, authedFetcher } from "../../../lib/portal-api";

const C = {
  green: "#034737",
  mint: "#A9FF9B",
  head: "#23383A",
  body: "#23302C",
  muted: "#647873",
  line: "#DDE5E0",
  lineSoft: "#EEF2EF",
  page: "#F5F7F4",
  danger: "#8B2C21",
  warnBg: "#FFF1B8",
  warnInk: "#725300",
  warnLine: "#EFDE96",
};

// Same dialog as the Keys page, so every confirmation in the portal looks alike.
const modalStyles = {
  content: {
    top: "50%", left: "50%", right: "auto", bottom: "auto",
    width: "min(30rem, calc(100vw - 3.2rem))", maxHeight: "calc(100vh - 4rem)",
    padding: 0, border: "none", borderRadius: 14, overflow: "hidden",
    transform: "translate(-50%, -50%)", boxShadow: "0 20px 60px rgba(15,30,25,0.28)",
  },
  overlay: { backgroundColor: "rgba(15, 30, 25, 0.5)", zIndex: 20 },
};

const MESSAGES = {
  invitation_already_pending: "This person already has a pending invitation.",
  invitation_request_conflict: "This invitation was already sent with different details. Refresh the page.",
  team_invitations_require_wallet: "Add credit to your account before inviting team members.",
  organization_admin_required: "Only your organisation's admin can manage the team.",
  organization_admin_not_removable: "Admins can't be removed here. Contact our team for help.",
  organization_member_not_found: "This person is no longer on your team. Refresh the page.",
  invitation_not_pending: "This invitation has already been accepted, cancelled or has expired.",
  invitation_not_found: "This invitation could not be found. Refresh the page.",
};
const message = (failure, fallback) => MESSAGES[failure?.code] || fallback;

function initials(name, email) {
  const source = (name || email || "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)).toUpperCase();
}

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export default function Team({ isOrgAdmin, currentUserId, organisationName }) {
  const { idToken } = useAuthCombined();
  const enabled = isOrgAdmin && idToken;
  const { data: membersData, error: membersError, mutate: mutateMembers } = useSWR(enabled ? ["/team-members", idToken] : null, authedFetcher);
  const { data: invitesData, mutate: mutateInvites } = useSWR(enabled ? ["/team-invitations", idToken] : null, authedFetcher);
  const [modal, setModal] = useState(null); // "invite" | "remove"
  const [selected, setSelected] = useState(null);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");

  if (!isOrgAdmin) return null;
  const team = organisationName || "your organisation";

  function open(kind, member = null) {
    setError("");
    setSelected(member);
    setModal(kind);
  }
  function close() {
    if (busy) return;
    setModal(null);
    setSelected(null);
    setError("");
  }

  async function invite(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiRequest("/team-invitations", idToken, {
        method: "POST",
        body: JSON.stringify({ requestId: crypto.randomUUID(), email: email.trim().toLowerCase(), fullName: fullName.trim() }),
      });
      setEmail("");
      setFullName("");
      setModal(null);
      await mutateInvites();
    } catch (failure) {
      setError(message(failure, "The invitation could not be sent. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember() {
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/team-members/${selected.id}/remove`, idToken, { method: "POST" });
      setModal(null);
      setSelected(null);
      await Promise.all([mutateMembers(), mutateInvites()]);
    } catch (failure) {
      setError(message(failure, "This team member could not be removed. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function cancelInvitation(item) {
    setCancelling(item.id);
    setListError("");
    try {
      await apiRequest(`/team-invitations/${item.id}/revoke`, idToken, {
        method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID() }),
      });
      await mutateInvites();
    } catch (failure) {
      setListError(message(failure, "The invitation could not be cancelled. Try again."));
    } finally {
      setCancelling(null);
    }
  }

  // Removed and suspended people no longer have access, so they are not listed.
  const members = (membersData?.members || []).filter((member) => member.is_active);
  const pending = (invitesData?.items || []).filter((item) => item.status === "pending");

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>Team</div>
          <p style={styles.body}>Everyone on your team shares {team}’s credit and usage. Each person has their own API keys.</p>
        </div>
        <button type="button" className="btn-outline" style={styles.outlineBtn} onClick={() => open("invite")}>
          Invite team member
        </button>
      </div>

      {membersError && <p role="alert" style={styles.inlineError}>Your team could not be loaded. Refresh the page to try again.</p>}
      {listError && <p role="alert" style={styles.inlineError}>{listError}</p>}

      {members.length > 0 && (
        <>
          <div style={styles.sectionLabel}>Members</div>
          <ul style={styles.list}>
            {members.map((member) => {
              const isYou = member.id === currentUserId;
              const removable = !isYou && !member.is_org_admin;
              return (
                <li key={member.id} style={styles.row}>
                  <div style={styles.person}>
                    <div style={styles.avatar} aria-hidden="true">{initials(member.full_name, member.email)}</div>
                    <div style={{ minWidth: 0 }}>
                      <div style={styles.name}>
                        {member.full_name || member.email}
                        {isYou && <span style={styles.you}>You</span>}
                      </div>
                      <div style={styles.email}>{member.email}</div>
                    </div>
                  </div>
                  <div style={styles.actions}>
                    {member.pending_invitation_id
                      ? <span style={styles.pendingPill}>Not yet joined</span>
                      : <span style={styles.role}>{member.is_org_admin ? "Admin" : "Member"}</span>}
                    {removable && (
                      <button type="button" className="btn-danger-outline" style={styles.smallBtn} onClick={() => open("remove", member)}>
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {pending.length > 0 && (
        <>
          <div style={styles.sectionLabel}>Invitations</div>
          <ul style={styles.list}>
            {pending.map((item) => (
              <li key={item.id} style={styles.row}>
                <div style={styles.person}>
                  <div style={styles.avatarPending} aria-hidden="true">{initials(item.full_name, item.email)}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={styles.name}>{item.full_name || item.email}</div>
                    <div style={styles.email}>
                      {item.email}{formatDate(item.expires_at) && ` · Expires ${formatDate(item.expires_at)}`}
                    </div>
                  </div>
                </div>
                <div style={styles.actions}>
                  <button type="button" className="btn-outline" style={styles.smallBtn} disabled={cancelling === item.id}
                    onClick={() => cancelInvitation(item)}>
                    {cancelling === item.id ? "Cancelling…" : "Cancel invitation"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Modal isOpen={Boolean(modal)} onRequestClose={close} style={modalStyles} ariaHideApp={false}
        contentLabel={modal === "remove" ? "Remove team member" : "Invite team member"}>
        {modal === "invite" && (
          <form onSubmit={invite}>
            <div style={styles.modalHead}>
              <div style={styles.modalTitle}>Invite team member</div>
              <p style={styles.modalSub}>We’ll email them an invitation to join {team}. They’ll share your credit and create their own API keys.</p>
            </div>
            <div style={styles.modalBody}>
              {error && <div style={styles.inlineError} role="alert">{error}</div>}
              <div style={styles.field}>
                <label htmlFor="team-name" style={styles.label}>Full name</label>
                <input id="team-name" style={styles.input} type="text" required maxLength={200} autoFocus
                  value={fullName} onChange={(event) => setFullName(event.target.value)} />
              </div>
              <div style={styles.field}>
                <label htmlFor="team-email" style={styles.label}>Work email</label>
                <input id="team-email" style={styles.input} type="email" required maxLength={254}
                  value={email} onChange={(event) => setEmail(event.target.value)} />
              </div>
            </div>
            <div style={styles.modalActions}>
              <button type="button" className="btn-outline" style={styles.outlineBtn} disabled={busy} onClick={close}>Cancel</button>
              <button type="submit" className="btn-solid" style={{ ...styles.primaryBtn, opacity: busy ? 0.55 : 1 }} disabled={busy}>
                {busy ? "Sending…" : "Send invitation"}
              </button>
            </div>
          </form>
        )}
        {modal === "remove" && selected && (
          <div>
            <div style={styles.modalHead}>
              <div style={styles.modalTitle}>Remove {selected.full_name || selected.email}?</div>
              <p style={styles.modalSub}>They’ll lose access to {team} straight away.</p>
            </div>
            <div style={styles.modalBody}>
              {error && <div style={styles.inlineError} role="alert">{error}</div>}
              <p style={{ margin: 0, fontSize: 14, color: C.body, lineHeight: 1.55 }}>
                Their API keys will be revoked and any requests using them will fail. To add them back later, contact our team.
              </p>
            </div>
            <div style={styles.modalActions}>
              <button type="button" className="btn-outline" style={styles.outlineBtn} disabled={busy} onClick={close}>Cancel</button>
              <button type="button" className="btn-danger-solid" style={{ ...styles.primaryBtn, opacity: busy ? 0.55 : 1 }}
                disabled={busy} onClick={removeMember}>
                {busy ? "Removing…" : "Remove member"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const button = { fontSize: 14, fontWeight: 500, padding: "10px 16px", borderRadius: 8, whiteSpace: "nowrap", cursor: "pointer" };

const styles = {
  card: {
    background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 12, padding: 24,
    marginBottom: 16, boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, flexWrap: "wrap" },
  title: { fontSize: 15, fontWeight: 500, color: C.head, marginBottom: 5 },
  body: { margin: 0, fontSize: 13.5, color: C.muted, maxWidth: 440 },
  sectionLabel: {
    fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: C.muted,
    paddingTop: 22, marginTop: 22, borderTop: `1px solid ${C.lineSoft}`,
  },
  list: { listStyle: "none", margin: "6px 0 0", padding: 0 },
  row: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap",
    padding: "12px 0", borderBottom: `1px solid ${C.lineSoft}`,
  },
  person: { display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: "1 1 220px" },
  avatar: {
    width: 36, height: 36, borderRadius: 999, background: C.mint, color: C.green, flex: "none",
    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 500,
  },
  avatarPending: {
    width: 36, height: 36, borderRadius: 999, background: C.page, color: C.muted, border: `1px dashed ${C.line}`,
    boxSizing: "border-box", flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 13, fontWeight: 500,
  },
  name: { fontSize: 14, fontWeight: 500, color: C.body, display: "flex", alignItems: "center", gap: 8, overflowWrap: "anywhere" },
  email: { fontSize: 13, color: C.muted, overflowWrap: "anywhere" },
  you: { fontSize: 11.5, fontWeight: 500, color: C.green, background: C.lineSoft, borderRadius: 999, padding: "2px 8px" },
  actions: { display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" },
  role: { fontSize: 13, color: C.muted },
  pendingPill: {
    fontSize: 11.5, fontWeight: 500, padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap",
    color: C.warnInk, background: C.warnBg, border: `1px solid ${C.warnLine}`,
  },
  smallBtn: { fontSize: 13, fontWeight: 500, padding: "8px 12px", borderRadius: 8, whiteSpace: "nowrap", cursor: "pointer" },
  outlineBtn: button,
  primaryBtn: button,
  inlineError: {
    margin: "16px 0 0", background: "#FDE8E5", border: "1px solid #F5CFC9", borderRadius: 8,
    padding: "10px 12px", fontSize: 13.5, color: C.danger,
  },
  modalHead: { padding: "22px 24px 0" },
  modalTitle: { fontSize: 18, fontWeight: 500, color: C.head, overflowWrap: "anywhere" },
  modalSub: { margin: "6px 0 0", fontSize: 13.5, color: C.muted, lineHeight: 1.5 },
  modalBody: { padding: 24, display: "flex", flexDirection: "column", gap: 16 },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, padding: "0 24px 24px", flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: 7 },
  label: { fontSize: 13, color: C.head },
  input: {
    border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", fontSize: 14, color: C.body,
    background: "#FFFFFF", font: "inherit",
  },
};
