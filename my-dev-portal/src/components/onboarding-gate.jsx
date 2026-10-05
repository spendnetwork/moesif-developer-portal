import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import useSWR from "swr";
import useAuthCombined from "../hooks/useAuthCombined";
import { apiRequest } from "../lib/portal-api";
import { pendingInvitation } from "../lib/invitation-session";
import logo from "../images/assets/open-opportunities-logo.png";
import { SessionLoader } from "./session-loader";
import "../styles/components/onboarding.css";

const request = async (token, options) => {
  // Thread a captured invitation token to the FIRST request that could
  // trigger registration -- not just the later /invitations/accept call --
  // since this is what actually creates the AuthUser row for a genuinely new
  // teammate. A header, never a query string, so it never lands in access
  // logs or analytics. Absent for an ordinary signup or a returning user.
  const pending = pendingInvitation();
  const headers = pending ? { "X-Pending-Invitation": pending } : undefined;
  const data = await apiRequest("/onboarding", token, { signal: AbortSignal.timeout(15000), ...options,
    headers: { ...headers, ...options?.headers } });
  if (typeof data?.required !== "boolean" || typeof data?.enabled !== "boolean" || (data.required && !data.document?.text)) throw new Error("Invalid onboarding response");
  return data;
};

function TermsForm({ data, token, refresh }) {
  const [atEnd, setAtEnd] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef(null);
  const submitting = useRef(false);
  const navigate = useNavigate();
  function checkEnd() {
    const node = panel.current;
    if (node && node.scrollTop + node.clientHeight >= node.scrollHeight - 4) setAtEnd(true);
  }
  useEffect(() => {
    checkEnd();
    const observer = new ResizeObserver(checkEnd);
    if (panel.current) observer.observe(panel.current);
    return () => observer.disconnect();
  }, []);
  async function accept(event) {
    event.preventDefault();
    if (!atEnd || !agreed || submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      await apiRequest("/onboarding/accept", token, {
        method: "POST", signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ version: data.document.version, sha256: data.document.sha256, agreed: true }),
      });
      if (pendingInvitation()) navigate("/invitation", { replace: true });
      await refresh();
    } catch (failure) {
      // The POST may have committed even if its response was lost.
      try {
        const confirmed = await request(token);
        if (!confirmed.required) {
          if (pendingInvitation()) navigate("/invitation", { replace: true });
          await refresh(confirmed, { revalidate: false });
          return;
        }
        if (confirmed.version !== data.version) await refresh(confirmed, { revalidate: false });
      } catch { /* Stay gated until the server confirms acceptance. */ }
      setError(failure.code === "terms_email_unverified" ? failure.message :
        "We could not confirm acceptance. Your account is saved. Check your connection and retry; you will not need another account.");
    } finally { submitting.current = false; setBusy(false); }
  }
  return <>
    <p className="onboarding-eyebrow">Complete your account</p>
    <h1>Welcome to the Open Opportunities API</h1>
    <p className="onboarding-intro">Please read and accept the Terms of API Access, including the confidentiality obligations, before continuing.</p>
    <section className="onboarding-document" aria-labelledby="terms-heading">
      <header><h2 id="terms-heading">{data.document.title}</h2><span>Version {data.document.version}</span></header>
      <div ref={panel} className="onboarding-document__text" tabIndex={0} role="region" aria-label="Terms document" onScroll={checkEnd}>{data.document.text}</div>
    </section>
    <form onSubmit={accept}>
      <label className="onboarding-agreement">
        <input type="checkbox" disabled={!atEnd || busy} checked={agreed} onChange={event => setAgreed(event.target.checked)} />
        <span>I agree to the Terms of API Access, including the confidentiality obligations.</span>
      </label>
      {!atEnd && <p className="onboarding-hint">Read to the end to accept the terms.</p>}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
      <button className="onboarding-continue" type="submit" disabled={!atEnd || !agreed || busy}>{busy ? "Confirming acceptance..." : "Accept and continue"}</button>
    </form>
  </>;
}

export default function OnboardingGate({ children }) {
  const { isAuthenticated, isLoading, idToken, logout, loginWithRedirect, error: authError } = useAuthCombined();
  const waitingForSession = isLoading || (isAuthenticated && !idToken);
  const { data, error, mutate, isValidating } = useSWR(!waitingForSession && isAuthenticated && idToken ? ["/onboarding", idToken] : null,
    ([, token]) => request(token), { keepPreviousData: false, shouldRetryOnError: false, revalidateOnFocus: true, revalidateOnReconnect: true });
  const [forced, setForced] = useState(false);
  const [sessionTimedOut, setSessionTimedOut] = useState(false);
  useEffect(() => {
    setSessionTimedOut(false);
    if (!waitingForSession) return;
    const timer = setTimeout(() => setSessionTimedOut(true), 15000);
    return () => clearTimeout(timer);
  }, [waitingForSession]);
  useEffect(() => {
    const recheck = () => { setForced(true); void mutate().catch(() => {}).finally(() => setForced(false)); };
    window.addEventListener("openopps:terms-required", recheck);
    return () => window.removeEventListener("openopps:terms-required", recheck);
  }, [mutate]);
  const signInAgain = () => loginWithRedirect({ appState: { returnTo: window.location.pathname + window.location.search }, authorizationParams: { prompt: "login" } });
  const sessionFailed = authError || (waitingForSession && sessionTimedOut);
  if (!sessionFailed && !isLoading && !isAuthenticated) return children;
  if (!sessionFailed && waitingForSession) return <SessionLoader />;
  if (!sessionFailed && data?.required === false && !error && !forced) return children;
  const documentReady = !sessionFailed && data?.required && data.document?.text && !error && !forced;
  // Never mount protected routes while the initial check or an explicit recheck is pending.
  if (!sessionFailed && (forced || isValidating || !error) && !documentReady) return <SessionLoader />;
  return <main className="onboarding-page">
    <div className="onboarding-card">
    <div className="onboarding-brand"><img src={logo} alt="Open Opportunities" /><span>Developer Portal</span></div>
    {documentReady ? <TermsForm key={data.document.sha256} data={data} token={idToken} refresh={mutate} /> : <section className="onboarding-recovery" aria-labelledby="onboarding-recovery-title">
      <div role="alert">
        <h1 id="onboarding-recovery-title">{sessionFailed ? "We could not complete sign-in" : "We could not open your account"}</h1>
        <p>{sessionFailed ? "Your session could not be confirmed. Sign in again to continue." : "Your account is still saved. Check your connection and try again."}</p>
      </div>
      <div className="onboarding-recovery__actions">
        {!sessionFailed && <button className="onboarding-continue" type="button" disabled={isValidating || !idToken} onClick={() => void mutate().catch(() => {})}>Try again</button>}
        <button className={sessionFailed ? "onboarding-continue" : "onboarding-recovery__secondary"} type="button" onClick={signInAgain}>Sign in again</button>
      </div>
    </section>}
    <footer className="onboarding-footer"><a href="mailto:welcome@openopps.com">Contact support</a>
      <button type="button" onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}>Sign out</button></footer>
    </div>
  </main>;
}
