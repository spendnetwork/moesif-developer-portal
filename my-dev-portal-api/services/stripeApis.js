const StripeSDK = require("stripe");
const crypto = require("crypto");
const {
  METRIC_LABELS,
  finiteNumber,
  metricKey,
  metricOrder,
  priceUnitAmountPence,
} = require("./usageMetrics");
const {
  BASIC_ACTIVATION,
  BASIC_CREDIT_TOP_UP,
  isBasicPurchaseType,
} = require("./basicPurchasePolicy");
const stripe = StripeSDK(process.env.STRIPE_API_KEY);

// Stale-while-revalidate cache. Within FRESH the cached value is served as-is;
// between FRESH and STALE_MAX it is served immediately and refreshed in the
// background; beyond STALE_MAX (or on a cold miss) we block on a fresh fetch.
const USAGE_SUMMARY_FRESH_TTL_MS = 3 * 60 * 1000;
const USAGE_SUMMARY_STALE_TTL_MS = 30 * 60 * 1000;
const USAGE_SUMMARY_CACHE_MAX_ENTRIES = 1000;
const usageSummaryCache = new Map();
const usageSummaryInflight = new Map();
const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"];
const BASIC_TOP_UP_MIN_AMOUNT_GBP = 1;

function getFrontendUrl(pathname) {
  const configured = String(process.env.FRONT_END_DOMAIN || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(configured)) return `${configured}${pathname}`;
  const scheme = configured.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${configured}${pathname}`;
}

function normalizeBasicTopUpAmount(amountGbp) {
  const amount = Number(amountGbp);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw stripeLookupError(
      "invalid_top_up_amount",
      "Enter a valid Basic credit amount"
    );
  }
  const amountPence = Math.round(amount * 100);
  if (Math.abs(amountPence / 100 - amount) > Number.EPSILON * 100) {
    throw stripeLookupError(
      "invalid_top_up_amount",
      "Basic credit amounts can have at most two decimal places"
    );
  }
  if (amountPence < BASIC_TOP_UP_MIN_AMOUNT_GBP * 100) {
    throw stripeLookupError(
      "top_up_below_minimum",
      `The minimum Basic credit purchase is GBP ${BASIC_TOP_UP_MIN_AMOUNT_GBP.toFixed(2)}`
    );
  }
  return amountPence;
}

function cacheUsageSummary(cacheKey, summary) {
  if (!cacheKey) return;
  const now = Date.now();
  if (usageSummaryCache.size >= USAGE_SUMMARY_CACHE_MAX_ENTRIES) {
    for (const [key, value] of usageSummaryCache) {
      if (now - value.fetchedAt >= USAGE_SUMMARY_STALE_TTL_MS) {
        usageSummaryCache.delete(key);
      }
    }
    if (usageSummaryCache.size >= USAGE_SUMMARY_CACHE_MAX_ENTRIES) {
      usageSummaryCache.delete(usageSummaryCache.keys().next().value);
    }
  }
  usageSummaryCache.set(cacheKey, { summary, fetchedAt: now });
}

// A price represents a prepaid commitment (draws down into credit) if it
// carries the commitment metadata. Kept in one place so checkout, the webhook
// and the usage summary all agree.
function isCommitmentPrice(price) {
  const md = price?.metadata || {};
  return (
    md.billing_model === "prepaid_credit" ||
    md.billing_category === "commitment" ||
    md.commitment_amount != null
  );
}

function verifyStripeSession(checkoutSessionId) {
  return stripe.checkout.sessions.retrieve(checkoutSessionId, {
    expand: [
      "customer",
      "payment_intent",
      "subscription",
      "line_items.data.price.product",
    ],
  });
}

function buildStripeUsageLines(subscription, preview) {
  const definitions = new Map();
  for (const item of subscription?.items?.data || []) {
    const price = item.price;
    if (
      !price?.id ||
      isCommitmentPrice(price) ||
      price.recurring?.usage_type !== "metered"
    ) {
      continue;
    }
    const key = metricKey(price);
    definitions.set(price.id, {
      key,
      label: METRIC_LABELS[key] || price.nickname || "Usage",
      rate: priceUnitAmountPence(price),
    });
  }

  const usage = new Map();
  for (const line of preview?.lines?.data || []) {
    const priceId = line.price?.id || line.pricing?.price_details?.price || null;
    if (!definitions.has(priceId)) continue;
    const current = usage.get(priceId) || { quantity: 0, amount: 0 };
    current.quantity += finiteNumber(line.quantity) || 0;
    current.amount += finiteNumber(line.amount) || 0;
    usage.set(priceId, current);
  }

  return [...definitions.entries()]
    .map(([priceId, definition]) => ({
      key: definition.key,
      label: definition.label,
      rate: definition.rate,
      quantity: usage.get(priceId)?.quantity || 0,
      amount: usage.get(priceId)?.amount || 0,
    }))
    .sort(metricOrder);
}

function stripeLookupError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isMissingStripeCustomer(error) {
  return (
    error?.code === "resource_missing" ||
    error?.statusCode === 404 ||
    error?.status === 404
  );
}

function assertCustomerIdentity(customer, { email, authUserId }) {
  const customerEmail = String(customer?.email || "").trim().toLowerCase();
  const expectedEmail = String(email || "").trim().toLowerCase();
  if (customerEmail && expectedEmail && customerEmail !== expectedEmail) {
    throw stripeLookupError(
      "stripe_customer_identity_mismatch",
      "The Stripe customer does not match the authenticated email"
    );
  }
  const linkedAuthUserId = customer?.metadata?.authUserId;
  if (linkedAuthUserId && authUserId && linkedAuthUserId !== authUserId) {
    throw stripeLookupError(
      "stripe_customer_identity_mismatch",
      "The Stripe customer is linked to a different authenticated user"
    );
  }
}

async function resolveStripeCustomer(email, authUserId, preferredCustomerId) {
  if (preferredCustomerId) {
    let preferred;
    try {
      preferred = await stripe.customers.retrieve(preferredCustomerId);
    } catch (error) {
      if (!isMissingStripeCustomer(error)) throw error;
    }

    // A cached SN API context can briefly retain a deleted Stripe customer
    // ID. Treat that reference as stale and continue with the canonical email
    // lookup so a brand-new account resolves to "not subscribed" normally.
    if (preferred && !preferred.deleted) {
      assertCustomerIdentity(preferred, { email, authUserId });
      if (authUserId && preferred.metadata?.authUserId !== authUserId) {
        return stripe.customers.update(preferred.id, {
          metadata: { authUserId },
        });
      }
      return preferred;
    }
  }

  const customers = await stripe.customers.search({
    query: `email:"${email.replace(/"/g, "\\\"")}"`,
    limit: 100,
  });
  const candidates = customers.data.filter(
    (candidate) =>
      !candidate.deleted &&
      String(candidate.email || "").trim().toLowerCase() ===
        String(email || "").trim().toLowerCase()
  );
  const identityMatches = candidates.filter(
    (candidate) => candidate.metadata?.authUserId === authUserId
  );
  if (identityMatches.length > 1) {
    throw stripeLookupError(
      "multiple_stripe_customers",
      "Multiple Stripe customers are linked to this account",
      { customerIds: identityMatches.map((candidate) => candidate.id) }
    );
  }
  let customer = identityMatches[0];
  if (!customer && candidates.length === 1) customer = candidates[0];
  if (!customer && candidates.length > 1) {
    throw stripeLookupError(
      "ambiguous_stripe_customer",
      "Multiple Stripe customers use this email and none is linked to this login",
      { customerIds: candidates.map((candidate) => candidate.id) }
    );
  }
  if (!customer) {
    throw stripeLookupError("stripe_customer_not_found", "Stripe customer not found");
  }
  assertCustomerIdentity(customer, { email, authUserId });
  if (authUserId && customer.metadata?.authUserId !== authUserId) {
    customer = await stripe.customers.update(customer.id, {
      metadata: { authUserId },
    });
  }
  return customer;
}

async function getActiveStripeSubscription(email, authUserId, preferredCustomerId) {
  const customer = await resolveStripeCustomer(
    email,
    authUserId,
    preferredCustomerId
  );

  const subscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: "all",
    limit: 100,
  });
  const activeSubscriptions = subscriptions.data.filter((candidate) =>
    LIVE_SUBSCRIPTION_STATUSES.includes(candidate.status)
  );
  if (!activeSubscriptions.length) {
    const error = new Error("Active Stripe subscription not found");
    error.code = "no_active_subscription";
    throw error;
  }
  if (activeSubscriptions.length > 1) {
    const error = new Error(
      `Customer has ${activeSubscriptions.length} active subscriptions; resolve duplicates before changing plans`
    );
    error.code = "multiple_active_subscriptions";
    error.subscriptionIds = activeSubscriptions.map((item) => item.id);
    throw error;
  }
  const subscription = activeSubscriptions[0];

  const price = subscription.items.data[0]?.price;
  if (!price) throw new Error("Stripe subscription price not found");

  const product = typeof price.product === "string"
    ? await stripe.products.retrieve(price.product)
    : price.product;

  return { customer, subscription, price, product };
}

async function getPlanPrices(planId) {
  const prices = await stripe.prices.list({
    product: planId,
    active: true,
    limit: 100,
  });
  if (!prices.data.length) {
    throw new Error(`No active prices found for plan ${planId}`);
  }

  const commitmentPrices = prices.data.filter(
    (price) =>
      isCommitmentPrice(price) || price.recurring?.usage_type === "licensed"
  );
  const meteredPrices = prices.data.filter(
    (price) => price.recurring?.usage_type === "metered"
  );
  if (commitmentPrices.length > 1) {
    throw new Error(`Multiple active commitment prices found for plan ${planId}`);
  }
  if (!meteredPrices.length) {
    throw new Error(`No active metered prices found for plan ${planId}`);
  }
  return { commitmentPrices, meteredPrices };
}

function getStripeProduct(productId) {
  return stripe.products.retrieve(productId);
}

async function getPlanKeyForProduct(productId) {
  const product = await stripe.products.retrieve(productId);
  const configured = product.metadata?.plan_key;
  if (configured) {
    const normalized = String(configured).trim().toLowerCase();
    if (["basic", "growth", "enterprise"].includes(normalized)) {
      return normalized;
    }
    throw new Error(`Product ${productId} has unsupported plan_key ${configured}`);
  }
  throw new Error(`Product ${productId} is missing plan_key metadata`);
}

function subscriptionProductIds(subscription) {
  const productIds = new Set();
  if (subscription?.metadata?.plan_id) {
    productIds.add(String(subscription.metadata.plan_id));
  }
  for (const item of subscription?.items?.data || []) {
    const product = item?.price?.product;
    const productId = typeof product === "string" ? product : product?.id;
    if (productId) productIds.add(String(productId));
  }
  return [...productIds];
}

async function getSubscriptionPlanKey(
  subscription,
  resolveProductPlanKey = getPlanKeyForProduct
) {
  const configured = String(subscription?.metadata?.plan_key || "")
    .trim()
    .toLowerCase();
  const productIds = subscriptionProductIds(subscription);
  if (!productIds.length) {
    if (["basic", "growth", "enterprise"].includes(configured)) {
      return configured;
    }
    throw stripeLookupError(
      "subscription_plan_unknown",
      `Subscription ${subscription?.id || "unknown"} has no plan product`
    );
  }
  const planKeys = new Set(
    await Promise.all(productIds.map((productId) => resolveProductPlanKey(productId)))
  );
  if (planKeys.size !== 1) {
    throw stripeLookupError(
      "mixed_subscription_products",
      `Subscription ${subscription?.id || "unknown"} contains multiple plans`
    );
  }
  const resolved = [...planKeys][0];
  if (configured && configured !== resolved) {
    throw stripeLookupError(
      "subscription_plan_mismatch",
      `Subscription ${subscription?.id || "unknown"} metadata does not match its prices`
    );
  }
  return resolved;
}

async function assertBasicTopUpAllowed(
  liveSubscriptions,
  resolveSubscriptionPlanKey = getSubscriptionPlanKey
) {
  const classified = await Promise.all(
    (liveSubscriptions || []).map(async (subscription) => ({
      subscription,
      planKey: await resolveSubscriptionPlanKey(subscription),
    }))
  );
  const conflicts = classified.filter(({ planKey }) => planKey !== "basic");
  if (!conflicts.length) return classified;

  throw stripeLookupError(
    conflicts.length > 1
      ? "multiple_active_subscriptions"
      : "active_subscription_exists",
    "Basic credit cannot be purchased while Growth or Enterprise is active. Switch to Basic at renewal before adding credit.",
    {
      subscriptionIds: conflicts.map(({ subscription }) => subscription.id),
      planKeys: [...new Set(conflicts.map(({ planKey }) => planKey))],
    }
  );
}

// Webhooks identify the customer by id, not email, so subscription enforcement
// needs a direct lookup (the metadata carries the Auth0 subject).
function getStripeCustomerById(customerId) {
  return stripe.customers.retrieve(customerId);
}

// Every subscription for a customer, whatever its status, so enforcement can
// tell "nothing live left" from "one of several ended".
async function listStripeSubscriptions(customerId) {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });
  return subscriptions.data;
}

async function getOrCreateStripeCustomerId(email, authUser) {
  let customer;
  try {
    customer = await resolveStripeCustomer(
      email,
      authUser?.sub,
      authUser?.stripe_customer_id
    );
  } catch (error) {
    if (error.code !== "stripe_customer_not_found") throw error;
    const identity = authUser?.sub || email.toLowerCase();
    const identityHash = crypto
      .createHash("sha256")
      .update(identity)
      .digest("hex");
    customer = await stripe.customers.create(
      {
        email: email,
        metadata: {
          authUserId: authUser?.sub,
        },
      },
      { idempotencyKey: `portal-customer-${identityHash}` }
    );

  }
  return customer.id;
}

async function createStripePlanCheckoutSession(email, planId, authUser, requestId) {
  const customerId = await getOrCreateStripeCustomerId(email, authUser);

  // A plan (Stripe product) can carry several usage prices - one per
  // billing meter - so the subscription must include every active price.
  const { commitmentPrices, meteredPrices } = await getPlanPrices(planId);

  // Stripe Checkout cannot create a mixed-interval subscription. For a
  // commitment plan, Checkout collects the annual commitment first and the
  // monthly metered items are attached after the session completes.
  const checkoutPrices = commitmentPrices.length
    ? commitmentPrices
    : meteredPrices;
  if (!checkoutPrices.length) {
    throw new Error(`No checkout prices found for plan ${planId}`);
  }

  const lineItems = checkoutPrices.map((price) => ({
    price: price.id,
    // metered prices must not carry a quantity
    quantity: price.recurring?.usage_type === "metered" ? undefined : 1,
  }));

  const session = await stripe.checkout.sessions.create(
    {
      ui_mode: "embedded",
      line_items: lineItems,
      customer: customerId,
      client_reference_id: authUser?.sub,
      mode: "subscription",
      metadata: {
        plan_id: planId,
        attach_metered_prices: commitmentPrices.length ? "true" : "false",
      },
      subscription_data: {
        billing_mode: { type: "flexible" },
        metadata: { plan_id: planId },
      },
      return_url: getFrontendUrl(
        `/return?session_id={CHECKOUT_SESSION_ID}&plan_id=${encodeURIComponent(
          planId
        )}`
      ),
    },
    requestId ? { idempotencyKey: `checkout-${requestId}` } : undefined
  );

  return session;
}

async function createBasicCreditCheckoutSession(
  email,
  planId,
  amountGbp,
  purchaseType,
  authUser,
  requestId
) {
  const planKey = await getPlanKeyForProduct(planId);
  if (planKey !== "basic") {
    throw stripeLookupError(
      "invalid_top_up_plan",
      "Flexible credit purchases are only available for the Basic plan"
    );
  }
  if (!isBasicPurchaseType(purchaseType)) {
    throw stripeLookupError(
      "invalid_basic_purchase_type",
      "Choose Basic before purchasing API credit"
    );
  }

  const amountPence = normalizeBasicTopUpAmount(amountGbp);
  const customerId = await getOrCreateStripeCustomerId(email, authUser);
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });
  const liveSubscriptions = subscriptions.data.filter((candidate) =>
    LIVE_SUBSCRIPTION_STATUSES.includes(candidate.status)
  );
  await assertBasicTopUpAllowed(liveSubscriptions);

  const metadata = {
    purchase_type: purchaseType,
    plan_id: planId,
    plan_key: "basic",
    amount_gbp_pence: String(amountPence),
    auth0_user_id: authUser?.sub || "",
  };
  const session = await stripe.checkout.sessions.create(
    {
      ui_mode: "embedded",
      customer: customerId,
      client_reference_id: authUser?.sub,
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product: planId,
            unit_amount: amountPence,
          },
          quantity: 1,
        },
      ],
      metadata,
      payment_intent_data: { metadata },
      return_url: getFrontendUrl(
        `/return?session_id={CHECKOUT_SESSION_ID}&plan_id=${encodeURIComponent(
          planId
        )}&purchase_type=${encodeURIComponent(purchaseType)}`
      ),
    },
    requestId
      ? { idempotencyKey: `${purchaseType}-${requestId}` }
      : undefined
  );
  return session;
}

async function getBasicTopUpTotalPence(customerId) {
  let total = 0;
  const paymentIntents = stripe.paymentIntents.list({
    customer: customerId,
    limit: 100,
    expand: ["data.latest_charge"],
  });
  for await (const paymentIntent of paymentIntents) {
    if (
      paymentIntent.status !== "succeeded" ||
      ![BASIC_ACTIVATION, BASIC_CREDIT_TOP_UP].includes(
        paymentIntent.metadata?.purchase_type
      ) ||
      paymentIntent.metadata?.moesif_credit_status !== "applied"
    ) {
      continue;
    }
    const charge =
      typeof paymentIntent.latest_charge === "object"
        ? paymentIntent.latest_charge
        : null;
    const refunded = Number(charge?.amount_refunded || 0);
    const received = Number(paymentIntent.amount_received || 0);
    total += Math.max(0, received - refunded);
  }
  return total;
}

async function markBasicTopUpReconciled(
  paymentIntentId,
  { companyId, subscriptionId }
) {
  if (!paymentIntentId) {
    throw stripeLookupError(
      "top_up_payment_intent_missing",
      "Basic credit purchase is missing its PaymentIntent"
    );
  }
  return stripe.paymentIntents.update(
    paymentIntentId,
    {
      metadata: {
        moesif_credit_status: "applied",
        moesif_company_id: String(companyId),
        moesif_subscription_id: String(subscriptionId),
      },
    },
    { idempotencyKey: `basic-top-up-reconciled-${paymentIntentId}` }
  );
}

async function prepareStripePlanChange(email, planId, authUser) {
  const { customer, subscription, product } =
    await getActiveStripeSubscription(
      email,
      authUser?.sub,
      authUser?.stripe_customer_id
    );
  if (["past_due", "unpaid", "incomplete"].includes(subscription.status)) {
    const error = new Error(
      "Resolve the outstanding subscription payment before changing plans"
    );
    error.code = "outstanding_payment";
    throw error;
  }
  const openInvoices = await stripe.invoices.list({
    customer: customer.id,
    subscription: subscription.id,
    status: "open",
    limit: 1,
  });
  if (openInvoices.data.some((invoice) => invoice.amount_remaining > 0)) {
    const error = new Error(
      "Resolve the outstanding invoice before changing plans"
    );
    error.code = "outstanding_payment";
    throw error;
  }
  await getPlanPrices(planId);
  const currentProductId =
    typeof product === "string" ? product : product?.id;
  const [fromPlanKey, toPlanKey] = await Promise.all([
    getPlanKeyForProduct(currentProductId),
    getPlanKeyForProduct(planId),
  ]);
  if (fromPlanKey === toPlanKey) {
    const error = new Error("You are already subscribed to this plan");
    error.code = "already_on_plan";
    throw error;
  }

  const periodEnds = subscription.items.data
    .filter((item) => item.price?.recurring?.usage_type === "metered")
    .map((item) => item.current_period_end)
    .filter((value) => Number.isFinite(value));
  if (!periodEnds.length) {
    throw new Error("Current subscription has no metered billing period");
  }

  return {
    customer,
    subscription,
    fromPlanKey,
    toPlanKey,
    targetProductId: planId,
    effectiveAt: Math.min(...periodEnds),
  };
}

async function activateStripePlanChange(planChange) {
  const subscription = await stripe.subscriptions.retrieve(
    planChange.stripe_subscription_id,
    { expand: ["items.data.price.product", "latest_invoice.payment_intent"] }
  );
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
  if (customerId !== planChange.stripe_customer_id) {
    throw new Error("Plan change subscription does not belong to its customer");
  }

  const { commitmentPrices, meteredPrices } = await getPlanPrices(
    planChange.target_product_id
  );
  const targetPrices = [...commitmentPrices, ...meteredPrices];
  const items = [
    ...subscription.items.data.map((item) => ({ id: item.id, deleted: true })),
    ...targetPrices.map((price) => ({ price: price.id })),
  ];
  const updated = await stripe.subscriptions.update(
    subscription.id,
    {
      items,
      billing_cycle_anchor: "unchanged",
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      metadata: {
        ...subscription.metadata,
        plan_id: planChange.target_product_id,
        plan_change_request_id: planChange.request_id,
      },
      expand: ["items.data.price.product", "latest_invoice.payment_intent"],
    },
    { idempotencyKey: `plan-change-${planChange.request_id}` }
  );
  return {
    subscription: updated,
    commitmentRequired: commitmentPrices.length > 0,
    invoice:
      typeof updated.latest_invoice === "object" ? updated.latest_invoice : null,
    paymentPending: Boolean(updated.pending_update),
  };
}

function getStripeSubscription(subscriptionId) {
  return stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price.product", "latest_invoice.payment_intent"],
  });
}

async function listStripeInvoices(subscriptionId, limit = 10) {
  const invoices = await stripe.invoices.list({
    subscription: subscriptionId,
    limit,
  });
  return invoices.data;
}

async function attachPlanMeteredPrices(checkoutSession) {
  if (checkoutSession.metadata?.attach_metered_prices !== "true") return;

  const planId = checkoutSession.metadata?.plan_id;
  const subscriptionId = checkoutSession.subscription?.id;
  if (!planId || !subscriptionId) {
    throw new Error("Checkout session is missing its plan or subscription ID");
  }

  return ensureSubscriptionMeteredPrices(
    subscriptionId,
    planId,
    `checkout-${checkoutSession.id}`
  );
}

async function ensureSubscriptionMeteredPrices(
  subscriptionId,
  planId,
  idempotencyNamespace = "subscription-reconcile"
) {
  const [prices, subscription] = await Promise.all([
    stripe.prices.list({ product: planId, active: true, limit: 100 }),
    stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price"],
    }),
  ]);
  const existingPriceIds = new Set(
    subscription.items.data.map((item) => item.price.id)
  );
  const meteredPrices = prices.data.filter(
    (price) => price.recurring?.usage_type === "metered"
  );

  if (!meteredPrices.length) {
    throw new Error(`No active metered prices found for plan ${planId}`);
  }

  for (const price of meteredPrices) {
    if (existingPriceIds.has(price.id)) continue;
    await stripe.subscriptionItems.create(
      {
        subscription: subscriptionId,
        price: price.id,
        proration_behavior: "none",
      },
      { idempotencyKey: `${idempotencyNamespace}-${subscriptionId}-${price.id}` }
    );
  }
  return stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price.product", "latest_invoice"],
  });
}

async function updateStripeCustomerIdentity(
  customerId,
  { moesifUserId, moesifCompanyId, auth0UserId, subscriptionId }
) {
  const metadata = {
    moesif_user_id: String(moesifUserId),
    moesif_company_id: String(moesifCompanyId),
    sn_user_id: String(moesifUserId),
    sn_organization_id: String(moesifCompanyId),
    authUserId: auth0UserId,
    current_subscription_id: subscriptionId || "",
    entitlement_sync_version: "1",
  };

  const existingCustomer = await stripe.customers.retrieve(customerId);
  const customerNeedsUpdate = Object.entries(metadata).some(
    ([key, value]) => existingCustomer.metadata?.[key] !== value
  );
  const customer = customerNeedsUpdate
    ? await stripe.customers.update(customerId, { metadata })
    : existingCustomer;

  // The subscription webhook fires before provisioning writes the customer
  // metadata, so Moesif can process the subscription without a company
  // mapping. Touching the subscription metadata afterwards emits
  // customer.subscription.updated, making Moesif reprocess it with the
  // mapping in place.
  if (subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const subscriptionNeedsUpdate = Object.entries(metadata).some(
      ([key, value]) => subscription.metadata?.[key] !== value
    );
    if (subscriptionNeedsUpdate) {
      await stripe.subscriptions.update(subscriptionId, { metadata });
    }
  }

  return customer;
}

async function cancelStripeSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  return stripe.subscriptions.cancel(subscriptionId);
}

async function hasActiveStripeSubscription(email, authUser, preferredCustomerId) {
  try {
    await getActiveStripeSubscription(
      email,
      authUser?.sub,
      preferredCustomerId || authUser?.stripe_customer_id
    );
    return true;
  } catch (error) {
    if (error.code === "no_active_subscription") return false;
    throw error;
  }
}

// Prepaid commitment / dev-credit amounts per tier, in minor units (pence).
// Commitments are annual, so their credit expires after a year and is
// re-granted on renewal. The dev credit does not expire.
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const CREDIT_GRANTS = {
  basic: {
    value: 50000,
    category: "promotional",
    name: "Development credit",
    expiresInSeconds: null,
  },
  growth: {
    value: 500000,
    category: "paid",
    name: "Growth prepaid commitment",
    expiresInSeconds: YEAR_SECONDS,
  },
  enterprise: {
    value: 1200000,
    category: "paid",
    name: "Enterprise prepaid commitment",
    expiresInSeconds: YEAR_SECONDS,
  },
};

// Create the tier's credit grant once. Idempotent: skips if a grant with the
// same marker already exists for the customer.
// Low-level: create a credit grant once, idempotent by marker.
async function createCreditGrantOnce(customerId, opts) {
  const {
    value,
    currency = "gbp",
    category = "paid",
    name,
    marker,
    planKey,
    expiresAt = null,
  } = opts;
  if (!customerId || !value) return null;

  const existing = await stripe.billing.creditGrants.list({
    customer: customerId,
    limit: 100,
  });
  if (existing.data.some((g) => g.metadata && g.metadata.oo_marker === marker)) {
    return null;
  }

  const params = {
    name,
    customer: customerId,
    amount: {
      type: "monetary",
      monetary: { currency: currency.toLowerCase(), value },
    },
    applicability_config: { scope: { price_type: "metered" } },
    category,
    metadata: { oo_marker: marker, plan_key: String(planKey || "") },
  };
  if (expiresAt) params.expires_at = expiresAt;
  return stripe.billing.creditGrants.create(params, {
    idempotencyKey: `credit-grant-${marker}`,
  });
}

// Basic development credit at checkout (fixed amount from config).
async function ensureCreditGrant(customerId, planKey, { currency = "gbp", marker } = {}) {
  const config = CREDIT_GRANTS[String(planKey || "").toLowerCase()];
  if (!config) return null;
  return createCreditGrantOnce(customerId, {
    value: config.value,
    currency,
    category: config.category,
    name: config.name,
    marker: marker || `oo_${planKey}_grant`,
    planKey,
    expiresAt: config.expiresInSeconds
      ? Math.floor(Date.now() / 1000) + config.expiresInSeconds
      : null,
  });
}

// Aggregate current-period spend + credit balance for the usage dashboard.
async function computeUsageSummary(email, authUser) {
  const { customer, subscription } = await getActiveStripeSubscription(
    email,
    authUser?.sub,
    authUser?.stripe_customer_id
  );

  // Run the three independent Stripe reads in parallel for speed.
  const [preview, grants, balance] = await Promise.all([
    stripe.invoices
      .createPreview({ customer: customer.id, subscription: subscription.id })
      .catch((e) => {
        console.error("Invoice preview failed:", e.message);
        return null;
      }),
    stripe.billing.creditGrants
      .list({ customer: customer.id, limit: 100 })
      .catch(() => ({ data: [] })),
    stripe.billing.creditBalanceSummary
      .retrieve({
        customer: customer.id,
        filter: {
          type: "applicability_scope",
          applicability_scope: { price_type: "metered" },
        },
      })
      .catch(() => null),
  ]);

  const currency = (
    preview?.currency ||
    subscription.items?.data?.[0]?.price?.currency ||
    "gbp"
  ).toUpperCase();

  const lines = buildStripeUsageLines(subscription, preview);

  // Gross usage accrued so far this period (same total as the breakdown).
  const grossUsage = lines.reduce(
    (sum, l) => sum + (l.amount > 0 ? l.amount : 0),
    0
  );

  const granted = (grants.data || []).reduce(
    (sum, g) => sum + (g.amount?.monetary?.value || 0),
    0
  );
  let credit = null;
  if (granted > 0) {
    // Authoritative balance from Stripe's ledger (only decrements at invoice
    // finalisation). We also project this period's accrued usage against it.
    const ledgerAvailable = (balance?.balances || []).reduce(
      (sum, b) => sum + (b.available_balance?.monetary?.value || 0),
      0
    );
    credit = {
      granted,
      remaining: ledgerAvailable,
      used: Math.max(0, granted - ledgerAvailable),
      projectedRemaining: Math.max(0, ledgerAvailable - grossUsage),
    };
  } else {
    // Stripe has not finalised a ledger grant yet. Fall back to the commitment
    // amount on the plan's commitment price so the card still shows how much of
    // the subscription is left, drawn down by this period's accrued usage.
    const commitmentItem = subscription.items?.data?.find((item) =>
      isCommitmentPrice(item.price)
    );
    const commitmentMajor = Number(
      commitmentItem?.price?.metadata?.commitment_amount
    );
    const commitmentPence = Number.isFinite(commitmentMajor)
      ? Math.round(commitmentMajor * 100)
      : 0;
    if (commitmentPence > 0) {
      credit = {
        granted: commitmentPence,
        remaining: Math.max(0, commitmentPence - grossUsage),
        used: grossUsage,
        projectedRemaining: Math.max(0, commitmentPence - grossUsage),
      };
    }
  }

  // "Usage this period" tracks metered consumption, which bills monthly - so
  // read the window from a metered item. The first subscription item can be the
  // annual commitment price, whose year-long period is misleading here.
  const periodItem =
    subscription.items?.data?.find(
      (item) => item.price?.recurring?.usage_type === "metered"
    ) || subscription.items?.data?.[0];
  const summary = {
    hasSubscription: true,
    currency,
    period: {
      start:
        periodItem?.current_period_start ??
        subscription.current_period_start ??
        null,
      end:
        periodItem?.current_period_end ??
        subscription.current_period_end ??
        null,
    },
    accrued: grossUsage,
    lines,
    credit,
  };
  return summary;
}

// Coalesced background refresh: only one fetch per cache key is ever in flight.
function refreshUsageSummary(cacheKey, email, authUser) {
  if (cacheKey && usageSummaryInflight.has(cacheKey)) {
    return usageSummaryInflight.get(cacheKey);
  }
  const promise = computeUsageSummary(email, authUser)
    .then((summary) => {
      cacheUsageSummary(cacheKey, summary);
      return summary;
    })
    .finally(() => {
      if (cacheKey) usageSummaryInflight.delete(cacheKey);
    });
  if (cacheKey) usageSummaryInflight.set(cacheKey, promise);
  return promise;
}

// Stale-while-revalidate: never block the caller when we have a usable cached
// value. A cold miss (or a value older than STALE_MAX) blocks on a fresh fetch.
async function getUsageSummary(email, authUser) {
  const cacheKey = authUser?.sub || email?.toLowerCase();
  const cached = cacheKey ? usageSummaryCache.get(cacheKey) : null;
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;

  if (cached && age < USAGE_SUMMARY_FRESH_TTL_MS) {
    return cached.summary;
  }
  if (cached && age < USAGE_SUMMARY_STALE_TTL_MS) {
    // Serve the stale value immediately; refresh in the background. Errors are
    // swallowed so a transient upstream failure keeps serving the last good copy.
    refreshUsageSummary(cacheKey, email, authUser).catch((error) =>
      console.error("Usage summary background refresh failed:", error.message)
    );
    return cached.summary;
  }
  return refreshUsageSummary(cacheKey, email, authUser);
}

function constructStripeEvent(rawBody, signature, secret) {
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

// When a commitment invoice is paid, grant (or annually re-grant) that tier's
// prepaid credit. Idempotent per invoice via the marker.
async function grantCommitmentFromInvoice(invoice) {
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (!customerId) return;

  for (const line of invoice.lines?.data || []) {
    const priceId = line.price?.id || line.pricing?.price_details?.price;
    if (!priceId) continue;
    let price;
    try {
      price = await stripe.prices.retrieve(priceId);
    } catch (err) {
      continue;
    }

    const md = price?.metadata || {};
    const amountMajor = Number(md.commitment_amount);
    if (!isCommitmentPrice(price) || !amountMajor || Number.isNaN(amountMajor)) {
      continue;
    }

    // commitment_amount is in major units (e.g. 5000 = £5,000).
    const period = String(md.commitment_period || "").toLowerCase();
    let expiresAt = null;
    if (period === "annual" || period === "yearly") {
      expiresAt = Math.floor(Date.now() / 1000) + YEAR_SECONDS;
    } else if (period === "monthly") {
      expiresAt = Math.floor(Date.now() / 1000) + 31 * 24 * 60 * 60;
    }

    await createCreditGrantOnce(customerId, {
      value: Math.round(amountMajor * 100),
      currency: md.commitment_currency || invoice.currency || "gbp",
      category: "paid",
      name: `${md.plan_key || "Plan"} prepaid commitment`,
      marker: `oo_commitment_${invoice.id}`,
      planKey: md.plan_key,
      expiresAt,
    });
  }
}

module.exports = {
  verifyStripeSession,
  constructStripeEvent,
  grantCommitmentFromInvoice,
  ensureCreditGrant,
  getUsageSummary,
  cancelStripeSubscription,
  hasActiveStripeSubscription,
  createStripePlanCheckoutSession,
  createBasicCreditCheckoutSession,
  getBasicTopUpTotalPence,
  markBasicTopUpReconciled,
  prepareStripePlanChange,
  activateStripePlanChange,
  getStripeSubscription,
  listStripeInvoices,
  attachPlanMeteredPrices,
  updateStripeCustomerIdentity,
  getStripeCustomerById,
  isMissingStripeCustomer,
  listStripeSubscriptions,
  getActiveStripeSubscription,
  getPlanKeyForProduct,
  getStripeProduct,
  getPlanPrices,
  ensureSubscriptionMeteredPrices,
  buildStripeUsageLines,
  subscriptionProductIds,
  getSubscriptionPlanKey,
  assertBasicTopUpAllowed,
  resolveStripeCustomer,
  LIVE_SUBSCRIPTION_STATUSES,
};
