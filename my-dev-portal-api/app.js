const express = require("express");
const crypto = require("crypto");
require("dotenv").config();
const moesif = require("moesif-nodejs");
const cors = require("cors");

const {
  verifyStripeSession,
  getActiveStripeSubscription,
  cancelStripeSubscription,
  ensureCreditGrant,
  getUsageSummary,
  constructStripeEvent,
  grantCommitmentFromInvoice,
  getStripeCustomerById,
  listStripeSubscriptions,
  createStripePlanCheckoutSession,
  createBasicCreditCheckoutSession,
  getBasicTopUpTotalPence,
  markBasicTopUpReconciled,
  prepareStripePlanChange,
  activateStripePlanChange,
  getStripeSubscription,
  listStripeInvoices,
  ensureSubscriptionMeteredPrices,
  getPlanKeyForProduct,
  getStripeProduct,
  getPlanPrices,
  LIVE_SUBSCRIPTION_STATUSES,
  updateStripeCustomerIdentity,
} = require("./services/stripeApis");
const {
  handleSubscriptionEnded,
} = require("./services/subscriptionEnforcement");
const {
  provisionSnApiCustomer,
  provisionSnApiPrepaidCustomer,
  checkSnApiEmailAvailability,
  getSnApiPortalContext,
  listSnApiKeys,
  createSnApiKey,
  revokeSnApiKey,
  rotateSnApiKey,
  createSnApiPlanChange,
  getSnApiCurrentPlanChange,
  getSnApiPlanChangeByCustomer,
  listSnApiDuePlanChanges,
  updateSnApiPlanChange,
  updateSnApiSubscriptionStatus,
} = require("./services/snApiProvisioning");
const {
  processPaidInvoice,
  processFailedInvoice,
  reconcileDuePlanChanges,
} = require("./services/planChangeService");
const {
  reconcileActiveSubscription,
  reconcileCheckoutSession,
  resolveAuthenticatedEntitlement,
  processSubscriptionLifecycle,
} = require("./services/subscriptionReconciliation");
const {
  syncToMoesif,
  getInfoForEmbeddedWorkspaces,
  getPlansFromMoesif,
  sendPrepaidSubscriptionToMoesif,
  createMoesifBalanceTransaction,
  getMoesifEventCount,
  getMoesifBillingReports,
  getMoesifPrepaidBalance,
} = require("./services/moesifApis");
const {
  reconcileBasicCreditPurchase,
} = require("./services/prepaidReconciliation");
const {
  assertBasicPurchaseAllowed,
  isBasicCreditSession,
} = require("./services/basicPurchasePolicy");
const {
  getBasicPrepaidUsageSummary,
  invalidateBasicUsageSummary,
} = require("./services/basicUsageSummary");

const { authMiddleware } = require("./services/authPlugin");

const { getUnifiedCustomerIdCached } = require("./services/commonUtils");

const app = express();
app.disable("x-powered-by");
const port = 3030;

// Keep the load-balancer health check independent of Moesif, Stripe, Auth0,
// and the Spend Network API. Dependency failures should not make ECS replace
// an otherwise healthy portal API task.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

const templateWorkspaceIdLiveEvent =
  process.env.MOESIF_TEMPLATE_WORKSPACE_ID_LIVE_EVENT_LOG;
const templateWorkspaceIdTimeSeries =
  process.env.MOESIF_TEMPLATE_WORKSPACE_ID_TIME_SERIES;

const jsonParser = express.json({ limit: "100kb" });

function validateConfiguration() {
  const required = [
    "AUTH0_DOMAIN",
    "AUTH0_CLIENT_ID",
    "FRONT_END_DOMAIN",
    "MOESIF_APPLICATION_ID",
    "MOESIF_MANAGEMENT_TOKEN",
    "MOESIF_TEMPLATE_WORKSPACE_ID_LIVE_EVENT_LOG",
    "MOESIF_TEMPLATE_WORKSPACE_ID_TIME_SERIES",
    "PORTAL_STRIPE_WEBHOOK_SECRET",
    "SN_API_BASE_URL",
    "SN_API_PROVISIONING_TOKEN",
    "STRIPE_API_KEY",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
  if (
    process.env.APP_PAYMENT_PROVIDER &&
    process.env.APP_PAYMENT_PROVIDER.toLowerCase() !== "stripe"
  ) {
    throw new Error("APP_PAYMENT_PROVIDER must be stripe");
  }
}

validateConfiguration();

const planChangeDeps = {
  activateStripePlanChange,
  getStripeCustomerById,
  getStripeSubscription,
  getSnApiPlanChangeByCustomer,
  listSnApiDuePlanChanges,
  listStripeInvoices,
  updateSnApiPlanChange,
  grantCommitmentFromInvoice,
  provisionSnApiCustomer,
  updateStripeCustomerIdentity,
};

const subscriptionReconciliationDeps = {
  verifyStripeSession,
  getActiveStripeSubscription,
  getStripeSubscription,
  getStripeCustomerById,
  getStripeProduct,
  getPlanKeyForProduct,
  ensureSubscriptionMeteredPrices,
  provisionSnApiCustomer,
  updateStripeCustomerIdentity,
  ensureCreditGrant,
  grantCommitmentFromInvoice,
  syncToMoesif,
  liveStatuses: LIVE_SUBSCRIPTION_STATUSES,
  updateSnApiSubscriptionStatus,
  handleSubscriptionEnded,
  listStripeSubscriptions,
};

const prepaidReconciliationDeps = {
  verifyStripeSession,
  getStripeCustomerById,
  getStripeProduct,
  getPlanKeyForProduct,
  getPlanPrices,
  getSnApiPortalContext,
  provisionSnApiPrepaidCustomer,
  updateStripeCustomerIdentity,
  syncToMoesif,
  sendPrepaidSubscriptionToMoesif,
  createMoesifBalanceTransaction,
  markBasicTopUpReconciled,
};

const moesifMiddleware = moesif({
  applicationId: process.env.MOESIF_APPLICATION_ID,

  identifyUser: function (req, _res) {
    return getUnifiedCustomerIdCached(req?.user);
  },
  identifyCompany: function (req, _res) {
    return req?.user?.moesif_company_id;
  },
});

function getFrontendOrigin() {
  const configured = process.env.FRONT_END_DOMAIN.trim().replace(/\/$/, "");
  const url = /^https?:\/\//i.test(configured)
    ? configured
    : `${configured.startsWith("localhost") || configured.startsWith("127.0.0.1") ? "http" : "https"}://${configured}`;
  return new URL(url).origin;
}

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(
  moesifMiddleware,
  cors({
    origin: getFrontendOrigin(),
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Stripe-Signature"],
    maxAge: 600,
  })
);

const PORTAL_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const portalContextCache = new Map();

function applyPortalContext(req, context) {
  req.portalContext = context;
  req.user.moesif_user_id = context.moesif_user_id;
  req.user.moesif_company_id = context.moesif_company_id;
  req.user.sn_api_user_id = context.user_id;
  req.user.sn_api_organization_id = context.organization_id;
  req.user.stripe_customer_id = context.stripe_customer_id;
}

function invalidatePortalContext(auth0UserId) {
  if (auth0UserId) {
    portalContextCache.delete(auth0UserId);
  }
}

async function attachSnApiPortalContext(req, _res, next) {
  const auth0UserId = req.user?.sub;
  const cached = auth0UserId ? portalContextCache.get(auth0UserId) : undefined;

  if (cached && Date.now() - cached.fetchedAt < PORTAL_CONTEXT_CACHE_TTL_MS) {
    applyPortalContext(req, cached.context);
    return next();
  }

  try {
    const context = await getSnApiPortalContext(req.user);
    portalContextCache.set(auth0UserId, { context, fetchedAt: Date.now() });
    applyPortalContext(req, context);
  } catch (error) {
    if (error.status === 404) {
      // Authentication can happen before checkout has provisioned the
      // API account. Not cached so the context appears promptly once
      // provisioning completes.
      invalidatePortalContext(auth0UserId);
    } else {
      console.error("Failed to resolve SN API portal context:", error);
      if (cached) {
        // SN API is unavailable; serve the stale context rather than
        // emitting anonymous Moesif events.
        applyPortalContext(req, cached.context);
      }
    }
  }
  next();
}

const portalAuthMiddleware = [authMiddleware, attachSnApiPortalContext];

async function ensureRequestEntitlement(req) {
  if (req.entitlement) return req.entitlement;
  const entitlement = await resolveAuthenticatedEntitlement(
    req.user,
    req.portalContext,
    subscriptionReconciliationDeps
  );
  req.entitlement = entitlement;
  if (entitlement.reconciled) {
    invalidatePortalContext(req.user?.sub);
    try {
      const refreshedContext = await getSnApiPortalContext(req.user);
      portalContextCache.set(req.user.sub, {
        context: refreshedContext,
        fetchedAt: Date.now(),
      });
      applyPortalContext(req, refreshedContext);
    } catch (error) {
      console.error("Entitlement reconciled but context refresh failed", error);
    }
  }
  return entitlement;
}

// API keys grant API access, so they may only be created or rotated while the
// customer has a live subscription. Checked against Stripe directly so a
// cancellation takes effect immediately, not after Moesif sync.
async function requireActiveSubscription(req, res, next) {
  try {
    const entitlement = await ensureRequestEntitlement(req);
    if (!entitlement.active) {
      return res.status(403).json({
        code: "no_active_subscription",
        message: "An active subscription is required to manage API keys.",
      });
    }
  } catch (error) {
    console.error("Subscription check failed:", error);
    const conflict = [
      "multiple_active_subscriptions",
      "multiple_stripe_customers",
      "ambiguous_stripe_customer",
    ].includes(error.code);
    return res.status(conflict ? 409 : 503).json({
      code: error.code || "subscription_verification_failed",
      message: conflict
        ? "Your billing account needs support review before API keys can be managed."
        : "We could not verify your subscription. Please try again.",
    });
  }
  return next();
}

app.post(
  "/create-stripe-checkout-session",
  portalAuthMiddleware,
  async (req, res) => {
    const planId = req.query?.plan_id;
    const email = req.user?.email;
    const suppliedRequestId = req.query?.request_id;
    const requestId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(suppliedRequestId || "")
      ? suppliedRequestId
      : crypto.randomUUID();
    const topUpAmountGbp = req.query?.amount_gbp;
    const purchaseType = req.query?.purchase_type;

    console.log(
      `Checkout requested by ${req.user?.sub || "unknown"} for plan ${planId || "missing"}`
    );

    if (!planId) {
      return res.status(400).json({
        code: "plan_required",
        message: "plan_id is required",
      });
    }

    // Block checkout before payment if the email already belongs to a
    // different Auth0 identity, so the customer never pays into a conflict.
    try {
      const availability = await checkSnApiEmailAvailability(req.user);
      if (availability && availability.conflict) {
        return res.status(409).json({
          code: "email_identity_conflict",
          message:
            "This email is already registered with a different sign-in method. Please log in using your original method.",
        });
      }
    } catch (availabilityError) {
      console.error("Email availability check failed:", availabilityError);
      return res.status(503).json({
        code: "provisioning_dependency_unavailable",
        message:
          "We could not verify that your API account can be provisioned. Please try again shortly.",
      });
    }

    try {
      const selectedPlanKey = await getPlanKeyForProduct(planId);

      if (selectedPlanKey === "basic") {
        const entitlement = await ensureRequestEntitlement(req);
        assertBasicPurchaseAllowed(purchaseType, entitlement);
      }

      if (selectedPlanKey !== "basic") {
        try {
          const prepared = await prepareStripePlanChange(
            email,
            planId,
            req.user
          );
          const scheduled = await createSnApiPlanChange(req.user, {
            request_id: requestId || crypto.randomUUID(),
            stripe_customer_id: prepared.customer.id,
            stripe_subscription_id: prepared.subscription.id,
            from_plan_key: prepared.fromPlanKey,
            to_plan_key: prepared.toPlanKey,
            target_product_id: prepared.targetProductId,
            effective_at: new Date(prepared.effectiveAt * 1000).toISOString(),
            metadata: { source: "developer_portal" },
          });
          return res.status(200).json({
            scheduled: true,
            planChange: scheduled,
          });
        } catch (planChangeError) {
          // "No subscription to change" and "no Stripe customer yet" both mean
          // this is a first-time purchase, not a plan change. Fall through to a
          // fresh checkout, which creates the customer. Any other error is real.
          const isFirstTimePurchase =
            planChangeError.code === "no_active_subscription" ||
            planChangeError.code === "stripe_customer_not_found";
          if (!isFirstTimePurchase) {
            throw planChangeError;
          }
        }
      }

      const session = selectedPlanKey === "basic"
        ? await createBasicCreditCheckoutSession(
            email,
            planId,
            topUpAmountGbp,
            purchaseType,
            req.user,
            requestId
          )
        : await createStripePlanCheckoutSession(
            email,
            planId,
            req.user,
            requestId
          );
      console.log(`Stripe Checkout session ${session.id} created`);

      res.send({ clientSecret: session.client_secret });
    } catch (err) {
      console.error("Failed to create stripe checkout session", err);
      const status =
        err.code === "multiple_active_subscriptions" ||
        err.code === "active_subscription_exists" ||
        err.code === "basic_already_active" ||
        err.code === "basic_plan_conflict" ||
        err.code === "basic_plan_required"
          ? 409
          : 400;
      res.status(status).json({
        code: err.code || "checkout_failed",
        message:
          err.code === "multiple_active_subscriptions"
            ? "Multiple active subscriptions were found. Please contact support before changing plans."
            : err.code === "active_subscription_exists"
              ? err.message
            : err.message || "Error creating checkout session",
      });
    }
  }
);

// The plan catalogue rarely changes, and Moesif's catalogue API can be slow
// or intermittently fail. Cache it briefly and serve the last good copy on
// error so the plans page loads fast and does not flash an error.
let plansCache = { data: null, at: 0 };
const PLANS_CACHE_TTL_MS = 5 * 60 * 1000;

// Stripe webhook (separate from the SN API subscription-status webhook). Two
// jobs:
//   - invoice.paid       -> grant/re-grant prepaid commitment credit
//   - subscription ended -> revoke that customer's API keys
//
// Required Stripe events: checkout.session.completed/async_payment_succeeded,
// invoice.paid/payment_succeeded/payment_failed, and
// customer.subscription.created/updated/deleted/paused/resumed.
// Checkout and lifecycle events are both handled because Stripe does not
// guarantee event delivery order and the browser return is not reliable.
const SUBSCRIPTION_LIFECYCLE_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "customer.subscription.paused",
  "customer.subscription.resumed",
];

app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const secret = process.env.PORTAL_STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      // Loud, because silence here means cancellations are not being enforced.
      console.error(
        "Stripe webhook received but PORTAL_STRIPE_WEBHOOK_SECRET is not set; " +
          "subscription cancellations will NOT revoke API keys"
      );
      return res.status(503).json({ message: "Webhook not configured" });
    }
    let event;
    try {
      event = constructStripeEvent(
        req.body,
        req.headers["stripe-signature"],
        secret
      );
    } catch (err) {
      console.error("Stripe webhook signature verification failed", err.message);
      return res.status(400).json({ message: "Invalid signature" });
    }

    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      try {
        if (isBasicCreditSession(event.data.object)) {
          await reconcileBasicCreditPurchase(
            event.data.object,
            null,
            prepaidReconciliationDeps
          );
          invalidateBasicUsageSummary();
        } else {
          await reconcileCheckoutSession(
            event.data.object,
            null,
            subscriptionReconciliationDeps
          );
        }
      } catch (reconciliationError) {
        if (reconciliationError.code === "checkout_payment_pending") {
          return res.status(200).json({ received: true, payment_pending: true });
        }
        console.error("Checkout webhook reconciliation failed", reconciliationError);
        return res.status(500).json({ message: "Checkout reconciliation failed" });
      }
    }

    if (event.type === "invoice.paid") {
      try {
        await grantCommitmentFromInvoice(event.data.object);
        await processPaidInvoice(event.data.object, planChangeDeps);
      } catch (planChangeError) {
        console.error("Paid invoice plan-change processing failed", planChangeError);
        return res.status(500).json({ message: "Plan change processing failed" });
      }
    }

    if (event.type === "invoice.payment_failed") {
      try {
        await processFailedInvoice(event.data.object, planChangeDeps);
      } catch (planChangeError) {
        console.error("Failed invoice plan-change processing failed", planChangeError);
        return res.status(500).json({ message: "Plan change processing failed" });
      }
    }

    if (SUBSCRIPTION_LIFECYCLE_EVENTS.includes(event.type)) {
      try {
        const result = await processSubscriptionLifecycle(
          event.data.object,
          subscriptionReconciliationDeps
        );
        // Returning 500 asks Stripe to retry, which is what we want when keys
        // are still live: revocation is the whole point of this handler.
        if (result?.failed?.length) {
          return res
            .status(500)
            .json({ message: "Some API keys could not be revoked" });
        }
      } catch (enforcementError) {
        console.error(
          "Subscription enforcement failed; API keys may still be live",
          enforcementError
        );
        return res
          .status(500)
          .json({ message: "Subscription enforcement failed" });
      }
    }

    return res.status(200).json({ received: true });
  }
);

app.get("/plans", async (_req, res) => {
  if (plansCache.data && Date.now() - plansCache.at < PLANS_CACHE_TTL_MS) {
    return res.status(200).json(plansCache.data);
  }
  try {
    const result = await getPlansFromMoesif();
    plansCache = { data: result, at: Date.now() };
    return res.status(200).json(result);
  } catch (err) {
    console.error("Error getting plans from Moesif", err);
    if (plansCache.data) {
      // Serve the last good catalogue rather than failing the page.
      return res.status(200).json(plansCache.data);
    }
    return res.status(500).json({ message: "Error getting plans from Moesif" });
  }
});

function stripeSubscriptionForPortal(entitlement) {
  const subscription = entitlement.subscription;
  const meteredItems = subscription.items.data.filter(
    (item) => item.price?.recurring?.usage_type === "metered"
  );
  const periodItems = meteredItems.length ? meteredItems : subscription.items.data;
  const periodStarts = periodItems
    .map((item) => item.current_period_start)
    .filter(Number.isFinite);
  const periodEnds = periodItems
    .map((item) => item.current_period_end)
    .filter(Number.isFinite);
  return {
    subscription_id: subscription.id,
    plan_key: entitlement.planKey,
    status: subscription.status,
    current_period_start: periodStarts.length
      ? new Date(Math.min(...periodStarts) * 1000).toISOString()
      : null,
    current_period_end: periodEnds.length
      ? new Date(Math.max(...periodEnds) * 1000).toISOString()
      : null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    items: subscription.items.data.map((item) => {
      const price = item.price;
      const productId =
        typeof price.product === "string" ? price.product : price.product?.id;
      return {
        subscription_item_id: item.id,
        plan_id: productId,
        price_id: price.id,
        price: {
          id: price.id,
          name: price.nickname,
          nickname: price.nickname,
          currency: price.currency,
          price_in_decimal:
            price.unit_amount_decimal == null
              ? null
              : Number(price.unit_amount_decimal) / 100,
          pricing_model: price.billing_scheme,
        },
      };
    }),
  };
}

app.get("/subscriptions", portalAuthMiddleware, jsonParser, async (req, res) => {
  try {
    const entitlement = await ensureRequestEntitlement(req);
    if (!entitlement.active) return res.status(200).json([]);
    if (entitlement.planKey === "basic" && !entitlement.subscription) {
      const prepaid = await getMoesifPrepaidBalance({
        companyId: req.portalContext.moesif_company_id,
        stripeCustomerId: req.portalContext.stripe_customer_id,
      });
      return res.status(200).json([
        {
          ...prepaid.subscription,
          subscription_id: prepaid.subscriptionId,
          plan_key: "basic",
          status: "active",
          billing_model: "prepaid_credit",
          balance: {
            current_balance: prepaid.current,
            pending_activity: prepaid.pending,
            available_balance: prepaid.available,
          },
        },
      ]);
    }
    return res.status(200).json([stripeSubscriptionForPortal(entitlement)]);
  } catch (err) {
    console.error("Error getting authoritative Stripe subscription", err);
    return res.status(503).json({
      code: err.code || "subscription_lookup_failed",
      message: "We could not verify your current subscription.",
    });
  }
});

app.get("/usage-summary", portalAuthMiddleware, async (req, res) => {
  try {
    if (
      req.portalContext?.current_plan_key === "basic" &&
      !req.portalContext?.current_subscription_id
    ) {
      const summary = await getBasicPrepaidUsageSummary(
        {
          companyId: req.portalContext.moesif_company_id,
          stripeCustomerId: req.portalContext.stripe_customer_id,
        },
        {
          getMoesifPrepaidBalance,
          getMoesifBillingReports,
          getMoesifEventCount,
          getPlansFromMoesif,
          getBasicTopUpTotalPence,
        }
      );
      return res.status(200).json(summary);
    }
    const summary = await getUsageSummary(req.user?.email, req.user);
    return res.status(200).json(summary);
  } catch (error) {
    if (error.code === "multiple_active_subscriptions") {
      return res.status(409).json({
        code: error.code,
        message:
          "Multiple active subscriptions were found. Please contact support to correct the account.",
      });
    }
    // No active subscription yet - not an error state for this widget.
    return res.status(200).json({ hasSubscription: false });
  }
});

// This handles Provision after user success checked out from Stripe
// - syncing the Stripe ids to Moesif.
// - creates customers to API Management platform if need.
// - Please see DATA-MODEL.md see the assumptions and background on data mapping.
app.post(
  "/register/stripe/:checkout_session_id",
  portalAuthMiddleware,
  async function (req, res) {
    const checkoutSessionId = req.params.checkout_session_id;
    let orphanSubscriptionId = null;
    try {
      const session = await verifyStripeSession(checkoutSessionId);
      if (isBasicCreditSession(session)) {
        const reconciled = await reconcileBasicCreditPurchase(
          session,
          req.user,
          prepaidReconciliationDeps
        );
        invalidatePortalContext(req.user.sub);
        invalidateBasicUsageSummary();
        return res.status(201).json({
          status: "complete",
          purchase_type: reconciled.purchaseType,
          customer_email: reconciled.customer.email,
          plan_key: reconciled.planKey,
          amount_gbp_pence: reconciled.amountPence,
          sn_api: {
            user_id: reconciled.provisioned.user_id,
            organization_id: reconciled.provisioned.organization_id,
            api_key_created: reconciled.provisioned.api_key_created,
          },
        });
      }
      orphanSubscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
      const reconciled = await reconcileCheckoutSession(
        session,
        req.user,
        subscriptionReconciliationDeps
      );
      invalidatePortalContext(req.user.sub);
      return res.status(201).json({
        status: "complete",
        customer_email: reconciled.customer.email,
        subscription_id: reconciled.subscription.id,
        plan_key: reconciled.planKey,
        sn_api: {
          user_id: reconciled.provisioned.user_id,
          organization_id: reconciled.provisioned.organization_id,
          api_key_created: reconciled.provisioned.api_key_created,
        },
      });
    } catch (err) {
      console.error("Error registering user", err);
      const conflict =
        err.code === "stripe_customer_identity_mismatch" ||
        (err.status === 409 &&
          typeof err.detail === "string" &&
          err.detail.toLowerCase().includes("already linked"));
      if (conflict) {
        if (orphanSubscriptionId) {
          try {
            await cancelStripeSubscription(orphanSubscriptionId);
          } catch (cancelError) {
            console.error("Failed to cancel orphaned subscription", cancelError);
          }
        }
        return res.status(409).json({
          code: "email_identity_conflict",
          message:
            "This email is already registered with a different sign-in method. Please log in using your original method.",
        });
      }
      if (err.code === "moesif_management_scope_missing") {
        return res.status(503).json({
          code: "moesif_configuration_error",
          message:
            "Your payment was received, but account setup requires support. Please do not pay again.",
        });
      }
      return res.status(err.code === "checkout_incomplete" ? 409 : 503).json({
        code: err.code || "provisioning_failed",
        message:
          err.code === "checkout_incomplete"
            ? "Stripe is still finalizing this checkout."
            : "Your payment was received, but access synchronization is still pending. Please do not pay again.",
      });
    }
  }
);

app.get("/portal-context", portalAuthMiddleware, function (req, res) {
  if (!req.portalContext) {
    return res.status(404).json({
      message: "Your API organization has not been provisioned yet.",
    });
  }
  return res.status(200).json(req.portalContext);
});

function sendKeyManagementError(res, error) {
  console.error("API key management error:", error);
  const conflict = [
    "multiple_active_subscriptions",
    "multiple_stripe_customers",
    "ambiguous_stripe_customer",
  ].includes(error.code);
  res.status(error.status || (conflict ? 409 : 503)).json({
    code: error.code || "api_key_management_failed",
    message: error.message || "API key request failed",
  });
}

app.get("/api-keys", portalAuthMiddleware, async function (req, res) {
  try {
    const entitlement = await ensureRequestEntitlement(req);
    let keyData = { keys: [], active_count: 0, max_active_keys: 2 };
    if (req.portalContext) {
      try {
        keyData = await listSnApiKeys(req.user);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    const normalizedKeyData = Array.isArray(keyData)
      ? { keys: keyData, active_count: keyData.length, max_active_keys: 2 }
      : keyData;
    res.status(200).json({
      ...normalizedKeyData,
      has_active_subscription: entitlement.active,
      current_plan_key: entitlement.planKey || null,
      subscription_status:
        entitlement.subscription?.status || req.portalContext?.billing_status || null,
    });
  } catch (error) {
    sendKeyManagementError(res, error);
  }
});

app.get("/plan-change", portalAuthMiddleware, async (req, res) => {
  try {
    const planChange = await getSnApiCurrentPlanChange(req.user);
    return res.status(200).json(planChange);
  } catch (error) {
    if (error.status === 404) return res.status(200).json(null);
    return res.status(error.status || 500).json({
      message: error.message || "Failed to retrieve plan change",
    });
  }
});

app.delete("/plan-change", portalAuthMiddleware, async (req, res) => {
  try {
    const planChange = await getSnApiCurrentPlanChange(req.user);
    if (!planChange) return res.status(204).send();
    if (["activating", "awaiting_commitment_payment"].includes(planChange.status)) {
      return res.status(409).json({
        message: "This plan change is already being activated and can no longer be cancelled.",
      });
    }
    await updateSnApiPlanChange(planChange.request_id, { status: "cancelled" });
    return res.status(204).send();
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message || "Failed to cancel plan change",
    });
  }
});

app.post("/api-keys", portalAuthMiddleware, requireActiveSubscription, jsonParser, async function (req, res) {
  try {
    res.status(201).json(
      await createSnApiKey(req.user, {
        name: req.body?.name,
        description: req.body?.description,
      })
    );
  } catch (error) {
    sendKeyManagementError(res, error);
  }
});

app.delete("/api-keys/:api_key_id", portalAuthMiddleware, async function (req, res) {
  try {
    await revokeSnApiKey(req.user, req.params.api_key_id);
    res.status(204).send();
  } catch (error) {
    sendKeyManagementError(res, error);
  }
});

app.post(
  "/api-keys/:api_key_id/rotate",
  portalAuthMiddleware,
  requireActiveSubscription,
  async function (req, res) {
    try {
      res.status(200).json(
        await rotateSnApiKey(req.user, req.params.api_key_id)
      );
    } catch (error) {
      sendKeyManagementError(res, error);
    }
  }
);

app.get(
  "/embed-charts",
  portalAuthMiddleware,
  async function (req, res) {
    try {
      const companyId = req.user?.moesif_company_id;
      if (!companyId) {
        console.error(
          `Canonical company ID not found for ${req.user?.sub || "unknown"}`
        );
        return res.status(400).json({
          message: "Your API organization has not been provisioned yet.",
        });
      }

      const embedInfoArray = await Promise.all(
        [templateWorkspaceIdLiveEvent, templateWorkspaceIdTimeSeries].map(
          (workspaceId) =>
            getInfoForEmbeddedWorkspaces({
              workspaceId: workspaceId,
              companyId,
            })
        )
      );
      res.status(200).json(embedInfoArray);
    } catch (err) {
      console.error("Error generating embedded templates:", err);
      res.status(500).json({ message: "Failed to retrieve embedded template" });
    }
  }
);

app.listen(port, () => {
  console.log(`My Dev Portal Backend is listening at http://localhost:${port}`);
});

const planChangeReconciliationIntervalMs = Number.parseInt(
  process.env.PLAN_CHANGE_RECONCILIATION_INTERVAL_MS || "300000",
  10
);
let planChangeReconciliationRunning = false;

async function runPlanChangeReconciliation() {
  if (planChangeReconciliationRunning) return;
  planChangeReconciliationRunning = true;
  try {
    const results = await reconcileDuePlanChanges(planChangeDeps);
    const failures = results.filter((result) => result.error);
    if (failures.length) {
      console.error("Plan change reconciliation completed with failures", failures);
    }
  } catch (error) {
    console.error("Plan change reconciliation failed", error);
  } finally {
    planChangeReconciliationRunning = false;
  }
}

if (
  Number.isFinite(planChangeReconciliationIntervalMs) &&
  planChangeReconciliationIntervalMs >= 60000
) {
  const reconciliationTimer = setInterval(
    runPlanChangeReconciliation,
    planChangeReconciliationIntervalMs
  );
  reconciliationTimer.unref();
} else {
  console.warn(
    "Plan change reconciliation is disabled; " +
      "PLAN_CHANGE_RECONCILIATION_INTERVAL_MS must be at least 60000"
  );
}
