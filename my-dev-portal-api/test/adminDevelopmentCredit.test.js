const test = require("node:test");
const assert = require("node:assert/strict");
const { grantDevelopmentAllowance, validateDevelopmentGrant } = require("../services/adminDevelopmentCredit");
const requestId = "ea691977-5160-4376-a827-cba128a08907";
const body = { organizationId: 9, auth0UserId: "auth0|developer", amountGbp: 12.34, reason: "Integration evaluation", requestId, requested_by: "admin@example.test" };

function dependencies() {
  const calls = [];
  const provision = { organization_id: 9, plan_key: "development", debit_owner: "api", subscription_id: "prepaid_dev" };
  return {
    calls,
    getSnApiPortalContext: async () => ({ organization_id: 9 }),
    provisionSnApiLocalPrepaidCustomer: async payload => { calls.push(["provision", payload]); return provision; },
    grantSnApiDevelopmentCredit: async payload => {
      calls.push(["grant", payload]);
      return { source_reference: `development_grant:${payload.source_reference}`, source_type: "development_grant", subscription_id: "prepaid_dev", plan_key: "development", amount_gbp_pence: payload.amount_gbp_pence };
    },
  };
}

test("admin allowance response and API payloads match the coordinated contract", async () => {
  const deps = dependencies();
  const result = await grantDevelopmentAllowance(body, requestId, deps);
  assert.deepEqual(result, { ok: true, requestId, planKey: "development", pending: false });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0][0], "grant");
  assert.equal(deps.calls[0][1].subscription_id, undefined);
  assert.equal(deps.calls[0][1].organization_id, 9);
  assert.equal(deps.calls[0][1].amount_gbp_pence, 1234);
  assert.equal(deps.calls[0][1].source_reference, `admin-development:${requestId}`);
  assert.equal(deps.calls[0][1].granted_by, body.requested_by);
  assert.equal(deps.calls[0][1].expires_at, null);
});

test("grant retries retain the same payload after a commercial plan activates", async () => {
  const deps = dependencies();
  await grantDevelopmentAllowance(body, requestId, deps);
  deps.getSnApiPortalContext = async () => ({ organization_id: 9, current_plan_key: "growth" });
  await grantDevelopmentAllowance(body, requestId, deps);
  assert.deepEqual(deps.calls[0], deps.calls[1]);
});

test("expired request retries are left to API idempotency, not rejected before reading the receipt", () => {
  assert.equal(validateDevelopmentGrant({ ...body, expiresAt: "2020-01-01T00:00:00Z" }, requestId).expiresAt, "2020-01-01T00:00:00.000Z");
});

test("organization mismatch cannot provision or grant", async () => {
  const deps = dependencies();
  await assert.rejects(grantDevelopmentAllowance({ ...body, organizationId: 10 }, requestId, deps), { code: "organization_identity_mismatch" });
  assert.deepEqual(deps.calls, []);
});

test("legacy billing rejection never falls through to provisioning or Stripe", async () => {
  const deps = dependencies();
  deps.grantSnApiDevelopmentCredit = async () => { throw Object.assign(new Error("Legacy plan"), { code: "credit_subscription_conflict" }); };
  await assert.rejects(grantDevelopmentAllowance(body, requestId, deps), { code: "credit_subscription_conflict" });
  assert.deepEqual(deps.calls, []);
});

test("grant requires a matching stable request ID, actor, reason, valid amount and timezone", () => {
  assert.throws(() => validateDevelopmentGrant(body, "other"));
  for (const change of [{ amountGbp: 0 }, { amountGbp: 1.001 }, { amountGbp: 21474836.48 }, { amountGbp: "10" }, { requested_by: "" }, { reason: "" }, { auth0UserId: "" }, { expiresAt: "2027-01-01T00:00:00" }]) {
    assert.throws(() => validateDevelopmentGrant({ ...body, ...change }, requestId));
  }
});
