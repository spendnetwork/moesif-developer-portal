import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Navigate } from "react-router-dom";
import openOpportunitiesLogo from "../../../images/assets/open-opportunities-logo.png";
import "../../../styles/components/signup.css";
import { pendingInvitation } from "../../../lib/invitation-session";

export default function Signup() {
  const { isLoading, isAuthenticated, loginWithRedirect } = useAuth0();
  const started = useRef(false);
  const mounted = useRef(false);
  const [failed, setFailed] = useState(false);
  const invited = Boolean(pendingInvitation());

  const begin = useCallback(async (signup = true) => {
    if (started.current) return;
    started.current = true;
    setFailed(false);
    try {
      await loginWithRedirect({
        appState: { returnTo: invited ? "/invitation" : signup ? "/welcome" : "/dashboard" },
        authorizationParams: {
          prompt: "login",
          ...(signup ? { screen_hint: "signup" } : {}),
          scope: "openid profile email offline_access",
        },
      });
    } catch {
      started.current = false;
      if (mounted.current) setFailed(true);
    }
  }, [loginWithRedirect, invited]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !failed && !window.__invitationCaptureFailed) void begin();
  }, [isLoading, isAuthenticated, failed, begin]);

  // A public signup link never forces an existing customer to register again.
  if (window.__invitationCaptureFailed) return <main className="signup-entry"><h1>Invitation could not be opened</h1><p role="alert">Allow session storage and open the invitation email again.</p></main>;
  if (!isLoading && isAuthenticated) return <Navigate to={invited ? "/invitation" : "/dashboard"} replace />;

  return (
    <main className="signup-entry" aria-labelledby="signup-title">
      <img className="signup-entry__logo" src={openOpportunitiesLogo} alt="Open Opportunities" />
      <h1 id="signup-title">Create your account</h1>
      {failed ? <>
        <p role="alert">We could not open secure signup. Please try again.</p>
        <div className="signup-entry__actions">
          <button type="button" onClick={() => void begin()}>Try again</button>
          <button type="button" className="signup-entry__signin" onClick={() => void begin(false)}>
            Already have an account? Sign in
          </button>
        </div>
      </> : <p role="status">Opening secure signup...</p>}
    </main>
  );
}
