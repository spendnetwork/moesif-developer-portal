import React, { useCallback } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { useOktaAuth } from "@okta/okta-react";

import useSessionTimeout, { clearSessionStart } from "../hooks/useSessionTimeout";

function SessionTimeoutAuth0() {
  const { isAuthenticated, logout } = useAuth0();

  const onExpire = useCallback(() => {
    clearSessionStart();
    window.moesif?.reset();
    logout({ logoutParams: { returnTo: window.location.origin } });
  }, [logout]);

  useSessionTimeout({ isAuthenticated, onExpire });
  return null;
}

function SessionTimeoutOkta() {
  const { authState, oktaAuth } = useOktaAuth();
  const isAuthenticated = Boolean(authState?.isAuthenticated);

  const onExpire = useCallback(() => {
    clearSessionStart();
    window.moesif?.reset();
    oktaAuth.signOut();
  }, [oktaAuth]);

  useSessionTimeout({ isAuthenticated, onExpire });
  return null;
}

export default function SessionTimeout() {
  if (import.meta.env.REACT_APP_AUTH_PROVIDER === "Okta") {
    return <SessionTimeoutOkta />;
  }
  return <SessionTimeoutAuth0 />;
}
