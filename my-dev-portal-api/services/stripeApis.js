const StripeSDK = require("stripe");
const stripe = StripeSDK(process.env.STRIPE_API_KEY);

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
    expand: ["customer", "subscription", "line_items.data.price.product"],
  });
}

async function getActiveStripeSubscription(email, authUserId) {
  const customers = await stripe.customers.search({
    query: `email:"${email.replace(/"/g, "\\\"")}"`,
    limit: 10,
  });
  const customer =
    customers.data.find(
      (candidate) => candidate.metadata?.authUserId === authUserId
    ) || customers.data[0];
  if (!customer) throw new Error("Stripe customer not found");

  const subscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: "all",
    limit: 10,
  });
  const subscription = subscriptions.data.find((candidate) =>
    ["active", "trialing", "past_due"].includes(candidate.status)
  );
  if (!subscription) throw new Error("Active Stripe subscription not found");

  const price = subscription.items.data[0]?.price;
  if (!price) throw new Error("Stripe subscription price not found");

  const product =
    typeof price.product === "string"
      ? await stripe.products.retrieve(price.product)
      : price.product;

  return { customer, subscription, price, product };
}

function getStripeCustomer(email) {
  return fetch(
    `https://api.stripe.com/v1/customers/search?query=email:"${encodeURIComponent(
      email
    )}"`,
    {
      headers: {
        Authorization: `bearer ${process.env.STRIPE_API_KEY}`,
      },
    }
  ).then((res) => res.json());
}

// Developers: you might consider have something like reddis
// make id/mapping look up easier and faster
const EMAIL_TO_STRIPE_CUSTOMER_CACHE = {};

function getStripeCustomerIdFromCache(email) {
  return EMAIL_TO_STRIPE_CUSTOMER_CACHE[email];
}

async function getStripeCustomerId(email) {
  if (EMAIL_TO_STRIPE_CUSTOMER_CACHE[email]) {
    return EMAIL_TO_STRIPE_CUSTOMER_CACHE[email];
  }

  const stripeCustomer = await getStripeCustomer(email);
  const stripeCustomerId =
    stripeCustomer.data && stripeCustomer.data[0]
      ? stripeCustomer.data[0].id
      : undefined;

  if (stripeCustomerId) {
    EMAIL_TO_STRIPE_CUSTOMER_CACHE[email] = stripeCustomerId;
  }

  return stripeCustomerId;
}

async function getOrCreateStripeCustomerId(email, authUser) {
  // make sure only one stripe customer per email
  let customerId = await getStripeCustomerId(email);

  if (!customerId) {
    // If no customerId exists, create a new one
    const customer = await stripe.customers.create({
      email: email,
      metadata: {
        // add the user id from identify provider to
        // stripe metadata for customer.
        // Because, an alternative approach is to tie
        // the identity provider's user id to stripe customer
        // and look up customer object using user_id instead of
        // email.
        authUserId: authUser?.sub,
      },
    });

    customerId = customer.id;
  }

  return customerId;
}

async function createStripeCheckoutSession(email, priceId, quantity, authUser) {
  const customerId = await getOrCreateStripeCustomerId(email, authUser);

  const session = await stripe.checkout.sessions.create({
    ui_mode: "embedded",
    line_items: [
      {
        // Provide the exact Price ID (for example, pr_1234) of the product you want to sell
        price: priceId,
        // for metered billing, do NOT include quantity
        quantity: quantity ? parseInt(quantity) || 1 : undefined,
      },
    ],
    customer: customerId,
    mode: "subscription",
    return_url: `http://${process.env.FRONT_END_DOMAIN}/return?session_id={CHECKOUT_SESSION_ID}&price_id=${priceId}`,
  });

  return session;
}

async function createStripePlanCheckoutSession(email, planId, authUser) {
  const customerId = await getOrCreateStripeCustomerId(email, authUser);

  // A plan (Stripe product) can carry several usage prices - one per
  // billing meter - so the subscription must include every active price.
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

  const session = await stripe.checkout.sessions.create({
    ui_mode: "embedded",
    line_items: lineItems,
    customer: customerId,
    mode: "subscription",
    metadata: {
      plan_id: planId,
      attach_metered_prices: commitmentPrices.length ? "true" : "false",
    },
    subscription_data: {
      billing_mode: { type: "flexible" },
      metadata: { plan_id: planId },
    },
    return_url: `http://${process.env.FRONT_END_DOMAIN}/return?session_id={CHECKOUT_SESSION_ID}&plan_id=${planId}`,
  });

  return session;
}

async function attachPlanMeteredPrices(checkoutSession) {
  if (checkoutSession.metadata?.attach_metered_prices !== "true") return;

  const planId = checkoutSession.metadata?.plan_id;
  const subscriptionId = checkoutSession.subscription?.id;
  if (!planId || !subscriptionId) {
    throw new Error("Checkout session is missing its plan or subscription ID");
  }

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
      { idempotencyKey: `portal-${checkoutSession.id}-${price.id}` }
    );
  }
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
  };

  const customer = await stripe.customers.update(customerId, { metadata });

  // The subscription webhook fires before provisioning writes the customer
  // metadata, so Moesif can process the subscription without a company
  // mapping. Touching the subscription metadata afterwards emits
  // customer.subscription.updated, making Moesif reprocess it with the
  // mapping in place.
  if (subscriptionId) {
    await stripe.subscriptions.update(subscriptionId, { metadata });
  }

  return customer;
}

async function cancelStripeSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  return stripe.subscriptions.cancel(subscriptionId);
}

async function hasActiveStripeSubscription(email, authUser) {
  try {
    await getActiveStripeSubscription(email, authUser?.sub);
    return true;
  } catch (error) {
    return false;
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
  return stripe.billing.creditGrants.create(params);
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
async function getUsageSummary(email, authUser) {
  const { customer, subscription } = await getActiveStripeSubscription(
    email,
    authUser?.sub
  );

  // Map each subscription price to its human nickname (e.g. "Growth - API
  // Call") so the breakdown is readable rather than Stripe's raw description.
  const priceNames = {};
  const commitmentPriceIds = new Set();
  for (const item of subscription.items?.data || []) {
    if (item.price?.id) priceNames[item.price.id] = item.price.nickname || null;
    if (item.price?.id && isCommitmentPrice(item.price)) {
      commitmentPriceIds.add(item.price.id);
    }
  }

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

  const lines = (preview?.lines?.data || [])
    .filter((line) => {
      const priceId =
        line.price?.id || line.pricing?.price_details?.price || null;
      // Commitment charges are not usage metrics; keep them out of the breakdown.
      if (priceId && commitmentPriceIds.has(priceId)) return false;
      return line.amount !== 0 || line.quantity;
    })
    .map((line) => {
      const priceId =
        line.price?.id || line.pricing?.price_details?.price || null;
      const nickname = priceId ? priceNames[priceId] : null;
      return {
        label: nickname || line.description || "Usage",
        quantity: line.quantity ?? null,
        amount: line.amount ?? 0,
      };
    });

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
  }

  // Billing period moved from the subscription to its items in recent Stripe
  // API versions; read from the item with a fallback to the subscription.
  const firstItem = subscription.items?.data?.[0];
  return {
    hasSubscription: true,
    currency,
    period: {
      start:
        firstItem?.current_period_start ??
        subscription.current_period_start ??
        null,
      end:
        firstItem?.current_period_end ??
        subscription.current_period_end ??
        null,
    },
    accrued: grossUsage,
    lines,
    credit,
  };
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
  createStripeCheckoutSession,
  createStripePlanCheckoutSession,
  attachPlanMeteredPrices,
  updateStripeCustomerIdentity,
  getStripeCustomer,
  getStripeCustomerId,
  getStripeCustomerIdFromCache,
  getActiveStripeSubscription,
};
