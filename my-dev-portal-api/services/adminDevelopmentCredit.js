function grantError(code, message, status = 422) {
  return Object.assign(new Error(message), { code, status });
}

function validateDevelopmentGrant(body, headerRequestId) {
  const requestId = body?.requestId;
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) || headerRequestId !== requestId) {
    throw grantError("invalid_request_id", "Matching UUID requestId and X-Request-Id are required.");
  }
  const organizationId = Number(body.organizationId);
  const auth0UserId = typeof body.auth0UserId === "string" ? body.auth0UserId.trim() : "";
  const actor = typeof body.requested_by === "string" ? body.requested_by.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0 || !auth0UserId || auth0UserId.length > 255) {
    throw grantError("invalid_grant_identity", "An organization and linked Auth0 user are required.");
  }
  if (!actor || actor.length > 255 || !reason || reason.length > 2000) {
    throw grantError("invalid_grant_audit", "A verified admin actor and reason are required.");
  }
  const amount = body.amountGbp;
  const pence = Math.round(amount * 100);
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isSafeInteger(pence) ||
      pence <= 0 || pence > 2147483647 || Math.abs(pence / 100 - amount) > Number.EPSILON * 100) {
    throw grantError("invalid_grant_amount", "Enter a positive GBP amount with at most two decimal places.");
  }
  let expiresAt = null;
  if (body.expiresAt != null && body.expiresAt !== "") {
    if (typeof body.expiresAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(body.expiresAt) || !Number.isFinite(Date.parse(body.expiresAt))) {
      throw grantError("invalid_grant_expiry", "Expiry must be a valid date with a timezone.");
    }
    expiresAt = new Date(body.expiresAt).toISOString();
  }
  return { requestId, organizationId, auth0UserId, actor, reason, pence, expiresAt };
}

async function grantDevelopmentAllowance(body, headerRequestId, deps) {
  const grant = validateDevelopmentGrant(body, headerRequestId);
  const context = await deps.getSnApiPortalContext({ sub: grant.auth0UserId });
  if (Number(context?.organization_id) !== grant.organizationId) {
    throw grantError("organization_identity_mismatch", "The user is not linked to this organization.", 409);
  }
  // Null is stable across first grant and retries; the API permits convergent
  // Development provisioning but rejects any commercial-to-Development change.
  const provision = await deps.provisionSnApiLocalPrepaidCustomer({
    request_id: grant.requestId,
    auth0_user_id: grant.auth0UserId,
    plan_key: "development",
    expected_current_plan_key: null,
    requested_by: grant.actor,
  });
  if (Number(provision?.organization_id) !== grant.organizationId || provision.plan_key !== "development" ||
      provision.debit_owner !== "api" || !provision.subscription_id) {
    throw grantError("development_provision_mismatch", "Development account setup needs review.", 409);
  }
  const sourceReference = `admin-development:${grant.requestId}`;
  const credit = await deps.grantSnApiDevelopmentCredit({
    source_reference: sourceReference,
    auth0_user_id: grant.auth0UserId,
    subscription_id: provision.subscription_id,
    amount_gbp_pence: grant.pence,
    granted_by: grant.actor,
    reason: grant.reason,
    expires_at: grant.expiresAt,
  });
  if (credit?.source_reference !== `development_grant:${sourceReference}` || credit.source_type !== "development_grant" ||
      credit.subscription_id !== provision.subscription_id || credit.amount_gbp_pence !== grant.pence) {
    throw grantError("development_credit_receipt_invalid", "The allowance confirmation is incomplete. Retry with the same request ID.", 503);
  }
  return { ok: true, requestId: grant.requestId, planKey: "development", pending: false };
}

module.exports = { validateDevelopmentGrant, grantDevelopmentAllowance };
