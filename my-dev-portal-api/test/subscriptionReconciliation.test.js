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
    getSnApiPlanChangeByCustomer: async () => null,
    updateSnApiPlanChange: async () => {},
    closeStripeInvoice: async () => null,
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

test("a new Auth0 user without a Stripe customer is not an error", async () => {
  const noCustomer = new Error("Stripe customer not found");
  noCustomer.code = "stripe_customer_not_found";
  const result = await resolveAuthenticatedEntitlement(
    { sub: "auth0|new", email: "new@example.com" },
    null,
    dependencies({
      getActiveStripeSubscription: async () => {
        throw noCustomer;
      },
    })
  );

  assert.deepEqual(result, {
    active: false,
    reason: "stripe_customer_not_found",
  });
});

test("prepaid Basic context unlocks keys without a recurring Stripe subscription", async () => {
  let stripeLookups = 0;
  const result = await resolveAuthenticatedEntitlement(
    { sub: "auth0|123", email: "buyer@example.com" },
    {
      stripe_customer_id: "cus_123",
      current_subscription_id: null,
      current_plan_key: "basic",
      billing_status: "active",
    },
    dependencies({
      getActiveStripeSubscription: async () => {
        stripeLookups += 1;
        throw new Error("Stripe should not be queried");
      },
    })
  );

  assert.equal(result.active, true);
  assert.equal(result.planKey, "basic");
  assert.equal(result.source, "prepaid_basic_context");
  assert.equal(stripeLookups, 0);
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

test("reviewed send-invoice subscription stays locked until payment activation", async () => {
  let statusWrites = 0;
  let provisionCalls = 0;
  const result = await processSubscriptionLifecycle(
    subscription({
      metadata: {
        plan_id: "prod_growth",
        authUserId: "auth0|123",
        openopps_plan_change_request_id: "change-123",
      },
    }),
    dependencies({
      updateSnApiSubscriptionStatus: async () => {
        statusWrites += 1;
      },
      provisionSnApiCustomer: async () => {
        provisionCalls += 1;
      },
    })
  );

  assert.equal(result.status, "awaiting_plan_change_payment");
  assert.equal(statusWrites, 0);
  assert.equal(provisionCalls, 0);
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

test("scheduled Basic downgrade cancellation is left for the downgrade worker", async () => {
  let endedCalls = 0;
  const result = await processSubscriptionLifecycle(
    subscription({ status: "canceled" }),
    dependencies({
      updateSnApiSubscriptionStatus: async () => ({ is_current: true }),
      getSnApiPlanChangeByCustomer: async () => ({
        request_id: "change-basic",
        status: "scheduled",
        change_type: "downgrade",
        to_plan_key: "basic",
        stripe_subscription_id: "sub_growth",
        effective_at: new Date(Date.now() - 1000).toISOString(),
      }),
      handleSubscriptionEnded: async () => {
        endedCalls += 1;
        return { revoked: [1], failed: [] };
      },
    })
  );

  assert.equal(result.status, "scheduled_downgrade_transition");
  assert.equal(endedCalls, 0);
});

test("cancellation also closes a pending upgrade from that subscription", async () => {
  const updates = [];
  await processSubscriptionLifecycle(
    subscription({ status: "canceled" }),
    dependencies({
      updateSnApiSubscriptionStatus: async () => ({ is_current: true }),
      getSnApiPlanChangeByCustomer: async () => ({
        request_id: "change-123",
        status: "pending_review",
        stripe_subscription_id: "sub_growth",
        commitment_invoice_id: null,
      }),
      updateSnApiPlanChange: async (_id, update) => updates.push(update),
      handleSubscriptionEnded: async () => ({ revoked: [1], failed: [] }),
    })
  );

  assert.equal(updates[0].status, "cancelled");
  assert.equal(updates[0].failure_code, "source_subscription_ended");
});

test("cancellation voids an unpaid upgrade invoice before closing its request", async () => {
  const updates = [];
  let closedInvoiceId = null;
  await processSubscriptionLifecycle(
    subscription({
      status: "canceled",
      metadata: {
        openopps_plan_change_request_id: "change-123",
        openopps_plan_change_activated: "false",
      },
    }),
    dependencies({
      updateSnApiSubscriptionStatus: async () => ({ is_current: true }),
      getSnApiPlanChangeByCustomer: async () => ({
        request_id: "change-123",
        status: "invoice_open",
        stripe_subscription_id: "sub_growth",
        commitment_invoice_id: "in_upgrade",
      }),
      closeStripeInvoice: async (invoiceId) => {
        closedInvoiceId = invoiceId;
        return { id: invoiceId, status: "void" };
      },
      updateSnApiPlanChange: async (_id, update) => updates.push(update),
      handleSubscriptionEnded: async () => ({ revoked: [1], failed: [] }),
    })
  );

  assert.equal(closedInvoiceId, "in_upgrade");
  assert.equal(updates[0].status, "cancelled");
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
