function stripeId(value) {
  return typeof value === "string" ? value : value?.id;
}

function reconciliationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function subscriptionProductId(subscription) {
  const productIds = new Set(
    (subscription?.items?.data || [])
      .map((item) => stripeId(item?.price?.product))
      .filter(Boolean)
  );
  if (!productIds.size) {
    throw reconciliationError(
      "subscription_product_missing",
      "The subscription has no product prices"
    );
  }
  if (productIds.size > 1) {
    throw reconciliationError(
      "mixed_subscription_products",
      "A subscription cannot contain prices from multiple plans",
      { productIds: [...productIds] }
    );
  }
  return [...productIds][0];
}

function subscriptionIdentity(customer, explicitAuthUser, fallbackAuth0UserId) {
  const auth0UserId = explicitAuthUser?.sub ||
    customer?.metadata?.authUserId ||
    fallbackAuth0UserId;
  const linkedAuthUserId = customer?.metadata?.authUserId;
  if (
    explicitAuthUser?.sub &&
    linkedAuthUserId &&
    explicitAuthUser.sub !== linkedAuthUserId
  ) {
    throw reconciliationError(
      "stripe_customer_identity_mismatch",
      "The Stripe customer is linked to a different authenticated user"
    );
  }
  const email = explicitAuthUser?.email || customer?.email;
  if (!auth0UserId || !email) {
    throw reconciliationError(
      "subscription_identity_missing",
      "Stripe customer is missing Auth0 identity metadata or email"
    );
  }
  return {
    sub: auth0UserId,
    email,
    name:
      explicitAuthUser?.name ||
      explicitAuthUser?.nickname ||
      customer?.name ||
      email,
  };
}

async function reconcileActiveSubscription(
  subscriptionOrId,
  { authUser, fallbackAuth0UserId, source = "subscription_reconciliation" } = {},
  deps
) {
  let subscription = await deps.getStripeSubscription(
    stripeId(subscriptionOrId)
  );
  if (!deps.liveStatuses.includes(subscription.status)) {
    throw reconciliationError(
      "no_active_subscription",
      `Subscription ${subscription.id} is ${subscription.status}`
    );
  }

  const customerId = stripeId(subscription.customer);
  if (!customerId) {
    throw reconciliationError(
      "subscription_customer_missing",
      "Subscription is missing its Stripe customer"
    );
  }
  const customer = await deps.getStripeCustomerById(customerId);
  const identity = subscriptionIdentity(customer, authUser, fallbackAuth0UserId);
  const productId = subscription.metadata?.plan_id || subscriptionProductId(subscription);

  subscription = await deps.ensureSubscriptionMeteredPrices(
    subscription.id,
    productId,
    `entitlement-${subscription.id}`
  );
  const resolvedProductId = subscriptionProductId(subscription);
  if (resolvedProductId !== productId) {
    throw reconciliationError(
      "subscription_plan_mismatch",
      "Subscription metadata and price products refer to different plans"
    );
  }
  const product = await deps.getStripeProduct(productId);
  const planKey = await deps.getPlanKeyForProduct(productId);
  const price = subscription.items.data[0]?.price;

  const provisioned = await deps.provisionSnApiCustomer({
    authUser: identity,
    customer,
    subscription,
    price,
    product,
  });
  await deps.updateStripeCustomerIdentity(customer.id, {
    moesifUserId: provisioned.user_id,
    moesifCompanyId:
      provisioned.moesif_company_id || provisioned.organization_id,
    auth0UserId: identity.sub,
    subscriptionId: subscription.id,
  });

  if (planKey === "basic") {
    await deps.ensureCreditGrant(customer.id, "basic", {
      currency: price?.currency || "gbp",
    });
  }
  if (subscription.latest_invoice?.status === "paid") {
    await deps.grantCommitmentFromInvoice(subscription.latest_invoice);
  }

  await deps.syncToMoesif({
    companyId: String(
      provisioned.moesif_company_id || provisioned.organization_id
    ),
    userId: String(provisioned.user_id),
    email: identity.email,
    auth0UserId: identity.sub,
    stripeCustomerId: customer.id,
  });

  return {
    active: true,
    source,
    customer,
    subscription,
    product,
    price,
    planKey,
    provisioned,
  };
}

async function reconcileCheckoutSession(sessionOrId, authUser, deps) {
  const session = typeof sessionOrId === "string"
    ? await deps.verifyStripeSession(sessionOrId)
    : sessionOrId;
  if (session?.status !== "complete") {
    throw reconciliationError(
      "checkout_incomplete",
      "Stripe checkout is not complete"
    );
  }
  if (session.payment_status === "unpaid") {
    throw reconciliationError(
      "checkout_payment_pending",
      "Stripe checkout payment has not completed"
    );
  }
  const subscriptionId = stripeId(session.subscription);
  if (!subscriptionId) {
    throw reconciliationError(
      "checkout_subscription_missing",
      "Checkout session has no subscription"
    );
  }
  return reconcileActiveSubscription(
    subscriptionId,
    {
      authUser,
      fallbackAuth0UserId: session.client_reference_id,
      source: "checkout_session",
    },
    deps
  );
}

async function resolveAuthenticatedEntitlement(authUser, portalContext, deps) {
  let active;
  try {
    active = await deps.getActiveStripeSubscription(
      authUser.email,
      authUser.sub,
      portalContext?.stripe_customer_id
    );
  } catch (error) {
    if (
      error.code === "no_active_subscription" ||
      error.code === "stripe_customer_not_found"
    ) {
      return { active: false, reason: error.code };
    }
    throw error;
  }

  const productId = subscriptionProductId(active.subscription);
  const planKey = await deps.getPlanKeyForProduct(productId);
  const contextIsCurrent =
    portalContext?.stripe_customer_id === active.customer.id &&
    portalContext?.current_subscription_id === active.subscription.id &&
    portalContext?.current_plan_key === planKey &&
    portalContext?.billing_status === active.subscription.status &&
    active.subscription.metadata?.entitlement_sync_version === "1" &&
    active.subscription.metadata?.current_subscription_id ===
      active.subscription.id;

  if (contextIsCurrent) {
    return { active: true, ...active, planKey, reconciled: false };
  }
  const reconciled = await reconcileActiveSubscription(
    active.subscription.id,
    { authUser, source: "authenticated_self_heal" },
    deps
  );
  return { ...reconciled, reconciled: true };
}

async function processSubscriptionLifecycle(subscription, deps) {
  const customerId = stripeId(subscription.customer);
  if (!customerId) {
    throw reconciliationError(
      "subscription_customer_missing",
      "Stripe subscription has no customer ID"
    );
  }

  let statusWasKnown = true;
  try {
    await deps.updateSnApiSubscriptionStatus(subscription, customerId);
  } catch (error) {
    statusWasKnown = error.status !== 404;
    if (statusWasKnown) throw error;
  }

  if (deps.liveStatuses.includes(subscription.status)) {
    const alreadyLinked =
      statusWasKnown &&
      subscription.metadata?.entitlement_sync_version === "1" &&
      subscription.metadata?.current_subscription_id === subscription.id &&
      subscription.metadata?.authUserId &&
      subscription.metadata?.sn_organization_id;
    if (alreadyLinked) return { status: "synchronized" };
    return reconcileActiveSubscription(
      subscription.id,
      {
        fallbackAuth0UserId: subscription.metadata?.authUserId,
        source: "stripe_subscription_webhook",
      },
      deps
    );
  }

  const result = await deps.handleSubscriptionEnded(subscription, {
    getStripeCustomerById: deps.getStripeCustomerById,
    listStripeSubscriptions: deps.listStripeSubscriptions,
  });
  if (result?.skipped !== "other_live_subscription") return result;

  const subscriptions = await deps.listStripeSubscriptions(customerId);
  const live = subscriptions.filter((candidate) =>
    deps.liveStatuses.includes(candidate.status)
  );
  if (live.length !== 1) {
    throw reconciliationError(
      "multiple_active_subscriptions",
      `Customer ${customerId} has ${live.length} live subscriptions after replacement`,
      { subscriptionIds: live.map((candidate) => candidate.id) }
    );
  }
  await reconcileActiveSubscription(
    live[0].id,
    {
      fallbackAuth0UserId: live[0].metadata?.authUserId,
      source: "replacement_subscription_webhook",
    },
    deps
  );
  return result;
}

module.exports = {
  reconciliationError,
  subscriptionProductId,
  subscriptionIdentity,
  reconcileActiveSubscription,
  reconcileCheckoutSession,
  resolveAuthenticatedEntitlement,
  processSubscriptionLifecycle,
};
