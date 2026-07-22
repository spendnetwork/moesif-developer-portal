import { useEffect } from "react";

// Absolute session cap for the developer portal. Auth0 refresh tokens would
// otherwise renew the session indefinitely, so we force a logout a fixed
// number of hours after the initial login regardless of activity.
export const SESSION_MAX_HOURS = 8;
const SESSION_MAX_MS = SESSION_MAX_HOURS * 60 * 60 * 1000;
const SESSION_START_KEY = "oo-portal-session-start";

export function clearSessionStart() {
  localStorage.removeItem(SESSION_START_KEY);
}

export default function useSessionTimeout({ isAuthenticated, onExpire }) {
  useEffect(() => {
    if (!isAuthenticated) {
      clearSessionStart();
      return undefined;
    }

    let start = Number(localStorage.getItem(SESSION_START_KEY));
    if (!start || Number.isNaN(start)) {
      start = Date.now();
      localStorage.setItem(SESSION_START_KEY, String(start));
    }

    const remaining = start + SESSION_MAX_MS - Date.now();
    if (remaining <= 0) {
      onExpire();
      return undefined;
    }

    const timer = setTimeout(onExpire, remaining);
    return () => clearTimeout(timer);
  }, [isAuthenticated, onExpire]);
}
