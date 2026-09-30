"use strict";
const crypto = require("node:crypto");
const { emailSettings } = require("./notificationEmail");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX = "/api/v3/developer-portal";
function fail(code, status = 422) { throw Object.assign(new Error(code), { code, status }); }

function createInvitations({ request, env = process.env }) {
  function settings() {
    if (env.INVITATIONS_ENABLED !== "true" || Buffer.byteLength(env.INVITATION_SIGNING_SECRET || "") < 32 ||
        !env.INVITATION_SLACK_WEBHOOK_URL) {
      fail("invitations_not_configured", 503);
    }
    try { emailSettings(env); } catch { fail("invitations_not_configured", 503); }
    let origin, webhook;
    try {
      origin = new URL(env.INVITATION_PORTAL_URL || "");
      webhook = new URL(env.INVITATION_SLACK_WEBHOOK_URL);
    } catch { fail("invitations_not_configured", 503); }
    if (webhook.protocol !== "https:" || !["hooks.slack.com", "hooks.slack-gov.com"].includes(webhook.hostname) ||
        webhook.username || webhook.password || !webhook.pathname.startsWith("/services/")) fail("invitations_not_configured", 503);
    if (origin.username || origin.password || origin.search || origin.hash ||
        (origin.protocol !== "https:" && !(env.NODE_ENV !== "production" && origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))) {
      fail("invitations_not_configured", 503);
    }
    return { origin: origin.origin };
  }
  function token(id) {
    if (!UUID.test(id)) fail("invalid_invitation_id");
    settings();
    return `${id}.${crypto.createHmac("sha256", env.INVITATION_SIGNING_SECRET).update(`customer-invitation:v1:${id}`).digest("base64url")}`;
  }
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  function parse(value) {
    if (typeof value !== "string" || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) fail("invitation_unavailable", 410);
    const id = value.split(".")[0];
    const expected = token(id);
    if (!crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected))) fail("invitation_unavailable", 410);
    return { id, token_hash: hash(value) };
  }
  function recipient(user, rawToken) {
    if (!user?.sub || !user.email) fail("unauthorized", 401);
    if (user.email_verified !== true) fail("invitation_email_unverified", 403);
    const parsed = parse(rawToken);
    return { id: parsed.id, body: { auth0_user_id: user.sub, email: user.email, email_verified: true, token_hash: parsed.token_hash } };
  }
  return {
    settings, token,
    link(id) { return `${settings().origin}/signup#invitation=${token(id)}`; },
    // Used by onboarding.js to validate a captured invitation token before
    // registration -- never by email match alone. Invalid shape returns
    // null rather than throwing, since a stale/garbled token must not block
    // ordinary onboarding; sn-api still rejects a genuinely invalid token
    // clearly if one is forwarded.
    parseToken(value) {
      try { return parse(value); } catch { return null; }
    },
    create(body) {
      const id = String(body.requestId || "").toLowerCase();
      const rawToken = token(id);
      return request(`${PREFIX}/invitations`, { method: "POST", body: {
        request_id: id, email: body.email, full_name: body.fullName, company_name: body.companyName,
        amount_gbp_pence: body.amountPence, validity_days: body.validityDays, internal_note: body.internalNote || "",
        requested_by: body.requestedBy, token_hash: hash(rawToken),
      } });
    },
    list(offset = 0) {
      const value = Number(offset);
      if (!Number.isSafeInteger(value) || value < 0) fail("invalid_invitation_page");
      return request(`${PREFIX}/invitations?offset=${value}&limit=50`);
    },
    // Self-service: organization_id and admin authorization are resolved
    // server-side from auth0UserId -- never client-supplied.
    createTeamMember(body) {
      const id = String(body.requestId || "").toLowerCase();
      const rawToken = token(id);
      return request(`${PREFIX}/team-invitations`, { method: "POST", body: {
        request_id: id, email: body.email, full_name: body.fullName,
        internal_note: body.internalNote || "", token_hash: hash(rawToken),
        auth0_user_id: body.auth0UserId,
      } });
    },
    // Staff-assisted: the caller isn't a developer-portal AuthUser, so
    // organizationId is supplied directly, same trust boundary as /admin/invitations.
    createTeamMemberStaff(body) {
      const id = String(body.requestId || "").toLowerCase();
      const rawToken = token(id);
      return request(`${PREFIX}/admin/team-invitations`, { method: "POST", body: {
        request_id: id, email: body.email, full_name: body.fullName,
        organization_id: body.organizationId, internal_note: body.internalNote || "",
        token_hash: hash(rawToken), requested_by: body.requestedBy,
      } });
    },
    revokeTeamInvitation(user, id, requestId) {
      if (!UUID.test(id) || !UUID.test(String(requestId || ""))) fail("invalid_invitation_id");
      return request(`${PREFIX}/team-invitations/${id}/revoke`, { method: "POST", body: {
        request_id: requestId, auth0_user_id: user.sub,
      } });
    },
    listTeamMembers(organizationId, offset = 0) {
      const value = Number(offset);
      if (!Number.isSafeInteger(value) || value < 0) fail("invalid_invitation_page");
      return request(`${PREFIX}/team-invitations?organization_id=${encodeURIComponent(organizationId)}&offset=${value}&limit=50`);
    },
    change(id, action, body) {
      if (!UUID.test(id) || !["resend", "revoke", "retry-notifications"].includes(action)) fail("invalid_invitation_id");
      if (action !== "revoke") settings();
      return request(`${PREFIX}/invitations/${id}/${action}`, { method: "POST", body: { request_id: body.requestId, requested_by: body.requestedBy } });
    },
    async receive(user, rawToken, action) {
      if (!["preview", "accept"].includes(action)) fail("invalid_invitation_action");
      const { id, body } = recipient(user, rawToken);
      return request(`${PREFIX}/invitations/${id}/${action}`, { method: "POST", body });
    },
    notifications(user) { return request(`${PREFIX}/invitation-notifications?auth0_user_id=${encodeURIComponent(user.sub)}`); },
    dismiss(user, id) {
      if (!UUID.test(id)) fail("invalid_invitation_id");
      return request(`${PREFIX}/invitation-notifications/${id}/dismiss?auth0_user_id=${encodeURIComponent(user.sub)}`, { method: "POST" });
    },
    claim() { return request(`${PREFIX}/invitation-deliveries/claim`, { method: "POST" }); },
    finish(job, result) { return request(`${PREFIX}/invitation-deliveries/${encodeURIComponent(job.id)}/result`, { method: "POST", body: { lease_id: job.lease_id, ...result } }); },
  };
}

const messages = {
  invitations_not_configured: "Invitations are not configured yet. Contact your platform administrator.",
  invitation_already_pending: "An invitation is already pending for this email. Open Invitations to resend or revoke it.",
  invitation_request_conflict: "This request was already saved with different details. Check Invitations before sending another.",
  invitation_delivery_pending: "The invitation is queued or was sent recently. Wait a minute before resending.",
  invitation_not_pending: "This invitation can no longer be resent or revoked. Refresh its status.",
  invitation_not_accepted: "This invitation has not been accepted yet. No credit confirmation is ready to resend.",
  invitation_email_unverified: "Verify your email address, then sign in again to accept the invitation.",
  invitation_email_mismatch: "Sign in with the email address that received this invitation.",
  invitation_account_inactive: "This account is inactive. Contact the team before accepting.",
  invitation_already_accepted: "This invitation has already been accepted.",
  invitation_unavailable: "This invitation is invalid, expired, or revoked. Ask the team for a new invitation.",
  invitation_not_found: "This invitation is invalid, expired, or revoked. Ask the team for a new invitation.",
  prepaid_not_enabled: "Credit grants are not enabled yet. No invitation credit has been granted.",
  legacy_wallet_reconciliation_required: "Your existing balance needs review by our team before this credit can be granted.",
};

function installInvitationRoutes(app, { service, auth, portalAuth, jsonParser, serviceTokenMatches, invalidate }) {
  function admin(req, res, next) {
    if (!process.env.ADMIN_PLAN_CHANGE_TOKEN) return res.status(503).json({ code: "admin_not_configured", message: "Admin service is not configured." });
    if (!serviceTokenMatches(req.headers["x-admin-service-token"], process.env.ADMIN_PLAN_CHANGE_TOKEN)) return res.status(401).json({ code: "unauthorized" });
    next();
  }
  const handle = fn => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await fn(req)); }
    catch (error) {
      const code = /^[a-z_]+$/.test(error.code || "") ? error.code : "invitation_request_failed";
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      console.warn(JSON.stringify({ event: "invitation_request_failed", code, status }));
      res.status(status).json({ code, message: messages[code] || (status === 422 ? "Check the invitation details and try again." : "The invitation could not be confirmed. Retry this request; your details have been retained.") });
    }
  };
  app.get("/admin/invitations", admin, handle(req => service.list(req.query.offset)));
  app.post("/admin/invitations", admin, jsonParser, handle(req => service.create(req.body)));
  for (const action of ["resend", "revoke", "retry-notifications"]) app.post(`/admin/invitations/:id/${action}`, admin, jsonParser, handle(req => service.change(req.params.id, action, req.body)));
  for (const action of ["preview", "accept"]) app.post(`/invitations/${action}`, auth, jsonParser, handle(async req => {
    const result = await service.receive(req.user, req.body.token, action);
    if (action === "accept") invalidate(req.user.sub);
    return result;
  }));
  app.get("/invitation-notifications", auth, handle(req => service.notifications(req.user)));
  app.post("/invitation-notifications/:id/dismiss", auth, handle(req => service.dismiss(req.user, req.params.id)));

  app.get("/admin/team-invitations", admin, handle(req => service.listTeamMembers(req.query.organizationId, req.query.offset)));

  // Staff-assisted: admin-portal supplies organizationId directly (staff
  // aren't developer-portal users), same trust boundary as /admin/invitations.
  app.post("/admin/team-invitations", admin, jsonParser, handle(req => service.createTeamMemberStaff({
    requestId: req.body.requestId, email: req.body.email, fullName: req.body.fullName,
    organizationId: req.body.organizationId, internalNote: req.body.internalNote, requestedBy: req.body.requestedBy,
  })));

  // Self-service: organization_id and admin authorization are resolved
  // server-side from the caller's own identity -- never client-supplied.
  app.post("/team-invitations", auth, jsonParser, handle(req => service.createTeamMember({
    requestId: req.body.requestId, email: req.body.email, fullName: req.body.fullName,
    internalNote: req.body.internalNote, auth0UserId: req.user.sub,
  })));
  app.post("/team-invitations/:id/revoke", auth, jsonParser, handle(req => service.revokeTeamInvitation(
    req.user, String(req.params.id).toLowerCase(), String(req.body?.requestId || "").toLowerCase())));

  // portalAuth (not just auth) so req.portalContext.organization_id is
  // resolved -- never trust a client-supplied organization_id here.
  if (portalAuth) {
    app.get("/team-invitations", portalAuth, handle(req => service.listTeamMembers(req.portalContext.organization_id, req.query.offset)));
  }
}

module.exports = { createInvitations, installInvitationRoutes };
