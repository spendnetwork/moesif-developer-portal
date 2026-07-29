// Central "the session is over" signal.
//
// Two things can end a session: the absolute time cap in useSessionTimeout,
// or the portal API rejecting a token (401/403). Both funnel through here so
// there is exactly one logout path, instead of individual pages rendering
// their own "could not load…" errors while the user sits in a broken,
// half-authenticated state.
//
// session-timeout.jsx is the only subscriber in practice: it performs the
// provider-specific logout and sends the user back to the home page with
// ?session=expired so the sign-in prompt can be shown.

// Query param used to tell the home page to prompt for re-authentication.
export const SESSION_EXPIRED_PARAM = "session";
export const SESSION_EXPIRED_VALUE = "expired";

const listeners = new Set();

// Once a logout is in flight, further 401s (SWR often has several requests
// in parallel) must not re-trigger it or we'd loop on redirects.
let expiring = false;

// If a 401 lands before the listener has mounted, remember it and fire as
// soon as someone subscribes — otherwise the signal would be swallowed and
// the user would be left stranded on a broken page.
let pending = false;

function emit() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error("session expiry listener failed", err);
    }
  });
}

export function onSessionExpired(listener) {
  listeners.add(listener);
  if (pending) {
    pending = false;
    listener();
  }
  return () => listeners.delete(listener);
}

export function notifySessionExpired() {
  if (expiring) return;
  expiring = true;
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  emit();
}

// Called when a fresh session starts so a later expiry can fire again in the
// same tab, without needing a full page load to reset module state.
export function resetSessionExpiry() {
  expiring = false;
  pending = false;
}

// True for errors thrown by portal-api that mean "your credentials are no
// longer good", so pages can skip their generic error UI.
export function isSessionExpiredError(error) {
  return Boolean(error?.sessionExpired);
}

// Absolute URL to return to after logout, carrying the prompt flag.
export function loggedOutReturnTo() {
  return `${window.location.origin}/?${SESSION_EXPIRED_PARAM}=${SESSION_EXPIRED_VALUE}`;
}
