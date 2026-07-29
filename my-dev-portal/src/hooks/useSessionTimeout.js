import { useEffect } from "react";

// Absolute session cap for the developer portal. Auth0 refresh tokens would
// otherwise renew the session indefinitely, so we force a logout a fixed
// number of hours after the initial login regardless of activity.
export const SESSION_MAX_HOURS = 8;
const SESSION_MAX_MS = SESSION_MAX_HOURS * 60 * 60 * 1000;
const SESSION_START_KEY = "oo-portal-session-start";

// A single setTimeout across many hours is unreliable: browsers throttle
// background tabs and suspended/sleeping machines don't fire it on wake. Poll
// as well, and re-check whenever the tab becomes visible again.
const CHECK_INTERVAL_MS = 30 * 1000;

export function clearSessionStart() {
  localStorage.removeItem(SESSION_START_KEY);
}

function getSessionStart() {
  const start = Number(localStorage.getItem(SESSION_START_KEY));
  return !start || Number.isNaN(start) ? null : start;
}

// `isReady` must be false while Auth0 is still restoring a session. It reports
// isAuthenticated === false during that window, and clearing the stored start
// time then would silently restart the 8-hour clock on every page reload —
// making the cap unenforceable for anyone who refreshes.
export default function useSessionTimeout({
  isAuthenticated,
  isReady = true,
  onExpire,
}) {
  useEffect(() => {
    if (!isReady) return undefined;

    if (!isAuthenticated) {
      clearSessionStart();
      return undefined;
    }

    let start = getSessionStart();
    if (start === null) {
      start = Date.now();
      localStorage.setItem(SESSION_START_KEY, String(start));
    }

    const deadline = start + SESSION_MAX_MS;
    let timer;
    let interval;

    const check = () => {
      if (Date.now() < deadline) return false;
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      onExpire();
      return true;
    };

    function onVisible() {
      if (document.visibilityState === "visible") check();
    }

    if (check()) return undefined;

    timer = setTimeout(check, deadline - Date.now());
    interval = setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isAuthenticated, isReady, onExpire]);
}
