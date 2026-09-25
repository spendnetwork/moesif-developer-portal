const PREFIX = "/api/v3/developer-portal/onboarding";
const messages = {
  terms_acceptance_required: "Read and accept the Terms of API Access before continuing.",
  terms_version_changed: "The terms have changed. Review the latest version before accepting.",
  terms_email_unverified: "Verify your email, then sign in again to accept the terms.",
  terms_identity_mismatch: "Sign in with the email address associated with your account.",
};

function createOnboarding(deps, invitations) {
  const get = async (user, includeDocument = true, rawInvitationToken = null) => {
    const path = `${PREFIX}?auth0_user_id=${encodeURIComponent(user.sub)}&include_document=${includeDocument}`;
    let result;
    try { result = await deps.invitationRequest(path); }
    catch (error) {
      if (error.status !== 404 || error.code !== "terms_account_not_found") throw error;
      // Thread a captured invitation token through to registration itself --
      // NOT just the later /invitations/accept call -- since this is the
      // first request that actually creates the AuthUser row, before the
      // browser could ever reach an invitation-specific endpoint. Parsed
      // (not raw) so sn-api gets the same {id, token_hash} shape
      // identify()/accept() already validate; an invalid/stale token is
      // simply not forwarded (parseToken returns null), never silently
      // treated as a valid one.
      const parsed = rawInvitationToken && invitations ? invitations.parseToken(rawInvitationToken) : null;
      await deps.registerSnApiPortalAccount(user, parsed);
      result = await deps.invitationRequest(path);
    }
    if (typeof result?.required !== "boolean" || typeof result?.enabled !== "boolean") throw new Error("Invalid onboarding response");
    return result;
  };
  const errorResponse = (res, error) => {
    const code = /^[a-z_]+$/.test(error.code || "") ? error.code : "onboarding_unavailable";
    const status = [400, 401, 403, 409, 422].includes(error.status) ? error.status : 503;
    console.warn(JSON.stringify({ event: "onboarding_request_failed", code, status }));
    return res.status(status).json({ code, message: messages[code] || "We could not confirm your account setup. Please retry; your account has not been lost." });
  };
  return {
    get,
    async requireTerms(req, res, next) {
      try {
        // Payment reconciliation and security-only key actions must remain available.
        if (/^\/register\/stripe\//.test(req.path) ||
            (req.method === "DELETE" && /^\/api-keys\/[^/]+\/?$/.test(req.path)) ||
            (req.method === "POST" && /^\/api-keys\/[^/]+\/pause\/?$/.test(req.path))) return next();
        const result = await get(req.user, false, req.headers["x-pending-invitation"]);
        if (result.required) return res.status(403).json({ code: "terms_acceptance_required", message: messages.terms_acceptance_required });
        next();
      } catch (error) { return errorResponse(res, error); }
    },
    install(app, auth, jsonParser) {
      app.get("/onboarding", auth, async (req, res) => {
        try { res.json(await get(req.user, true, req.headers["x-pending-invitation"])); }
        catch (error) { errorResponse(res, error); }
      });
      app.post("/onboarding/accept", auth, jsonParser, async (req, res) => {
        try {
          await get(req.user, false);
          if (req.body?.agreed !== true) return res.status(422).json({ code: "terms_agreement_required", message: "Tick the agreement before continuing." });
          const result = await deps.invitationRequest(`${PREFIX}/accept`, { method: "POST", body: {
            auth0_user_id: req.user.sub, email: req.user.email,
            email_verified: req.user.email_verified === true,
            version: req.body.version, sha256: req.body.sha256, agreed: true,
          } });
          res.json(result);
        } catch (error) { errorResponse(res, error); }
      });
    },
  };
}

module.exports = { createOnboarding };
