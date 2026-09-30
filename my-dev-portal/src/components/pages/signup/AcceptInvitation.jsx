import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { apiRequest } from "../../../lib/portal-api";
import { pendingInvitation, clearInvitation } from "../../../lib/invitation-session";
import Signup from "./Signup";
import openOpportunitiesLogo from "../../../images/assets/open-opportunities-logo.png";
import "../../../styles/components/signup.css";

export default function AcceptInvitation() {
  const { isLoading, isAuthenticated, getIdTokenClaims, loginWithRedirect, logout, user } = useAuth0();
  const navigate = useNavigate();
  const [token] = useState(pendingInvitation);
  const [error, setError] = useState("");
  const [wrongAccount, setWrongAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const request = useCallback(async () => {
    if (lock.current || !token) return;
    lock.current = true; setBusy(true); setError(""); setWrongAccount(false);
    try {
      const claims = await getIdTokenClaims();
      if (!claims?.__raw) throw new Error("Sign in again to accept this invitation.");
      const result = await apiRequest("/invitations/accept", claims.__raw, { method: "POST", body: JSON.stringify({ token }) });
      // A team-member invitation grants no credit -- credit_receipt is only
      // expected (and required) for the original new-customer kind.
      if (!result?.id || result.status !== "accepted" || (result.kind !== "team_member" && !result.credit_receipt)) {
        throw new Error("The invitation could not be confirmed. Please try again.");
      }
      if (alive.current) {
        clearInvitation();
        navigate("/dashboard", { replace: true });
      }
    } catch (failure) {
      if (!alive.current) return;
      // Opened while signed in to a different account, e.g. the person who sent it.
      setWrongAccount(failure.code === "invitation_email_mismatch");
      setError(failure.message || "The invitation could not be confirmed. Please try again.");
    }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }, [getIdTokenClaims, token, navigate]);
  useEffect(() => {
    if (!isLoading && isAuthenticated && token && !started.current) {
      started.current = true;
      void request();
    }
  }, [isLoading, isAuthenticated, token, request]);
  if (!isLoading && !isAuthenticated && token) return <Signup />;
  if (wrongAccount) return <main className="signup-entry">
    <img className="signup-entry__logo" src={openOpportunitiesLogo} alt="Open Opportunities" />
    <h1>This invitation is for a different email address</h1>
    <p role="alert">
      You’re signed in as <strong>{user?.email || "another account"}</strong>. Sign out, then open the invitation
      link from your email again and sign in or create an account with the address it was sent to.
    </p>
    <div className="signup-entry__actions">
      <button type="button" onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}>
        Sign out and switch account
      </button>
      <button type="button" className="signup-entry__signin" onClick={() => navigate("/dashboard")}>Go to my dashboard</button>
    </div>
  </main>;
  return <main className="signup-entry">
    <img className="signup-entry__logo" src={openOpportunitiesLogo} alt="Open Opportunities" />
    <h1>{error ? "We could not finish setting up your account" : "Setting up your account"}</h1>
    {!token ? <><p>Open the link from your invitation email to continue.</p><Link to="/dashboard">Go to dashboard</Link></> : <>
      {error && <p role="alert">{error}</p>}
      {(busy || isLoading) && <p role="status">Confirming your invitation...</p>}
      {error && <div className="signup-entry__actions">
        <button type="button" disabled={busy || isLoading} onClick={() => void request()}>Try again</button>
        <button type="button" disabled={busy} className="signup-entry__signin" onClick={async () => {
          try { await loginWithRedirect({ appState: { returnTo: "/invitation" }, authorizationParams: { prompt: "login" } }); }
          catch { setError("We could not open sign in. Please try again."); }
        }}>Sign in again</button>
      </div>}
    </>}
  </main>;
}
