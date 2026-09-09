const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcileBasicCreditPurchase, prepaidSubscriptionPeriodEnd } = require("../services/prepaidReconciliation");

const identity = { sub: "auth0|123", email: "buyer@example.com" };
function session(overrides = {}) {
  return {
    id: "cs_paid", mode: "payment", status: "complete", payment_status: "paid",
    amount_total: 10000, currency: "gbp", client_reference_id: identity.sub,
    customer: { id: "cus_123", email: identity.email, metadata: { authUserId: identity.sub } },
    metadata: { purchase_type: "basic_activation", plan_id: "prod_basic",
      amount_gbp_pence: "10000", auth0_user_id: identity.sub, expected_current_plan_key: "development" },
    payment_intent: { id: "pi_123", status: "succeeded", amount_received: 10000, currency: "gbp", customer: "cus_123" },
    line_items: { has_more: false, data: [{ quantity: 1, amount_total: 10000, price: { product: "prod_basic" } }] },
    ...overrides,
  };
}

// Emulates the API's persistent immutable receipts, not a portal memory lock.
function dependencies(paidSession = session()) {
  const operations = new Map();
  const credits = new Map();
  const calls = [];
  const state = { plan: "development", subscription: "prepaid_dev" };
  return {
    calls, state, credits,
    verifyStripeSession: async (id) => { assert.equal(id, paidSession.id); calls.push("verify"); return paidSession; },
    getPlanKeyForProduct: async () => "basic",
    provisionSnApiLocalPrepaidCustomer: async (payload) => {
      calls.push(["provision", payload]);
      const previous = operations.get(payload.request_id);
      if (previous) { assert.deepEqual(previous.payload, payload); return previous.result; }
      if (state.plan !== payload.expected_current_plan_key) {
        throw Object.assign(new Error("Current plan changed"), { code: "current_plan_conflict" });
      }
      state.plan = "basic";
      state.subscription = "prepaid_basic";
      const result = { plan_key: "basic", debit_owner: "api", subscription_id: "prepaid_basic", user_id: 7, organization_id: 9 };
      operations.set(payload.request_id, { payload, result });
      return result;
    },
    registerSnApiPaidCredit: async (payload) => {
      calls.push(["credit", payload]);
      const previous = credits.get(payload.stripe_payment_intent_id);
      if (previous) { assert.deepEqual(previous.payload, payload); return previous.result; }
      if (state.plan !== "basic" || state.subscription !== payload.subscription_id) {
        throw Object.assign(new Error("Current subscription changed"), { code: "credit_subscription_conflict" });
      }
      const result = { subscription_id: payload.subscription_id, amount_gbp_pence: payload.amount_gbp_pence,
        source_reference: `stripe_payment_intent:${payload.stripe_payment_intent_id}` };
      credits.set(payload.stripe_payment_intent_id, { payload, result });
      return result;
    },
    createMoesifBalanceTransaction: () => assert.fail("No Moesif credit or promotional grant is allowed"),
    provisionSnApiPrepaidCustomer: () => assert.fail("Legacy provisioning must not run"),
  };
}

test("verified Basic payment provisions the API ledger and registers only the paid amount", async () => {
  const deps = dependencies();
  const result = await reconcileBasicCreditPurchase("cs_paid", identity, deps);
  assert.equal(result.amountPence, 10000);
  assert.equal(deps.calls[0], "verify");
  const provision = deps.calls[1][1];
  assert.equal(provision.expected_current_plan_key, "development");
  assert.equal(provision.requested_by, "stripe_checkout");
  assert.ok(provision.request_id.length <= 64);
  assert.deepEqual(deps.calls[2][1], { auth0_user_id: identity.sub, subscription_id: "prepaid_basic",
    stripe_customer_id: "cus_123", stripe_payment_intent_id: "pi_123", amount_gbp_pence: 10000, currency: "GBP" });
});

test("concurrent webhook and redirect callbacks credit the stable PaymentIntent once", async () => {
  const deps = dependencies();
  await Promise.all(Array.from({ length: 8 }, (_, i) => reconcileBasicCreditPurchase(session(), i % 2 ? identity : null, deps)));
  assert.equal(deps.credits.size, 1);
  assert.equal(new Set(deps.calls.filter(c => c[0] === "provision").map(c => c[1].request_id)).size, 1);
});

test("an already applied payment replay never replaces a later active plan", async () => {
  const deps = dependencies();
  await reconcileBasicCreditPurchase("cs_paid", identity, deps);
  deps.state.plan = "enterprise";
  deps.state.subscription = "manual_enterprise";
  await reconcileBasicCreditPurchase("cs_paid", null, deps);
  assert.equal(deps.state.plan, "enterprise");
  assert.equal(deps.state.subscription, "manual_enterprise");
  assert.equal(deps.credits.size, 1);
});

test("a stale unapplied payment cannot downgrade a later commitment", async () => {
  const deps = dependencies();
  deps.state.plan = "growth";
  await assert.rejects(reconcileBasicCreditPurchase("cs_paid", identity, deps), { code: "current_plan_conflict" });
  assert.equal(deps.state.plan, "growth");
  assert.equal(deps.credits.size, 0);
});

test("plan switch between provisioning and credit registration fails closed", async () => {
  const deps = dependencies();
  const provision = deps.provisionSnApiLocalPrepaidCustomer;
  deps.provisionSnApiLocalPrepaidCustomer = async (payload) => {
    const result = await provision(payload);
    deps.state.plan = "growth";
    deps.state.subscription = "manual_growth";
    return result;
  };
  await assert.rejects(reconcileBasicCreditPurchase("cs_paid", identity, deps), { code: "credit_subscription_conflict" });
  assert.equal(deps.credits.size, 0);
  assert.equal(deps.state.plan, "growth");
});

test("a failed credit write is retryable with unchanged operation and payment IDs", async () => {
  const deps = dependencies();
  const register = deps.registerSnApiPaidCredit;
  deps.registerSnApiPaidCredit = async () => { throw new Error("Storage unavailable"); };
  await assert.rejects(reconcileBasicCreditPurchase("cs_paid", identity, deps), /Storage unavailable/);
  deps.registerSnApiPaidCredit = register;
  await reconcileBasicCreditPurchase("cs_paid", identity, deps);
  assert.equal(deps.credits.size, 1);
});

test("verified legacy paid purchases below GBP 100 still reconcile", async () => {
  const paid = session();
  paid.amount_total = 100;
  paid.metadata.amount_gbp_pence = "100";
  delete paid.metadata.expected_current_plan_key;
  paid.payment_intent.amount_received = 100;
  paid.line_items.data[0].amount_total = 100;
  const deps = dependencies(paid);
  deps.state.plan = null;
  await reconcileBasicCreditPurchase("cs_paid", identity, deps);
  assert.equal(deps.credits.get("pi_123").payload.amount_gbp_pence, 100);
});

for (const [name, change, code] of [
  ["unpaid session", s => { s.payment_status = "unpaid"; }, "checkout_payment_pending"],
  ["incomplete session", s => { s.status = "open"; }, "checkout_incomplete"],
  ["subscription checkout", s => { s.mode = "subscription"; }, "invalid_basic_checkout_mode"],
  ["forged amount", s => { s.metadata.amount_gbp_pence = "10000x"; }, "top_up_amount_mismatch"],
  ["wrong currency", s => { s.currency = "usd"; }, "top_up_amount_mismatch"],
  ["missing PaymentIntent", s => { s.payment_intent = null; }, "basic_payment_verification_failed"],
  ["pending PaymentIntent", s => { s.payment_intent.status = "processing"; }, "basic_payment_verification_failed"],
  ["different paid amount", s => { s.payment_intent.amount_received = 9999; }, "basic_payment_verification_failed"],
  ["different line product", s => { s.line_items.data[0].price.product = "prod_growth"; }, "basic_payment_verification_failed"],
  ["different Stripe identity", s => { s.customer.metadata.authUserId = "auth0|other"; }, "stripe_customer_identity_mismatch"],
]) {
  test(`${name} cannot create any credit or provision access`, async () => {
    const paid = session(); change(paid);
    const deps = dependencies(paid);
    await assert.rejects(reconcileBasicCreditPurchase(paid, identity, deps), { code });
    assert.equal(deps.credits.size, 0);
    assert.equal(deps.state.plan, "development");
  });
}

test("unverified webhook/redirect objects are ignored in favour of Stripe retrieval", async () => {
  const deps = dependencies(session({ payment_status: "unpaid" }));
  await assert.rejects(reconcileBasicCreditPurchase(session(), identity, deps), { code: "checkout_payment_pending" });
  await assert.rejects(reconcileBasicCreditPurchase({ payment_status: "paid" }, identity, deps), { code: "checkout_session_required" });
});

test("legacy prepaid period helper remains within Moesif's 50-year limit", () => {
  assert.equal(prepaidSubscriptionPeriodEnd(new Date("2026-07-30T12:00:00Z")), "2075-07-30T12:00:00.000Z");
});
