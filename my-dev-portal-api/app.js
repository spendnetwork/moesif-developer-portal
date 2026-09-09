const express = require("express");
const crypto = require("crypto");
require("dotenv").config();
const moesif = require("moesif-nodejs");
const cors = require("cors");

const {
  verifyStripeSession,
  getActiveStripeSubscription,
  cancelStripeSubscription,
  closeStripeInvoice,
  endStripeSubscriptionForBasicDowngrade,
  getUsageSummary,
  invalidateUsageSummary,
  constructStripeEvent,
  grantCommitmentFromInvoice,
  getStripeCustomerById,
  listStripeSubscriptions,
  createStripePlanCheckoutSession,
  createBasicCreditCheckoutSession,
  getBasicTopUpTotalPence,
  prepareStripePlanChange,
  scheduleStripeDowngrade,
  cancelStripeScheduledDowngrade,
  getScheduledDowngradeState,
  markStripePlanChangeActivated,
  activateStripePlanChange,
  issueReviewedPlanChangeInvoice,
  activateReviewedPlanChange,
  getStripeInvoice,
  getStripeSubscription,
  listStripeInvoices,
  ensureSubscriptionMeteredPrices,
  getPlanKeyForProduct,
  getProductIdForPlanKey,
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
  getSnApiUsageSummary,
  provisionSnApiLocalPrepaidCustomer,
  registerSnApiPaidCredit,
  grantSnApiDevelopmentCredit,
  recordSnApiPortalSignIn,
  registerSnApiPortalAccount,
  listSnApiKeys,
  createSnApiKey,
  revokeSnApiKey,
  rotateSnApiKey,
  createSnApiPlanChange,
  getSnApiCurrentPlanChange,
  getSnApiPlanChangeByCustomer,
  listSnApiDuePlanChanges,
  claimSnApiDuePlanChanges,
  updateSnApiPlanChange,
  createSnApiManualCommitment,
  getSnApiCurrentManualCommitment,
  confirmSnApiManualCommitmentPayment,
  overrideSnApiManualPlanDowngrade,
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
  waitForMoesifSubscription,
  createMoesifBalanceTransaction,
  getMoesifUsageMetrics,
  getMoesifBillingReports,
  getMoesifPrepaidBalance,
  getMoesifSubscriptionBalance,
} = require("./services/moesifApis");
const {
  reconcileBasicCreditPurchase,
  prepaidSubscriptionPeriodEnd,
  validateBasicMeteredPrices,
} = require("./services/prepaidReconciliation");
const {
  assertBasicCreditCheckoutReady,
  assertBasicPurchaseAllowed,
  isBasicCreditSession,
} = require("./services/basicPurchasePolicy");
const {
  getContactLedPlanDetails,
} = require("./services/planPurchasePolicy");
const {
  getBasicPrepaidUsageSummary,
  getManualPrepaidUsageSummary,
  invalidateBasicUsageSummary,
} = require("./services/basicUsageSummary");

const { authMiddleware } = require("./services/authPlugin");
const { localUsageSummary, localSubscription } = require("./services/localUsageSummary");
const { grantDevelopmentAllowance } = require("./services/adminDevelopmentCredit");

const { getUnifiedCustomerIdCached } = require("./services/commonUtils");

const app = express();
app.disable("x-powered-by");
const port = 3030;

function safeBillingError(error, requestId) {
  const safeLabel = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value : undefined;
  return {
    code: safeLabel(error?.code),
    name: safeLabel(error?.name),
    requestId: typeof requestId === "string" && /^(?:evt_|cs_)[A-Za-z0-9_]{1,100}$|^[0-9a-f-]{36}$/i.test(requestId) ? requestId : undefined,
  };
}

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

function serviceTokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

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

const planChangeWorkerId = `${process.env.HOSTNAME || "portal"}:${
  process.pid
}:${crypto.randomUUID()}`;
const planChangeLeaseSeconds = Number.parseInt(
  process.env.PLAN_CHANGE_RECONCILIATION_LEASE_SECONDS || "300",
  10
);
if (
  !Number.isFinite(planChangeLeaseSeconds) ||
  planChangeLeaseSeconds < 30 ||
  planChangeLeaseSeconds > 3600
) {
  throw new Error(
    "PLAN_CHANGE_RECONCILIATION_LEASE_SECONDS must be between 30 and 3600"
  );
}

const planChangeDeps = {
  activateStripePlanChange,
  issueReviewedPlanChangeInvoice,
  activateReviewedPlanChange,
  getStripeInvoice,
  getStripeCustomerById,
  getStripeSubscription,
  getSnApiPlanChangeByCustomer,
  listSnApiDuePlanChanges,
  claimSnApiDuePlanChanges: (limit) =>
    claimSnApiDuePlanChanges(
      planChangeWorkerId,
      limit,
      planChangeLeaseSeconds
    ),
  listStripeInvoices,
  updateSnApiPlanChange,
  grantCommitmentFromInvoice,
  provisionSnApiCustomer,
  provisionSnApiPrepaidCustomer,
  provisionSnApiLocalPrepaidCustomer,
  updateStripeCustomerIdentity,
  endStripeSubscriptionForBasicDowngrade,
  getStripeProduct,
  getPlanPrices,
  validateBasicMeteredPrices,
  syncToMoesif,
  sendPrepaidSubscriptionToMoesif,
  prepaidSubscriptionPeriodEnd,
  getScheduledDowngradeState,
  markStripePlanChangeActivated,
};

const subscriptionReconciliationDeps = {
  getSnApiPortalContext,
  verifyStripeSession,
  getActiveStripeSubscription,
  getStripeSubscription,
  getStripeCustomerById,
  getStripeProduct,
  getPlanKeyForProduct,
  ensureSubscriptionMeteredPrices,
  provisionSnApiCustomer,
  updateStripeCustomerIdentity,
  grantCommitmentFromInvoice,
  syncToMoesif,
  liveStatuses: LIVE_SUBSCRIPTION_STATUSES,
  updateSnApiSubscriptionStatus,
  handleSubscriptionEnded,
  listStripeSubscriptions,
  getSnApiPlanChangeByCustomer,
  updateSnApiPlanChange,
  closeStripeInvoice,
};

const prepaidReconciliationDeps = {
  verifyStripeSession,
  getStripeCustomerById,
  getStripeProduct,
  getPlanKeyForProduct,
  getSnApiPortalContext,
  provisionSnApiLocalPrepaidCustomer,
  registerSnApiPaidCredit,
};

const moesifMiddleware = moesif({
  applicationId: process.env.MOESIF_APPLICATION_ID,

  identifyUser: function (req, _res) {
    return getUnifiedCustomerIdCached(req?.user);
  },
  identifyCompany: function (req, _res) {
    return req?.user?.moesif_company_id;
  },
  skip: function (req, _res) {
    return ["/usage-summary", "/embed-charts", "/portal-context"].includes(
      req.path
    );
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

const PORTAL_CONTEXT_CACHE_TTL_MS = 15 * 1000;
const portalContextCache = new Map();
const portalRegistrationRequests = new Map();

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
    let context;
    try {
      context = await getSnApiPortalContext(req.user);
    } catch (error) {
      if (error.status !== 404) throw error;

      // A browser commonly starts several authenticated requests together.
      // Share one registration call so account creation stays idempotent.
      let registration = portalRegistrationRequests.get(auth0UserId);
      if (!registration) {
        registration = registerSnApiPortalAccount(req.user).finally(() => {
          portalRegistrationRequests.delete(auth0UserId);
        });
        portalRegistrationRequests.set(auth0UserId, registration);
      }
      context = await registration;
    }
    portalContextCache.set(auth0UserId, { context, fetchedAt: Date.now() });
    applyPortalContext(req, context);
  } catch (error) {
    if (error.status === 404) {
      // Keep compatibility during rolling deployments where the SN API may
      // not have the registration endpoint yet.
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

async function requestLocalSummary(req) {
  if (!req.portalContext) return null;
  if (!req.localSummaryRequest) {
    req.localSummaryRequest = (async () => {
      try {
        const summary = await getSnApiUsageSummary(req.user);
        req.portalContext = {
          ...req.portalContext,
          current_plan_key: summary.plan_key,
          current_subscription_id: summary.subscription_id,
          debit_owner: summary.debit_owner,
          access_block_reason: summary.access_block_reason,
        };
        return summary;
      } catch (error) {
        const local = req.portalContext.debit_owner === "api" ||
          req.portalContext.current_plan_key === "development" ||
          String(req.portalContext.current_subscription_id || "").startsWith("prepaid_");
        // Rolling deployment compatibility is only for legacy accounts. Never
        // substitute Stripe or Moesif balances for an API-owned ledger failure.
        if (error.status === 404 && !local) return null;
        throw error;
      }
    })();
  }
  return req.localSummaryRequest;
}

async function ensureRequestEntitlement(req) {
  if (req.entitlement) return req.entitlement;
  const local = await requestLocalSummary(req);
  if (local?.debit_owner === "api") {
    req.entitlement = {
      active: true,
      planKey: local.plan_key,
      subscription: null,
      subscriptionId: local.subscription_id,
      billingProvider: "prepaid",
      apiAccessAllowed: !local.access_block_reason,
      accessBlockReason: local.access_block_reason,
    };
    return req.entitlement;
  }
  const contextPlan = String(
    req.portalContext?.current_plan_key || ""
  ).toLowerCase();
  const contextSubscriptionId = String(
    req.portalContext?.current_subscription_id || ""
  );
  if (
    ["test", "growth", "enterprise"].includes(contextPlan) &&
    contextSubscriptionId.startsWith("manual_") &&
    String(req.portalContext?.billing_status || "").toLowerCase() === "active"
  ) {
    const commitment = await getSnApiCurrentManualCommitment(req.user);
    const synchronized =
      commitment?.status === "paid" &&
      commitment?.subscription_id === contextSubscriptionId &&
      commitment?.moesif_sync_status === "synced";
    if (!synchronized) {
      const error = new Error(
        "Your invoiced plan is awaiting billing synchronization. Please retry shortly or contact support."
      );
      error.code = "manual_commitment_sync_pending";
      error.status = 503;
      throw error;
    }
    req.entitlement = {
      active: true,
      planKey: contextPlan,
      subscription: null,
      subscriptionId: contextSubscriptionId,
      billingProvider: "manual",
    };
    return req.entitlement;
  }
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

// Exhausted local prepaid accounts remain manageable. SN API enforces API
// request access separately and authorizes every key mutation itself.
async function requireActiveSubscription(req, res, next) {
  try {
    const entitlement = await ensureRequestEntitlement(req);
    if (!entitlement.active) {
      return res.status(403).json({
        code: "no_active_subscription",
        message: "Arrange development access or a paid plan to create API keys.",
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
      const contactLedPlan = getContactLedPlanDetails(
        selectedPlanKey,
        process.env.SALES_CONTACT_EMAIL
      );
      if (contactLedPlan) {
        return res.status(409).json(contactLedPlan);
      }

      // Block legacy Basic before entitlement reconciliation or Stripe writes.
      // Migration must verify and preserve old credit; checkout cannot assert it.
      const checkoutSummary = selectedPlanKey === "basic"
        ? await requestLocalSummary(req).catch(error => {
            if (error.status === 404) return null;
            throw error;
          })
        : null;
      if (selectedPlanKey === "basic") {
        assertBasicCreditCheckoutReady(checkoutSummary, req.portalContext);
      }
      const entitlement =
        selectedPlanKey === "basic"
          ? await ensureRequestEntitlement(req)
          : null;
      if (selectedPlanKey === "basic") {
        assertBasicCreditCheckoutReady(checkoutSummary, req.portalContext, entitlement);
      }
      const shouldPreparePlanChange =
        selectedPlanKey !== "basic" ||
        (entitlement?.active && !["basic", "development"].includes(entitlement.planKey));

      if (shouldPreparePlanChange) {
        try {
          const prepared = await prepareStripePlanChange(
            email,
            planId,
            req.user,
            req.portalContext
          );
          const scheduled = await createSnApiPlanChange(req.user, {
            request_id: requestId || crypto.randomUUID(),
            stripe_customer_id: prepared.customer.id,
            stripe_subscription_id: prepared.subscription?.id,
            from_plan_key: prepared.fromPlanKey,
            to_plan_key: prepared.toPlanKey,
            target_product_id: prepared.targetProductId,
            effective_at: new Date(prepared.effectiveAt * 1000).toISOString(),
            commitment_ends_at: prepared.commitmentEndsAt
              ? new Date(prepared.commitmentEndsAt * 1000).toISOString()
              : null,
            quoted_amount_gbp_pence: prepared.quotedAmountGbpPence,
            currency: prepared.currency,
            metadata: {
              source: "developer_portal",
              change_type: prepared.changeType,
              ...(prepared.creditExpiresAt
                ? {
                    credit_expires_at: new Date(
                      prepared.creditExpiresAt * 1000
                    ).toISOString(),
                  }
                : {}),
            },
          });
          let persistedPlanChange = scheduled;
          if (prepared.changeType === "downgrade") {
            let stripeSchedule;
            try {
              stripeSchedule = await scheduleStripeDowngrade(scheduled);
              persistedPlanChange = await updateSnApiPlanChange(
                scheduled.request_id,
                {
                  status: "scheduled",
                  stripe_schedule_id: stripeSchedule.id,
                }
              );
            } catch (scheduleError) {
              if (stripeSchedule?.id) {
                await cancelStripeScheduledDowngrade(stripeSchedule.id).catch(
                  (releaseError) =>
                    console.error(
                      "Failed to release incomplete Stripe schedule",
                      releaseError
                    )
                );
              }
              await updateSnApiPlanChange(scheduled.request_id, {
                status: "failed",
                failure_code:
                  scheduleError.code || "stripe_schedule_creation_failed",
                failure_message: String(scheduleError.message || scheduleError)
                  .slice(0, 2000),
              }).catch((updateError) =>
                console.error(
                  "Failed to record Stripe schedule failure",
                  updateError
                )
              );
              throw scheduleError;
            }
          }
          return res.status(200).json({
            scheduled: true,
            requiresReview: prepared.changeType === "upgrade",
            planChange: persistedPlanChange,
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

      if (selectedPlanKey === "basic") {
        assertBasicPurchaseAllowed(purchaseType, entitlement);
      }

      const session = selectedPlanKey === "basic"
        ? await createBasicCreditCheckoutSession(
            email,
            planId,
            topUpAmountGbp,
            purchaseType,
            req.user,
            requestId,
            req.portalContext
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
      console.error("Failed to create stripe checkout session", safeBillingError(err, requestId));
      const status =
        err.code === "multiple_active_subscriptions" ||
        err.code === "active_subscription_exists" ||
        err.code === "basic_already_active" ||
        err.code === "basic_plan_conflict" ||
        err.code === "basic_plan_required" ||
        err.code === "legacy_basic_migration_required"
          ? 409
          : err.status === 503 ? 503 : 400;
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

// -------------------------------------------------------------------------
// Admin (service-to-service) plan change.
//
// The internal admin console has already authenticated the human admin
// (Auth0 + allowlist). This endpoint is machine-to-machine, protected by a
// shared secret (ADMIN_PLAN_CHANGE_TOKEN) in the X-Admin-Service-Token header,
// mirroring the X-Developer-Portal-Token pattern SN API uses.
//
// Basic uses the existing Stripe flow. Growth and Enterprise create a manual
// commitment request and remain inactive until an administrator confirms the
// externally issued invoice has been paid.
// -------------------------------------------------------------------------
app.post("/admin/development-credit", jsonParser, async (req, res) => {
  const expected = process.env.ADMIN_PLAN_CHANGE_TOKEN;
  if (!expected) return res.status(503).json({ code: "admin_not_configured", message: "Admin service is not configured." });
  if (!serviceTokenMatches(req.headers["x-admin-service-token"], expected)) {
    return res.status(401).json({ code: "unauthorized", message: "Invalid admin service token." });
  }
  try {
    const result = await grantDevelopmentAllowance(req.body, req.headers["x-request-id"], {
      getSnApiPortalContext,
      provisionSnApiLocalPrepaidCustomer,
      grantSnApiDevelopmentCredit,
    });
    invalidatePortalContext(req.body.auth0UserId);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || 503).json({
      code: error.code || "development_credit_failed",
      message: error.message || "The allowance could not be confirmed. Retry with the same request ID.",
    });
  }
});

app.post("/admin/plan-change", jsonParser, async (req, res) => {
  const expected = process.env.ADMIN_PLAN_CHANGE_TOKEN;
  if (!expected) {
    return res.status(503).json({
      code: "admin_plan_change_not_configured",
      message: "Admin plan change is not configured on this service.",
    });
  }
  const provided = req.headers["x-admin-service-token"];
  if (!serviceTokenMatches(provided, expected)) {
    return res
      .status(401)
      .json({ code: "unauthorized", message: "Invalid admin service token." });
  }

  const auth0UserId = req.body?.auth0_user_id;
  const toPlanKey = String(req.body?.to_plan_key || "").trim().toLowerCase();
  const actorEmail = req.body?.actor_email || "admin";
  const overrideImmediate = req.body?.override_immediate === true;
  const overrideReason = String(req.body?.reason || "").trim();
  const suppliedRequestId = req.body?.request_id;
  const requestId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(suppliedRequestId || "")
    ? suppliedRequestId
    : crypto.randomUUID();

  if (!auth0UserId || !toPlanKey) {
    return res.status(400).json({
      code: "invalid_request",
      message: "auth0_user_id and to_plan_key are required.",
    });
  }
  if (!["basic", "test", "growth", "enterprise"].includes(toPlanKey)) {
    return res
      .status(400)
      .json({ code: "invalid_plan", message: "Unknown plan." });
  }

  if (overrideImmediate) {
    if (toPlanKey !== "growth" || overrideReason.length < 5) {
      return res.status(422).json({
        code: "invalid_manual_downgrade_override",
        message:
          "Immediate override supports Enterprise to Growth and requires a reason.",
      });
    }
    try {
      const planChange = await overrideSnApiManualPlanDowngrade(
        { sub: auth0UserId },
        {
          request_id: requestId,
          to_plan_key: toPlanKey,
          requested_by: actorEmail,
          reason: overrideReason,
        }
      );
      invalidatePortalContext(auth0UserId);
      return res.status(200).json({
        ok: true,
        pending: false,
        scheduled: false,
        changeType: "downgrade",
        overrideApplied: true,
        moesifSyncPending: planChange.failure_code === "moesif_sync_failed",
        message:
          planChange.failure_code === "moesif_sync_failed"
            ? "Downgrade applied immediately. Moesif synchronization requires attention."
            : "Enterprise downgraded to Growth immediately. Existing prepaid credit was preserved.",
        planChange,
      });
    } catch (err) {
      console.error("Admin manual downgrade override failed", err);
      return res.status(err.status || 400).json({
        code: err.code || "manual_downgrade_override_failed",
        message: err.message || "The immediate downgrade could not be applied.",
      });
    }
  }

  // Test, Growth, and Enterprise use the auditable manual commitment flow.
  // creates an auditable commitment request; access changes only after an
  // administrator confirms the external invoice payment.
  if (["test", "growth", "enterprise"].includes(toPlanKey)) {
    try {
      let manualCommitment;
      try {
        manualCommitment = await createSnApiManualCommitment(
          { sub: auth0UserId },
          {
            request_id: requestId,
            to_plan_key: toPlanKey,
            requested_by: actorEmail,
            metadata: { source: "admin_console" },
          }
        );
      } catch (createError) {
        const ambiguousCreate =
          !createError.status ||
          createError.status === 409 ||
          createError.status >= 500;
        if (!ambiguousCreate) throw createError;

        const existing = await getSnApiCurrentManualCommitment({
          sub: auth0UserId,
        }).catch(() => null);
        const reusable =
          existing?.to_plan_key === toPlanKey &&
          ["awaiting_invoice", "awaiting_payment"].includes(existing?.status);
        if (!reusable) throw createError;

        console.info("Reusing an existing open manual commitment", {
          requestId: existing.request_id,
          planKey: toPlanKey,
        });
        manualCommitment = existing;
      }
      invalidatePortalContext(auth0UserId);
      return res.status(200).json({
        ok: true,
        pending: true,
        requiresManualInvoice: true,
        changeType: "upgrade",
        message: `Manual ${toPlanKey} commitment is ready. Confirm payment after the external invoice is paid.`,
        manualCommitment,
      });
    } catch (err) {
      console.error("Admin manual commitment failed", err);
      return res.status(err.status || 400).json({
        code: err.code || "manual_commitment_failed",
        message: err.message || "The manual commitment could not be created.",
      });
    }
  }

  try {
    // Same portal context the customer flow builds, fetched via the service
    // token for the *target* customer.
    const portalContext = await getSnApiPortalContext({ sub: auth0UserId });
    if (toPlanKey === "basic" && [null, undefined, "", "development"].includes(portalContext.current_plan_key)) {
      const basicProductId = await getProductIdForPlanKey("basic");
      const params = new URLSearchParams({ plan_id_to_purchase: basicProductId, purchase_type: "basic_activation" });
      return res.status(200).json({
        ok: true,
        pending: true,
        paymentRequired: true,
        requestId,
        planKey: portalContext.current_plan_key || null,
        toPlanKey: "basic",
        paymentUrl: `${getFrontendOrigin()}/checkout?${params}`,
        message: "The customer must sign in and purchase at least GBP 100 of Basic credit. Their current plan and development allowance remain unchanged until payment is verified.",
      });
    }
    const email = req.body?.email || portalContext.email;
    if (!email) {
      return res.status(422).json({
        code: "email_unknown",
        message: "Could not resolve the customer's email.",
      });
    }
    const authUser = {
      sub: auth0UserId,
      email,
      name: req.body?.name || email,
    };

    if (String(portalContext.current_plan_key || "").toLowerCase() === toPlanKey) {
      return res.status(409).json({
        code: "already_on_plan",
        message: `Customer is already on ${toPlanKey}.`,
      });
    }

    const planId = await getProductIdForPlanKey(toPlanKey);
    const prepared = await prepareStripePlanChange(
      email,
      planId,
      authUser,
      portalContext
    );

    const scheduled = await createSnApiPlanChange(authUser, {
      request_id: requestId,
      stripe_customer_id: prepared.customer.id,
      stripe_subscription_id: prepared.subscription?.id,
      from_plan_key: prepared.fromPlanKey,
      to_plan_key: prepared.toPlanKey,
      target_product_id: prepared.targetProductId,
      effective_at: new Date(prepared.effectiveAt * 1000).toISOString(),
      commitment_ends_at: prepared.commitmentEndsAt
        ? new Date(prepared.commitmentEndsAt * 1000).toISOString()
        : null,
      quoted_amount_gbp_pence: prepared.quotedAmountGbpPence,
      currency: prepared.currency,
      metadata: {
        source: "admin_console",
        actor_email: actorEmail,
        change_type: prepared.changeType,
        ...(prepared.creditExpiresAt
          ? {
              credit_expires_at: new Date(
                prepared.creditExpiresAt * 1000
              ).toISOString(),
            }
          : {}),
      },
    });

    let persistedPlanChange = scheduled;
    if (prepared.changeType === "downgrade") {
      let stripeSchedule;
      try {
        stripeSchedule = await scheduleStripeDowngrade(scheduled);
        persistedPlanChange = await updateSnApiPlanChange(scheduled.request_id, {
          status: "scheduled",
          stripe_schedule_id: stripeSchedule.id,
        });
      } catch (scheduleError) {
        if (stripeSchedule?.id) {
          await cancelStripeScheduledDowngrade(stripeSchedule.id).catch(
            (releaseError) =>
              console.error(
                "Failed to release incomplete Stripe schedule",
                releaseError
              )
          );
        }
        await updateSnApiPlanChange(scheduled.request_id, {
          status: "failed",
          failure_code:
            scheduleError.code || "stripe_schedule_creation_failed",
          failure_message: String(scheduleError.message || scheduleError).slice(
            0,
            2000
          ),
        }).catch((updateError) =>
          console.error("Failed to record Stripe schedule failure", updateError)
        );
        throw scheduleError;
      }
    }

    invalidatePortalContext(auth0UserId);
    return res.status(200).json({
      ok: true,
      scheduled: true,
      changeType: prepared.changeType,
      requiresReview: prepared.changeType === "upgrade",
      planChange: persistedPlanChange,
    });
  } catch (err) {
    console.error("Admin plan change failed", err);
    const status =
      err.code === "no_active_subscription" ||
      err.code === "stripe_customer_not_found" ||
      err.code === "outstanding_payment" ||
      err.code === "already_on_plan"
        ? 409
        : 400;
    return res.status(status).json({
      code: err.code || "plan_change_failed",
      message: err.message || "The plan change could not be started.",
    });
  }
});

app.post(
  "/admin/test-credit-top-up",
  jsonParser,
  async (req, res) => {
    const expected = process.env.ADMIN_PLAN_CHANGE_TOKEN;
    const provided = req.headers["x-admin-service-token"];
    if (!expected) {
      return res.status(503).json({
        code: "admin_plan_change_not_configured",
        message: "Admin billing operations are not configured on this service.",
      });
    }
    if (!serviceTokenMatches(provided, expected)) {
      return res
        .status(401)
        .json({ code: "unauthorized", message: "Invalid admin service token." });
    }

    const auth0UserId = String(req.body?.auth0_user_id || "").trim();
    const amountGbp = Number(req.body?.amount_gbp);
    const transactionId = String(req.body?.transaction_id || "").trim();
    const reason = String(req.body?.reason || "").trim();
    if (
      !auth0UserId ||
      !Number.isFinite(amountGbp) ||
      amountGbp <= 0 ||
      amountGbp > 10000 ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(transactionId) ||
      reason.length < 3
    ) {
      return res.status(400).json({
        code: "invalid_test_top_up",
        message:
          "A customer, a positive amount up to GBP 10,000, a transaction UUID, and a reason are required.",
      });
    }

    try {
      const commitment = await getSnApiCurrentManualCommitment({
        sub: auth0UserId,
      });
      const isActiveTestCommitment =
        commitment?.to_plan_key === "test" &&
        commitment?.status === "paid" &&
        commitment?.moesif_sync_status === "synced" &&
        String(commitment?.subscription_id || "").startsWith("manual_");
      if (!isActiveTestCommitment) {
        return res.status(409).json({
          code: "test_subscription_not_active",
          message:
            "Test credit can only be added to an active, synchronized Test subscription.",
        });
      }

      await waitForMoesifSubscription({
        companyId: commitment.moesif_company_id,
        subscriptionId: commitment.subscription_id,
      });
      await createMoesifBalanceTransaction({
        companyId: commitment.moesif_company_id,
        subscriptionId: commitment.subscription_id,
        amountGbp: Math.round(amountGbp * 100) / 100,
        transactionId,
        description: `Test credit top-up: ${reason.slice(0, 160)}`,
      });
      invalidatePortalContext(auth0UserId);
      return res.json({
        ok: true,
        transactionId,
        amountGbp: Math.round(amountGbp * 100) / 100,
        message: "Test credit was added successfully.",
      });
    } catch (error) {
      console.error("Admin Test credit top-up failed", error);
      return res.status(error.status || 502).json({
        code: error.code || "test_credit_top_up_failed",
        message: error.message || "Test credit could not be added.",
      });
    }
  }
);

app.post(
  "/admin/manual-commitments/:requestId/confirm-payment",
  jsonParser,
  async (req, res) => {
    const expected = process.env.ADMIN_PLAN_CHANGE_TOKEN;
    const provided = req.headers["x-admin-service-token"];
    if (!expected) {
      return res.status(503).json({
        code: "admin_plan_change_not_configured",
        message: "Admin plan change is not configured on this service.",
      });
    }
    if (!serviceTokenMatches(provided, expected)) {
      return res
        .status(401)
        .json({ code: "unauthorized", message: "Invalid admin service token." });
    }

    const invoiceReference = String(
      req.body?.external_invoice_reference || ""
    ).trim();
    const actorEmail = String(req.body?.actor_email || "admin").trim();
    const planKey = String(req.body?.plan_key || "").trim().toLowerCase();
    if (!invoiceReference || !["test", "growth", "enterprise"].includes(planKey)) {
      return res.status(400).json({
        code: "invalid_request",
        message: "external_invoice_reference and a commitment plan are required.",
      });
    }

    let commitment;
    let balanceCreditAttempted = false;
    try {
      commitment = await confirmSnApiManualCommitmentPayment(
        req.params.requestId,
        {
          external_invoice_reference: invoiceReference,
          confirmed_by: actorEmail,
          invoice_issued_at: req.body?.invoice_issued_at || undefined,
          invoice_due_at: req.body?.invoice_due_at || undefined,
          paid_at: req.body?.paid_at || undefined,
        }
      );
      if (commitment.to_plan_key !== planKey) {
        throw Object.assign(new Error("Commitment plan does not match the request."), {
          code: "manual_commitment_plan_mismatch",
          status: 409,
        });
      }
      if (commitment.moesif_sync_status !== "synced") {
        throw Object.assign(
          new Error(
            commitment.moesif_sync_error ||
              "SN API recorded the payment but did not synchronize the subscription to Moesif."
          ),
          { code: "manual_moesif_subscription_sync_failed", status: 502 }
        );
      }
      await waitForMoesifSubscription({
        companyId: commitment.moesif_company_id,
        subscriptionId: commitment.subscription_id,
        delaysMs: [250, 500, 1000],
      });
      balanceCreditAttempted = true;
      await createMoesifBalanceTransaction({
        companyId: commitment.moesif_company_id,
        subscriptionId: commitment.subscription_id,
        amountGbp: commitment.amount_gbp_pence / 100,
        // Moesif expects a 36-character UUID and deduplicates retries by it.
        // The commitment request ID is stable across payment confirmations.
        transactionId: req.params.requestId,
        description: `${planKey} commitment invoice ${invoiceReference}`,
      });
      invalidatePortalContext(commitment.auth0_user_id);
      return res.json({
        ok: true,
        message: `${planKey} access activated and prepaid credit applied.`,
        manualCommitment: commitment,
      });
    } catch (error) {
      if (error.code === "moesif_subscription_propagation_delayed") {
        console.info("Manual commitment subscription is still propagating", {
          requestId: req.params.requestId,
          subscriptionId: commitment?.subscription_id,
        });
        return res.status(202).json({
          ok: true,
          pending: true,
          state: "subscription_syncing",
          retryAfterMs: 3000,
          message:
            "Payment is recorded. Moesif is synchronizing the subscription before prepaid credit is applied.",
          manualCommitment: commitment,
        });
      }
      console.error("Manual commitment payment confirmation failed", error);
      const balanceFailed = balanceCreditAttempted;
      return res.status(error.status || 502).json({
        code: error.code || "manual_commitment_activation_failed",
        message:
          error.code === "moesif_management_scope_missing"
            ? "The subscription is synchronized, but the Moesif Management token cannot create its prepaid credit. Add the required billing write scopes, then retry this confirmation without issuing another invoice."
            : balanceFailed
            ? "The subscription is synchronized, but its prepaid credit could not be applied. Retry this confirmation without issuing another invoice."
            : commitment?.status === "paid"
            ? "Payment was recorded, but Moesif synchronization failed. Retry this confirmation without issuing another invoice."
            : error.message || "The payment confirmation could not be completed.",
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
      console.error("Stripe webhook signature verification failed", safeBillingError(err));
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
          invalidateUsageSummary();
        } else {
          await reconcileCheckoutSession(
            event.data.object,
            null,
            subscriptionReconciliationDeps
          );
          invalidateUsageSummary();
        }
      } catch (reconciliationError) {
        if (reconciliationError.code === "checkout_payment_pending") {
          return res.status(200).json({ received: true, payment_pending: true });
        }
        console.error("Checkout webhook reconciliation failed", safeBillingError(reconciliationError, event.id));
        return res.status(500).json({ message: "Checkout reconciliation failed" });
      }
    }

    if (event.type === "invoice.paid") {
      try {
        await grantCommitmentFromInvoice(event.data.object);
        await processPaidInvoice(event.data.object, planChangeDeps);
        invalidateUsageSummary();
      } catch (planChangeError) {
        console.error("Paid invoice plan-change processing failed", planChangeError);
        return res.status(500).json({ message: "Plan change processing failed" });
      }
    }

    if (event.type === "invoice.payment_failed") {
      try {
        await processFailedInvoice(event.data.object, planChangeDeps);
        invalidateUsageSummary();
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
        invalidateUsageSummary();
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
    const local = localSubscription(await requestLocalSummary(req));
    if (local) return res.status(200).json([local]);
    const entitlement = await ensureRequestEntitlement(req);
    if (!entitlement.active) return res.status(200).json([]);
    if (entitlement.billingProvider === "manual") {
      const [commitment, balance] = await Promise.all([
        getSnApiCurrentManualCommitment(req.user),
        getMoesifSubscriptionBalance({
          companyId: req.portalContext.moesif_company_id,
          subscriptionId: entitlement.subscriptionId,
        }),
      ]);
      return res.status(200).json([
        {
          ...balance.subscription,
          subscription_id: entitlement.subscriptionId,
          plan_key: entitlement.planKey,
          status: "active",
          billing_provider: "manual",
          billing_model: "prepaid_commitment",
          external_invoice_reference:
            commitment?.external_invoice_reference || null,
          balance: {
            current_balance: balance.current,
            pending_activity: balance.pending,
            available_balance: balance.available,
          },
        },
      ]);
    }
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
    const local = localUsageSummary(await requestLocalSummary(req));
    if (local) return res.status(200).json(local);
    if (
      ["test", "growth", "enterprise"].includes(
        String(req.portalContext?.current_plan_key || "").toLowerCase()
      ) &&
      String(req.portalContext?.current_subscription_id || "").startsWith(
        "manual_"
      )
    ) {
      const commitment = await getSnApiCurrentManualCommitment(req.user);
      if (!commitment || commitment.status !== "paid") {
        return res.status(200).json({ hasSubscription: false });
      }
      const summary = await getManualPrepaidUsageSummary(
        {
          userId: req.portalContext.moesif_user_id,
          companyId: req.portalContext.moesif_company_id,
          subscriptionId: commitment.subscription_id,
          planKey: commitment.to_plan_key,
          commitmentAmountPence: commitment.commitment_total_gbp_pence,
        },
        {
          getMoesifSubscriptionBalance,
          getMoesifBillingReports,
          getMoesifUsageMetrics,
          getPlansFromMoesif,
        }
      );
      return res.status(200).json(summary);
    }
    if (
      req.portalContext?.current_plan_key === "basic" &&
      !req.portalContext?.current_subscription_id
    ) {
      const summary = await getBasicPrepaidUsageSummary(
        {
          userId: req.portalContext.moesif_user_id,
          companyId: req.portalContext.moesif_company_id,
          stripeCustomerId: req.portalContext.stripe_customer_id,
        },
        {
          getMoesifPrepaidBalance,
          getMoesifBillingReports,
          getMoesifUsageMetrics,
          getPlansFromMoesif,
          getBasicTopUpTotalPence,
        }
      );
      return res.status(200).json(summary);
    }
    const summary = await getUsageSummary(req.user?.email, req.user, {
      userId: req.portalContext?.moesif_user_id,
      companyId: req.portalContext?.moesif_company_id,
      getMoesifBillingReports,
      getMoesifUsageMetrics,
    });
    return res.status(200).json(summary);
  } catch (error) {
    if (error.code === "multiple_active_subscriptions") {
      return res.status(409).json({
        code: error.code,
        message:
          "Multiple active subscriptions were found. Please contact support to correct the account.",
      });
    }
    if (error.code === "no_active_subscription") {
      // No active subscription yet is not an error state for this widget.
      return res.status(200).json({ hasSubscription: false });
    }
    console.error("Usage summary unavailable", {
      code: error.code || "usage_summary_unavailable",
      status: error.status,
      companyId: req.portalContext?.moesif_company_id,
      planKey: req.portalContext?.current_plan_key,
      message: error.message,
    });
    return res.status(503).json({
      code: error.code || "usage_summary_unavailable",
      message:
        "Current usage data is temporarily unavailable. Your portal remains available; no balance has been inferred.",
    });
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
        invalidateUsageSummary();
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
      invalidateUsageSummary();
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
      console.error("Error registering user", safeBillingError(err, checkoutSessionId));
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
      if (["current_plan_conflict", "credit_subscription_conflict", "commercial_transition_required", "legacy_basic_bootstrap_required", "idempotency_conflict"].includes(err.code)) {
        return res.status(409).json({
          code: err.code,
          message: "This payment needs account review. Your current plan has not been replaced. Contact welcome@openopps.com and do not pay again.",
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

// Called once per browser session, right after Auth0 confirms the user, so
// "last signed in" reflects an actual human opening the portal -- not the
// unattended plan-change reconciliation job, which also calls /provision.
app.post("/sign-in", authMiddleware, async function (req, res) {
  try {
    await recordSnApiPortalSignIn(req.user);
  } catch (error) {
    if (error.status !== 404) {
      console.error("Portal sign-in tracking failed:", error);
    }
  }
  return res.status(204).end();
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
    let entitlement;
    let entitlementError;
    try {
      entitlement = await ensureRequestEntitlement(req);
    } catch (error) {
      entitlementError = error.code || "entitlement_verification_failed";
      entitlement = { active: false, planKey: req.portalContext?.current_plan_key };
    }
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
      api_access_allowed: entitlement.apiAccessAllowed,
      access_block_reason: entitlement.accessBlockReason,
      entitlement_error: entitlementError,
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
    if (
      ["invoice_open", "activating", "awaiting_commitment_payment"].includes(
        planChange.status
      )
    ) {
      return res.status(409).json({
        message: "This plan change is already being activated and can no longer be cancelled.",
      });
    }
    if (planChange.stripe_schedule_id) {
      await cancelStripeScheduledDowngrade(planChange.stripe_schedule_id);
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
  setImmediate(runPlanChangeReconciliation).unref();
} else {
  console.warn(
    "Plan change reconciliation is disabled; " +
      "PLAN_CHANGE_RECONCILIATION_INTERVAL_MS must be at least 60000"
  );
}
