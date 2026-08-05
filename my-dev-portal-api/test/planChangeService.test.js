const test = require("node:test");
const assert = require("node:assert/strict");

const {
  processPaidInvoice,
  processFailedInvoice,
  issueApprovedPlanChange,
  completeBasicDowngrade,
  reconcileDuePlanChanges,
} = require("../services/planChangeService");

function baseChange(overrides = {}) {
  return {
    request_id: "change-123",
    stripe_customer_id: "cus_123",
    stripe_subscription_id: "sub_123",
    from_plan_key: "basic",
    to_plan_key: "growth",
    target_product_id: "prod_growth",
    status: "scheduled",
    effective_at: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

function paidInvoice(overrides = {}) {
  return {
    id: "in_closing",
    customer: "cus_123",
    subscription: "sub_123",
    status: "paid",
    created: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

test("paid closing invoice activates a plan with no commitment", async () => {
  const updates = [];
  const result = await processPaidInvoice(paidInvoice(), {
    getSnApiPlanChangeByCustomer: async () => baseChange({ to_plan_key: "basic" }),
    updateSnApiPlanChange: async (_id, update) => updates.push(update),
    activateStripePlanChange: async () => ({
      commitmentRequired: false,
      subscription: {
        id: "sub_123",
        status: "active",
        items: { data: [{ price: { product: { id: "prod_basic" } } }] },
      },
    }),
    getStripeCustomerById: async () => ({
      id: "cus_123",
      email: "buyer@example.com",
      metadata: { authUserId: "auth0|123" },
    }),
    provisionSnApiCustomer: async () => ({ user_id: 7, organization_id: 9 }),
    updateStripeCustomerIdentity: async () => {},
  });

  assert.equal(result.status, "active");
  assert.deepEqual(updates.map((update) => update.status), ["activating", "active"]);
});

test("commitment plan waits for its commitment invoice", async () => {
  const updates = [];
  const result = await processPaidInvoice(paidInvoice(), {
    getSnApiPlanChangeByCustomer: async () => baseChange(),
    updateSnApiPlanChange: async (_id, update) => updates.push(update),
    activateStripePlanChange: async () => ({
      commitmentRequired: true,
      paymentPending: true,
      subscription: { id: "sub_123" },
      invoice: { id: "in_commitment", status: "open" },
    }),
  });

  assert.equal(result.status, "awaiting_commitment_payment");
  assert.deepEqual(updates.map((update) => update.status), [
    "activating",
    "awaiting_commitment_payment",
  ]);
  assert.equal(updates[1].commitment_invoice_id, "in_commitment");
});

test("failed closing invoice keeps the current plan active", async () => {
  const updates = [];
  const result = await processFailedInvoice(
    paidInvoice({ id: "in_failed", status: "open" }),
    {
      getSnApiPlanChangeByCustomer: async () => baseChange(),
      updateSnApiPlanChange: async (_id, update) => updates.push(update),
    }
  );

  assert.equal(result.status, "payment_failed");
  assert.equal(updates[0].status, "awaiting_current_invoice");
  assert.equal(updates[0].closing_invoice_id, "in_failed");
});

test("invoice paid before the effective boundary does not activate", async () => {
  let activationCalls = 0;
  const result = await processPaidInvoice(paidInvoice(), {
    getSnApiPlanChangeByCustomer: async () =>
      baseChange({ effective_at: new Date(Date.now() + 60000).toISOString() }),
    activateStripePlanChange: async () => {
      activationCalls += 1;
    },
  });

  assert.equal(result.skipped, "before_effective_at");
  assert.equal(activationCalls, 0);
});

test("paid commitment invoice completes a previously failed change", async () => {
  const updates = [];
  let grantCalls = 0;
  const result = await processPaidInvoice(
    paidInvoice({ id: "in_commitment" }),
    {
      getSnApiPlanChangeByCustomer: async () =>
        baseChange({
          status: "payment_failed",
          commitment_invoice_id: "in_commitment",
        }),
      updateSnApiPlanChange: async (_id, update) => updates.push(update),
      grantCommitmentFromInvoice: async () => {
        grantCalls += 1;
      },
      getStripeSubscription: async () => ({
        id: "sub_123",
        status: "active",
        items: { data: [{ price: { product: { id: "prod_growth" } } }] },
      }),
      getStripeCustomerById: async () => ({
        id: "cus_123",
        email: "buyer@example.com",
        metadata: { authUserId: "auth0|123" },
      }),
      provisionSnApiCustomer: async () => ({ user_id: 7, organization_id: 9 }),
      updateStripeCustomerIdentity: async () => {},
    }
  );

  assert.equal(result.status, "active");
  assert.equal(grantCalls, 1);
  assert.deepEqual(updates.map((update) => update.status), ["active"]);
});

test("reconciliation recovers a paid closing invoice after a missed webhook", async () => {
  const updates = [];
  const result = await reconcileDuePlanChanges({
    listSnApiDuePlanChanges: async () => [baseChange()],
    listStripeInvoices: async () => [paidInvoice()],
    getSnApiPlanChangeByCustomer: async () => baseChange(),
    updateSnApiPlanChange: async (_id, update) => updates.push(update),
    activateStripePlanChange: async () => ({
      commitmentRequired: false,
      subscription: {
        id: "sub_123",
        status: "active",
        items: { data: [{ price: { product: { id: "prod_growth" } } }] },
      },
    }),
    getStripeCustomerById: async () => ({
      id: "cus_123",
      email: "buyer@example.com",
      metadata: { authUserId: "auth0|123" },
    }),
    provisionSnApiCustomer: async () => ({ user_id: 7, organization_id: 9 }),
    updateStripeCustomerIdentity: async () => {},
  });

  assert.equal(result[0].status, "active");
  assert.deepEqual(updates.map((update) => update.status), ["activating", "active"]);
});

test("approved upgrade creates an exact invoice without activating access", async () => {
  const updates = [];
  const change = baseChange({
    status: "approved",
    change_type: "upgrade",
    quoted_amount_gbp_pence: 500000,
    stripe_subscription_id: null,
  });
  const result = await issueApprovedPlanChange(change, {
    issueReviewedPlanChangeInvoice: async () => ({
      amount: 500000,
      subscription: { id: "sub_new" },
      invoice: { id: "in_reviewed", status: "open", currency: "gbp" },
    }),
    updateSnApiPlanChange: async (_id, update) => updates.push(update),
  });

  assert.equal(result.status, "invoice_open");
  assert.equal(updates[0].stripe_subscription_id, "sub_new");
  assert.equal(updates[0].commitment_invoice_id, "in_reviewed");
  assert.equal(updates[0].quoted_amount_gbp_pence, 500000);
});

test("paid reviewed invoice applies the target plan before provisioning", async () => {
  const updates = [];
  let activationCalls = 0;
  const change = baseChange({
    status: "invoice_open",
    change_type: "upgrade",
    commitment_invoice_id: "in_reviewed",
  });
  const result = await processPaidInvoice(
    paidInvoice({
      id: "in_reviewed",
      metadata: { openopps_plan_change_request_id: change.request_id },
    }),
    {
      getSnApiPlanChangeByCustomer: async () => change,
      grantCommitmentFromInvoice: async () => {},
      updateSnApiPlanChange: async (_id, update) => updates.push(update),
      activateReviewedPlanChange: async () => {
        activationCalls += 1;
        return {
          id: "sub_123",
          status: "active",
          items: { data: [{ price: { product: { id: "prod_growth" } } }] },
        };
      },
      getStripeCustomerById: async () => ({
        id: "cus_123",
        email: "buyer@example.com",
        metadata: { authUserId: "auth0|123" },
      }),
      provisionSnApiCustomer: async () => ({ user_id: 7, organization_id: 9 }),
      updateStripeCustomerIdentity: async () => {},
    }
  );

  assert.equal(result.status, "active");
  assert.equal(activationCalls, 1);
  assert.deepEqual(updates.map((update) => update.status), ["activating", "active"]);
});

test("scheduled downgrade activates only when returned as due", async () => {
  const updates = [];
  const change = baseChange({
    status: "scheduled",
    change_type: "downgrade",
    from_plan_key: "enterprise",
    to_plan_key: "growth",
  });
  const result = await reconcileDuePlanChanges({
    listSnApiDuePlanChanges: async () => [change],
    activateReviewedPlanChange: async () => ({
      id: "sub_123",
      status: "active",
      items: { data: [{ price: { product: { id: "prod_growth" } } }] },
    }),
    getStripeCustomerById: async () => ({
      id: "cus_123",
      email: "buyer@example.com",
      metadata: { authUserId: "auth0|123" },
    }),
    provisionSnApiCustomer: async () => ({ user_id: 7, organization_id: 9 }),
    updateStripeCustomerIdentity: async () => {},
    updateSnApiPlanChange: async (_id, update) => updates.push(update),
  });

  assert.equal(result[0].status, "active");
  assert.deepEqual(updates.map((update) => update.status), ["active"]);
});

test("reconciliation fails a reviewed change when its invoice is void", async () => {
  const updates = [];
  const change = baseChange({
    status: "invoice_open",
    change_type: "upgrade",
    commitment_invoice_id: "in_void",
  });
  const result = await reconcileDuePlanChanges({
    listSnApiDuePlanChanges: async () => [change],
    getStripeInvoice: async () => ({ id: "in_void", status: "void" }),
    updateSnApiPlanChange: async (_id, update) => updates.push(update),
  });

  assert.equal(result[0].status, "failed");
  assert.equal(updates[0].status, "failed");
  assert.equal(updates[0].failure_code, "invoice_void");
});

test("downgrade to Basic ends recurring billing and creates prepaid access", async () => {
  const calls = [];
  const change = baseChange({
    status: "scheduled",
    change_type: "downgrade",
    from_plan_key: "growth",
    to_plan_key: "basic",
    target_product_id: "prod_basic",
  });
  const result = await completeBasicDowngrade(change, {
    getStripeCustomerById: async () => ({
      id: "cus_123",
      email: "buyer@example.com",
      metadata: { authUserId: "auth0|123" },
    }),
    getStripeProduct: async () => ({ id: "prod_basic" }),
    getPlanPrices: async () => ({
      commitmentPrices: [],
      meteredPrices: [
        { id: "price_1" },
        { id: "price_2" },
        { id: "price_3" },
        { id: "price_4" },
      ],
    }),
    validateBasicMeteredPrices: (prices) => prices.meteredPrices,
    provisionSnApiPrepaidCustomer: async ({ subscriptionStatus }) => {
      calls.push(`provision:${subscriptionStatus}`);
      return { user_id: 7, organization_id: 9 };
    },
    syncToMoesif: async () => calls.push("sync_moesif"),
    sendPrepaidSubscriptionToMoesif: async () => {
      calls.push("prepaid_subscription");
      return "prepaid_cus_123";
    },
    prepaidSubscriptionPeriodEnd: () => "2075-01-01T00:00:00.000Z",
    endStripeSubscriptionForBasicDowngrade: async () => {
      calls.push("cancel_recurring");
    },
    updateStripeCustomerIdentity: async (_id, identity) => {
      assert.equal(identity.subscriptionId, null);
      calls.push("update_identity");
    },
    updateSnApiPlanChange: async (_id, update) => {
      calls.push(`change:${update.status}`);
    },
  });

  assert.equal(result.status, "active");
  assert.deepEqual(calls, [
    "provision:provisioning",
    "sync_moesif",
    "prepaid_subscription",
    "cancel_recurring",
    "provision:active",
    "update_identity",
    "change:active",
  ]);
});
