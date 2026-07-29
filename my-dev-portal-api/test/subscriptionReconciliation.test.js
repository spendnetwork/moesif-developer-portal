const test = require("node:test");
const assert = require("node:assert/strict");

const {
  reconcileActiveSubscription,
  reconcileCheckoutSession,
  resolveAuthenticatedEntitlement,
  subscriptionProductId,
  processSubscriptionLifecycle,
} = require("../services/subscriptionReconciliation");

function subscription(overrides = {}) {
  return {
    id: "sub_growth",
    customer: "cus_123",
    status: "active",
    metadata: {
      plan_id: "prod_growth",
      entitlement_sync_version: "1",
      current_subscription_id: "sub_growth",
    },
    items: {
      data: [
        {
          id: "si_api",
          current_period_start: 1700000000,
          current_period_end: 1702592000,
          price: {
            id: "price_growth_api",
            currency: "gbp",
            recurring: { usage_type: "metered" },
            product: { id: "prod_growth", metadata: { plan_key: "growth" } },
          },
        },
      ],
    },
    latest_invoice: { id: "in_paid", status: "paid", lines: { data: [] } },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const fullSubscription = subscription();
  return {
    liveStatuses: ["active", "trialing", "past_due"],
    getStripeSubscription: async () => fullSubscription,
    getStripeCustomerById: async () => ({
      id: "cus_123",
      email: "buyer@example.com",
      metadata: { authUserId: "auth0|123" },
    }),
    ensureSubscriptionMeteredPrices: async () => fullSubscription,
    getStripeProduct: async () => ({
      id: "prod_growth",
      metadata: { plan_key: "growth" },
    }),
    getPlanKeyForProduct: async () => "growth",
    provisionSnApiCustomer: async () => ({
      user_id: 7,
      organization_id: 9,
      moesif_company_id: "9",
    }),
    updateStripeCustomerIdentity: async () => {},
    ensureCreditGrant: async () => {},
    grantCommitmentFromInvoice: async () => {},
    syncToMoesif: async () => {},
    ...overrides,
  };
}

test("initial Growth checkout provisions Gold-plan entitlement without the browser", async () => {
  let provisioned = null;
  const result = await reconcileCheckoutSession(
    {
      id: "cs_123",
      status: "complete",
      subscription: "sub_growth",
      client_reference_id: "auth0|123",
    },
    null,
    dependencies({
      provisionSnApiCustomer: async (input) => {
        provisioned = input;
        return { user_id: 7, organization_id: 9 };
      },
    })
  );

  assert.equal(result.planKey, "growth");
  assert.equal(provisioned.authUser.sub, "auth0|123");
  assert.equal(provisioned.subscription.id, "sub_growth");
});

test("completed but unpaid checkout never provisions API access", async () => {
  await assert.rejects(
    reconcileCheckoutSession(
      {
        id: "cs_pending",
        status: "complete",
        payment_status: "unpaid",
        subscription: "sub_growth",
        client_reference_id: "auth0|123",
      },
      null,
      dependencies()
    ),
    (error) => error.code === "checkout_payment_pending"
  );
});

test("stale SN API context is reconciled before API keys are unlocked", async () => {
  let reconciliationCalls = 0;
  const deps = dependencies({
    getActiveStripeSubscription: async () => ({
      customer: { id: "cus_123" },
      subscription: subscription(),
    }),
    provisionSnApiCustomer: async () => {
      reconciliationCalls += 1;
      return { user_id: 7, organization_id: 9 };
    },
  });
  const result = await resolveAuthenticatedEntitlement(
    { sub: "auth0|123", email: "buyer@example.com" },
    {
      stripe_customer_id: "cus_123",
      current_subscription_id: "sub_cancelled",
      current_plan_key: "basic",
      billing_status: "canceled",
    },
    deps
  );

  assert.equal(result.active, true);
  assert.equal(result.reconciled, true);
  assert.equal(reconciliationCalls, 1);
});

test("current entitlement avoids unnecessary provisioning writes", async () => {
  let reconciliationCalls = 0;
  const deps = dependencies({
    getActiveStripeSubscription: async () => ({
      customer: { id: "cus_123" },
      subscription: subscription(),
    }),
    provisionSnApiCustomer: async () => {
      reconciliationCalls += 1;
    },
  });
  const result = await resolveAuthenticatedEntitlement(
    { sub: "auth0|123", email: "buyer@example.com" },
    {
      stripe_customer_id: "cus_123",
      current_subscription_id: "sub_growth",
      current_plan_key: "growth",
      billing_status: "active",
    },
    deps
  );

  assert.equal(result.active, true);
  assert.equal(result.reconciled, false);
  assert.equal(reconciliationCalls, 0);
});

test("no live Stripe subscription keeps API keys locked", async () => {
  const noSubscription = new Error("No active subscription");
  noSubscription.code = "no_active_subscription";
  const result = await resolveAuthenticatedEntitlement(
    { sub: "auth0|123", email: "buyer@example.com" },
    null,
    dependencies({
      getActiveStripeSubscription: async () => {
        throw noSubscription;
      },
    })
  );

  assert.deepEqual(result, {
    active: false,
    reason: "no_active_subscription",
  });
});

test("mixed plan products are rejected instead of granting ambiguous permissions", () => {
  const malformed = subscription();
  malformed.items.data.push({
    id: "si_other",
    price: { id: "price_other", product: "prod_enterprise" },
  });
  assert.throws(
    () => subscriptionProductId(malformed),
    (error) => error.code === "mixed_subscription_products"
  );
});

test("reconciliation preserves explicit API-key scoping at the SN API boundary", async () => {
  let input;
  await reconcileActiveSubscription(
    "sub_growth",
    { authUser: { sub: "auth0|123", email: "buyer@example.com" } },
    dependencies({
      provisionSnApiCustomer: async (value) => {
        input = value;
        return { user_id: 7, organization_id: 9 };
      },
    })
  );
  assert.equal(input.subscription.id, "sub_growth");
  assert.equal(input.product.metadata.plan_key, "growth");
  // Reconciliation changes the user role. It never rotates or broadens a
  // stored key's explicit scopes; SN API intersects scopes at request time.
  assert.equal(input.rotateApiKey, undefined);
});

test("subscription.created provisions when the SN API has not seen checkout yet", async () => {
  let provisionCalls = 0;
  const notFound = new Error("Subscription not found");
  notFound.status = 404;
  const result = await processSubscriptionLifecycle(
    subscription({
      metadata: { plan_id: "prod_growth", authUserId: "auth0|123" },
    }),
    dependencies({
      updateSnApiSubscriptionStatus: async () => {
        throw notFound;
      },
      provisionSnApiCustomer: async () => {
        provisionCalls += 1;
        return { user_id: 7, organization_id: 9 };
      },
    })
  );

  assert.equal(result.active, true);
  assert.equal(provisionCalls, 1);
});

test("cancellation revokes access when no replacement subscription is live", async () => {
  let endedCalls = 0;
  const result = await processSubscriptionLifecycle(
    subscription({ status: "canceled" }),
    dependencies({
      updateSnApiSubscriptionStatus: async () => ({ is_current: true }),
      handleSubscriptionEnded: async () => {
        endedCalls += 1;
        return { revoked: [1], failed: [] };
      },
    })
  );

  assert.equal(endedCalls, 1);
  assert.deepEqual(result.revoked, [1]);
});

test("late cancellation reconciles the sole live replacement without revoking keys", async () => {
  let replacementProvisionCalls = 0;
  const result = await processSubscriptionLifecycle(
    subscription({ id: "sub_old", status: "canceled" }),
    dependencies({
      updateSnApiSubscriptionStatus: async () => ({ is_current: false }),
      handleSubscriptionEnded: async () => ({ skipped: "other_live_subscription" }),
      listStripeSubscriptions: async () => [subscription()],
      provisionSnApiCustomer: async () => {
        replacementProvisionCalls += 1;
        return { user_id: 7, organization_id: 9 };
      },
    })
  );

  assert.equal(result.skipped, "other_live_subscription");
  assert.equal(replacementProvisionCalls, 1);
});
