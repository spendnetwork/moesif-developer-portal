import React, { useCallback, useEffect, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { useSWRConfig } from "swr";

import useSessionTimeout, {
  clearSessionStart,
} from "../hooks/useSessionTimeout";
import {
  loggedOutReturnTo,
  onSessionExpired,
  resetSessionExpiry,
} from "../lib/session-expiry";

// Owns every route out of an authenticated session. Two things can end one:
//
//   1. the absolute time cap in useSessionTimeout, and
//   2. a 401 from the portal API (token expired early, or revoked), raised
//      through lib/session-expiry.
//
// Both run the same teardown — clear the session clock, drop cached data,
// reset Moesif identity, then sign out at Auth0 and return to the home page
// with ?session=expired so the user is asked to sign back in. Previously only
// (1) was handled, so an expired token left the user on a signed-in-looking
// page showing "we could not load…" errors.
export default function SessionTimeout() {
  const { isAuthenticated, isLoading, logout } = useAuth0();

  // Covers the gap between deciding to log out and the browser actually
  // leaving the page, so no page flashes a stale error in the meantime.
  const [signingOut, setSigningOut] = useState(false);
  const { mutate } = useSWRConfig();

  const onExpire = useCallback(() => {
    setSigningOut(true);
    clearSessionStart();
    // Wipe cached SWR responses so no keys, usage or subscription data from
    // the finished session can reappear.
    try {
      mutate(() => true, undefined, { revalidate: false });
    } catch (err) {
      console.error("failed to clear cached portal data", err);
    }
    window.moesif?.reset();
    // NOTE: this URL must be listed in the Auth0 application's "Allowed Logout
    // URLs", otherwise Auth0 rejects the redirect.
    logout({ logoutParams: { returnTo: loggedOutReturnTo() } });
  }, [logout, mutate]);

  useSessionTimeout({ isAuthenticated, isReady: !isLoading, onExpire });

  useEffect(() => onSessionExpired(onExpire), [onExpire]);

  // A fresh login re-arms the expiry latch for this tab.
  useEffect(() => {
    if (isAuthenticated) resetSessionExpiry();
  }, [isAuthenticated]);

  if (!signingOut) return null;

  return (
    <div className="session-signout-overlay" role="status">
      <span className="page-loader__spinner" aria-hidden="true"></span>
      <p>Your session has expired. Signing you out…</p>
    </div>
  );
}
