const KEY = "openopps.pending-invitation.v1";
export function skipInvitationAnalytics(event) {
  try {
    const path = new URL(event?.request?.uri || "", "https://portal.invalid").pathname;
    return /\/(?:invitations|invitation-notifications|notifications)(?:\/|$)/.test(path);
  } catch { return true; }
}
export function captureInvitation() {
  if (window.location.pathname !== "/signup") return;
  const value = new URLSearchParams(window.location.hash.slice(1)).get("invitation");
  if (!value) return;
  // Remove the bearer link from the address bar before any analytics starts.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  try {
    if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("invalid");
    sessionStorage.setItem(KEY, JSON.stringify({ token: value, savedAt: Date.now() }));
  } catch {
    window.__invitationCaptureFailed = true;
  }
}
export function pendingInvitation() {
  try {
    const entry = JSON.parse(sessionStorage.getItem(KEY));
    if (typeof entry?.token !== "string" || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(entry.token) ||
        !Number.isFinite(entry.savedAt) || entry.savedAt > Date.now() || Date.now() - entry.savedAt > 7 * 86400000) return null;
    return entry.token;
  } catch { return null; }
}
export function clearInvitation() { try { sessionStorage.removeItem(KEY); } catch { /* The server still prevents repeated grants. */ } }
