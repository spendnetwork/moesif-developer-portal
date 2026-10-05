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

function TermsForm({ data, token, refresh, refreshToken, signInAgain }) {
  const [atEnd, setAtEnd] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Set when acceptance is blocked only because the ID token still carries an
  // unverified email. It unlocks the recovery actions below rather than leaving
  // the user staring at a dead-end message after they verified out-of-band.
  const [needsVerify, setNeedsVerify] = useState(false);
  // Resend state: escalating cooldown (seconds) mirrors bid-bench-next so a
  // user can't hammer Auth0's verification-email job.
  const RESEND_STEPS = [30, 60, 120, 300];
  const [resendCount, setResendCount] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNote, setResendNote] = useState("");
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
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  async function resendVerification() {
    if (resendBusy || cooldown > 0) return;
    setResendBusy(true); setResendNote("");
    try {
      await apiRequest("/onboarding/resend-verification", token, { method: "POST", signal: AbortSignal.timeout(15000) });
      setResendNote("Verification email sent. Check your inbox, then use the button below.");
      setCooldown(RESEND_STEPS[Math.min(resendCount, RESEND_STEPS.length - 1)]);
      setResendCount(resendCount + 1);
    } catch (failure) {
      setResendNote(failure.code === "verification_resend_unconfigured"
        ? "Resending isn't available right now. Contact welcome@openopps.com."
        : "We couldn't resend the email. Wait a moment and try again.");
    } finally { setResendBusy(false); }
  }
  // Core acceptance, usable with either the current token or a freshly
  // refreshed one (after the user confirms they've verified their email).
  async function submitAccept(activeToken) {
    setError(""); setNeedsVerify(false);
    try {
      await apiRequest("/onboarding/accept", activeToken, {
        method: "POST", signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ version: data.document.version, sha256: data.document.sha256, agreed: true }),
      });
      if (pendingInvitation()) navigate("/invitation", { replace: true });
      await refresh();
      return true;
    } catch (failure) {
      // The POST may have committed even if its response was lost.
      try {
        const confirmed = await request(activeToken);
        if (!confirmed.required) {
          if (pendingInvitation()) navigate("/invitation", { replace: true });
          await refresh(confirmed, { revalidate: false });
          return true;
        }
        if (confirmed.version !== data.version) await refresh(confirmed, { revalidate: false });
      } catch { /* Stay gated until the server confirms acceptance. */ }
      if (failure.code === "terms_email_unverified") {
        setNeedsVerify(true);
        setError("Your email isn't verified yet. Open the link in the verification email, then use the button below.");
      } else {
        setError("We could not confirm acceptance. Your account is saved. Check your connection and retry; you will not need another account.");
      }
      return false;
    }
  }
  async function accept(event) {
    event.preventDefault();
    if (!atEnd || !agreed || submitting.current) return;
    submitting.current = true; setBusy(true);
    try { await submitAccept(token); }
    finally { submitting.current = false; setBusy(false); }
  }
  // After the user tells us they've verified, force a fresh ID token (so the
  // email_verified claim updates) and retry acceptance in one step.
  async function verifiedAndRetry() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const fresh = refreshToken ? await refreshToken() : null;
      if (!fresh) {
        setError("We couldn't refresh your session. Use “Sign in again” below to continue.");
        return;
      }
      await submitAccept(fresh);
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
      {needsVerify && <>
        {resendNote && <p className="onboarding-hint" role="status">{resendNote}</p>}
        <div className="onboarding-recovery__actions">
          <button className="onboarding-continue" type="button" disabled={busy} onClick={() => void verifiedAndRetry()}>{busy ? "Checking..." : "I've verified my email"}</button>
          <button className="onboarding-recovery__secondary" type="button" disabled={resendBusy || cooldown > 0} onClick={() => void resendVerification()}>
            {resendBusy ? "Sending..." : cooldown > 0 ? `Resend email (${cooldown}s)` : "Resend verification email"}
          </button>
          {signInAgain && <button className="onboarding-recovery__secondary" type="button" disabled={busy} onClick={signInAgain}>Sign in again</button>}
        </div>
      </>}
    </form>
  </>;
}

export default function OnboardingGate({ children }) {
  const { isAuthenticated, isLoading, idToken, user, logout, loginWithRedirect, refreshIdToken, error: authError } = useAuthCombined();
  const waitingForSession = isLoading || (isAuthenticated && !idToken);
  // Key on the stable user identity, NOT the raw token: refreshIdToken() (used
  // by the "I've verified my email" recovery) swaps the token in place, and
  // keying on the token would rekey SWR mid-accept -- unmounting the form and
  // orphaning the bound mutate just as acceptance succeeds. The fetcher reads
  // the current idToken via closure, so a refreshed token is still used.
  const onboardingKey = !waitingForSession && isAuthenticated && idToken ? ["/onboarding", user?.sub || "me"] : null;
  const { data, error, mutate, isValidating } = useSWR(onboardingKey,
    () => request(idToken), { keepPreviousData: false, shouldRetryOnError: false, revalidateOnFocus: true, revalidateOnReconnect: true });
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
    {documentReady ? <TermsForm key={data.document.sha256} data={data} token={idToken} refresh={mutate} refreshToken={refreshIdToken} signInAgain={signInAgain} /> : <section className="onboarding-recovery" aria-labelledby="onboarding-recovery-title">
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
