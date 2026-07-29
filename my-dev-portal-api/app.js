const express = require("express");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: [".env", ".env.template"] });
const bodyParser = require("body-parser");
const moesif = require("moesif-nodejs");
const cors = require("cors");

const {
  verifyStripeSession,
  hasActiveStripeSubscription,
  cancelStripeSubscription,
  ensureCreditGrant,
  getUsageSummary,
  constructStripeEvent,
  grantCommitmentFromInvoice,
  getStripeCustomer,
  getStripeCustomerById,
  listStripeSubscriptions,
  createStripeCheckoutSession,
  createStripePlanCheckoutSession,
  prepareStripePlanChange,
  activateStripePlanChange,
  getStripeSubscription,
  listStripeInvoices,
  attachPlanMeteredPrices,
  updateStripeCustomerIdentity,
} = require("./services/stripeApis");
const {
  handleSubscriptionEnded,
} = require("./services/subscriptionEnforcement");
const {
  provisionSnApiCustomer,
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
} = require("./services/snApiProvisioning");
const {
  processPaidInvoice,
  processFailedInvoice,
  reconcileDuePlanChanges,
} = require("./services/planChangeService");
const {
  syncToMoesif,
  getInfoForEmbeddedWorkspaces,
  getPlansFromMoesif,
  getSubscriptionsForUserId,
  sendSubscriptionToMoesif,
} = require("./services/moesifApis");

const { authMiddleware } = require("./services/authPlugin");

const { getApimProvisioningPlugin } = require("./config/pluginLoader");
const {
  getUnifiedCustomerId,
  getUnifiedCustomerIdCached,
} = require("./services/commonUtils");
const { BillingProvider } = require("./services/billingProvider");

const app = express();
app.use(express.static(path.join(__dirname)));
const port = 3030;

// Keep the load-balancer health check independent of Moesif, Stripe, Auth0,
// and the Spend Network API. Dependency failures should not make ECS replace
// an otherwise healthy portal API task.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

const moesifManagementToken = process.env.MOESIF_MANAGEMENT_TOKEN;
const templateWorkspaceIdLiveEvent =
  process.env.MOESIF_TEMPLATE_WORKSPACE_ID_LIVE_EVENT_LOG;
const templateWorkspaceIdTimeSeries =
  process.env.MOESIF_TEMPLATE_WORKSPACE_ID_TIME_SERIES;

var jsonParser = bodyParser.json();

if (!moesifManagementToken) {
  console.error(
    "No MOESIF_MANAGEMENT_TOKEN found. Please create an .env file with MOESIF_MANAGEMENT_TOKEN & MOESIF_TEMPLATE_WORKSPACE_ID."
  );
}

if (!templateWorkspaceIdLiveEvent) {
  console.error(
    "No MOESIF_TEMPLATE_WORKSPACE_ID found. Please create an .env file with MOESIF_MANAGEMENT_TOKEN & MOESIF_TEMPLATE_WORKSPACE_ID."
  );
}

const provisioningService = getApimProvisioningPlugin();

const customBillingProvider = new BillingProvider();

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

const moesifMiddleware = moesif({
  applicationId: process.env.MOESIF_APPLICATION_ID,

  identifyUser: function (req, _res) {
    return getUnifiedCustomerIdCached(req?.user);
  },
  identifyCompany: function (req, _res) {
    return req?.user?.moesif_company_id;
  },
});

app.use(moesifMiddleware, cors());

const PORTAL_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const portalContextCache = new Map();

function applyPortalContext(req, context) {
  req.portalContext = context;
  req.user.moesif_user_id = context.moesif_user_id;
  req.user.moesif_company_id = context.moesif_company_id;
  req.user.sn_api_user_id = context.user_id;
  req.user.sn_api_organization_id = context.organization_id;
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

// API keys grant API access, so they may only be created or rotated while the
// customer has a live subscription. Checked against Stripe directly so a
// cancellation takes effect immediately, not after Moesif sync.
async function requireActiveSubscription(req, res, next) {
  try {
    const active = await hasActiveStripeSubscription(req.user?.email, req.user);
    if (!active) {
      return res.status(403).json({
        code: "no_active_subscription",
        message: "An active subscription is required to manage API keys.",
      });
    }
  } catch (error) {
    console.error("Subscription check failed:", error);
    return res.status(403).json({
      code: "no_active_subscription",
      message: "We could not verify your subscription. Please try again.",
    });
  }
  return next();
}

app.post(
  "/create-stripe-checkout-session",
  portalAuthMiddleware,
  async (req, res) => {
    const priceId = req.query?.price_id;
    const planId = req.query?.plan_id;
    const email = req.user?.email;
    const quantity = req.query?.quantity || undefined;
    const requestId = req.query?.request_id;

    console.log(`create-stripe-checkout-session called for ${email} planId ${planId} priceId ${priceId} quantity ${quantity}`);

    if (!priceId && !planId) {
      return res.status(400).json({ message: "plan_id or price_id is required" });
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
      // A transient check failure should not block a legitimate checkout;
      // provisioning still guards the conflict as a backstop.
      if (availabilityError.status && availabilityError.status !== 404) {
        console.error("Email availability check failed:", availabilityError);
      }
    }

    try {
      if (planId) {
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
          if (planChangeError.code !== "no_active_subscription") {
            throw planChangeError;
          }
        }
      }

      const session = planId
        ? await createStripePlanCheckoutSession(email, planId, req?.user, requestId)
        : await createStripeCheckoutSession(
            email,
            priceId,
            quantity,
            req?.user,
            requestId
          );
      console.log("got session back from stripe session");
      console.log(JSON.stringify(session));

      res.send({ clientSecret: session.client_secret });
    } catch (err) {
      console.error("Failed to create stripe checkout session", err);
      const status =
        err.code === "multiple_active_subscriptions" ||
        err.code === "active_subscription_exists"
          ? 409
          : 400;
      res.status(status).json({
        code: err.code || "checkout_failed",
        message:
          err.code === "multiple_active_subscriptions"
            ? "Multiple active subscriptions were found. Please contact support before changing plans."
            : err.code === "active_subscription_exists"
              ? "You already have an active subscription. Select a plan to change it."
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
// Required Stripe events: invoice.paid, invoice.payment_succeeded,
// customer.subscription.deleted, customer.subscription.updated,
// customer.subscription.paused. Without the subscription events a cancelled
// customer keeps a working API key. See README "Subscription enforcement".
const SUBSCRIPTION_LIFECYCLE_EVENTS = [
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "customer.subscription.paused",
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

    if (event.type === "invoice.paid") {
      try {
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
        const result = await handleSubscriptionEnded(event.data.object, {
          getStripeCustomerById,
          listStripeSubscriptions,
        });
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

app.get("/plans", jsonParser, async (req, res) => {
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

app.get("/subscriptions", portalAuthMiddleware, jsonParser, async (req, res) => {
  // But in this project, we get from Moesif, because
  // Moesif syncs subscriptions from several billing providers.
  // - from moesif, you can get a list of associated subscriptions
  //   using companyId, userId or email.
  // - Your use case needs and data model/mapping inform the best approach. (See DATA_MODEL.md)
  //   for assumptions in this project.
  // - In this project, since Stripe customer id is mapped to user_id in Moesif,
  //   We use that as the user_id to fetch subscriptions.

  const sanitizedEmail = req.query.email.replace(/\n|\r/g, "");
  console.log("query email " + sanitizedEmail);
  console.log("verified email from claims " + req.user.email);
  const email = req.user?.email;

  let moesifUserId;
  try {
    moesifUserId = await getUnifiedCustomerId(req.user, email);
    // see DATA_MODEL.md regarding how customer ids are mapped.
    // please modify if you decides to use some other data mapping model.
    if (!moesifUserId) {
      return res.status(200).json([]);
    }

    const subscriptions = await getSubscriptionsForUserId({
      userId: moesifUserId,
    });

    console.log(
      "got subscriptions from moesif " + JSON.stringify(subscriptions)
    );
    res.status(200).json(subscriptions);
  } catch (err) {
    console.error(
      "Error getting subscription from moesif for " +
        email +
        " " +
        moesifUserId,
      err
    );
    res.status(404).json({ message: err.toString() });
  }
});

app.get("/usage-summary", portalAuthMiddleware, async (req, res) => {
  try {
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
  function (req, res) {
    const checkout_session_id = req.params.checkout_session_id;
    let orphanSubscriptionId = null;

    verifyStripeSession(checkout_session_id)
      .then(async (result) => {
        const stripeCheckOutSessionInfo = result;
        orphanSubscriptionId = result?.subscription?.id || null;
        console.log("in stripe register");
        if (result.status !== "complete") {
          return res.status(409).json({ message: "Stripe checkout is not complete" });
        }
        await attachPlanMeteredPrices(result);
        if (result.customer && result.subscription) {
          console.log("customer and subscription present");
          const email = result.customer_details?.email || result.customer.email;
          const price = result.line_items?.data?.[0]?.price;
          const provisionedCustomer = await provisionSnApiCustomer({
            authUser: req.user,
            customer: result.customer,
            subscription: result.subscription,
            price,
            product: price?.product,
          });
          console.log("provisioned SN API customer:", JSON.stringify({
            user_id: provisionedCustomer.user_id,
            organization_id: provisionedCustomer.organization_id,
            api_key_created: provisionedCustomer.api_key_created,
          }));
          req.user.moesif_user_id = String(provisionedCustomer.user_id);
          req.user.moesif_company_id = String(
            provisionedCustomer.moesif_company_id ||
              provisionedCustomer.organization_id
          );
          await updateStripeCustomerIdentity(result.customer.id, {
            moesifUserId: req.user.moesif_user_id,
            moesifCompanyId: req.user.moesif_company_id,
            auth0UserId: req.user.sub,
            subscriptionId: result.subscription.id,
          });
          syncToMoesif({
            companyId: req.user.moesif_company_id,
            userId: req.user.moesif_user_id,
            email,
            auth0UserId: req.user.sub,
            stripeCustomerId: provisionedCustomer.stripe_customer_id,
          });
          // Grant the Basic development credit at checkout (a card is now on
          // file). Growth/Enterprise commitments are granted by the Stripe
          // invoice.paid webhook when the commitment invoice is paid.
          if (String(provisionedCustomer.plan_key).toLowerCase() === "basic") {
            try {
              await ensureCreditGrant(result.customer.id, "basic", {
                currency: result.currency || "gbp",
              });
            } catch (grantError) {
              console.error("Failed to create dev credit grant", grantError);
            }
          }

          // Drop any pre-provisioning cache entry so the next request
          // fetches the full canonical context from the SN API.
          invalidatePortalContext(req.user.sub);
          stripeCheckOutSessionInfo.sn_api = {
            user_id: provisionedCustomer.user_id,
            organization_id: provisionedCustomer.organization_id,
            api_key_created: provisionedCustomer.api_key_created,
          };
        }
        // we still pass on result.
        console.log(JSON.stringify(stripeCheckOutSessionInfo));
        res.status(201).json(stripeCheckOutSessionInfo);
      })
      .catch(async (err) => {
        console.error("Error registering user", err);
        const conflict =
          err.status === 409 &&
          typeof err.detail === "string" &&
          err.detail.toLowerCase().includes("already linked");
        if (conflict) {
          // Cannot provision under this identity; cancel the just-created
          // subscription so there is no orphaned paid plan.
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
        res.status(500).json({
          message: "Failed to provision user. " + err.toString(),
        });
      });
  }
);

// if you are using customer billing provider
// this should be triggered upon return from successful payment:
// - verify the purchase
// - create subscription object.
// - send the data to moesif.
// - provision the by calling API gateway plugin.
app.post(
  "/register/custom",
  portalAuthMiddleware,
  jsonParser,
  async function (req, res) {
    const customerId = await getUnifiedCustomerId(req.user);
    const email = req.user?.email;
    // verify plans and subscription using your custom billing provider.
    try {
      const { subscription } =
        await customBillingProvider.verifyPurchaseAndCreateSubscription(req, {
          user: req.user,
          ...req.body,
        });

      console.log("custom subscription created", subscription);

      syncToMoesif({
        companyId: customerId,
        userId: customerId,
        email: email,
      });

      sendSubscriptionToMoesif({
        companyId: customerId,
        subscriptionId: subscription.id,
        planId: subscription.plan_id,
        priceId: subscription.price_id,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        metadata: {
          // additional metadata you might want add.
        },
      });

      const user = await provisioningService.provisionUser(
        customerId,
        email,
        subscription.id
      );
      res.status(201).json({ status: "provisioned" });
    } catch (err) {
      console.error("Error registering user", err);
      res.status(500).json({
        message: "Failed to provision user. " + err.toString(),
      });
    }
  }
);

app.get("/stripe/customer", portalAuthMiddleware, function (req, res) {
  const email = req.user?.email;

  getStripeCustomer(email)
    .then((result) => {
      if (result.data && result.data[0]) {
        res.status(200).json(result.data[0]);
      } else {
        res.status(404).json("stripe customer not found");
      }
    })
    .catch((err) => {
      console.error("Error getting customer info from stripe", err);
      res.status(500).json({
        message: "Failed to retrieve customer info from stripe",
      });
    });
});

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
  res.status(error.status || 500).json({
    message: error.message || "API key request failed",
  });
}

app.get("/api-keys", portalAuthMiddleware, async function (req, res) {
  try {
    const [keyData, hasActiveSubscription] = await Promise.all([
      listSnApiKeys(req.user),
      hasActiveStripeSubscription(req.user?.email, req.user),
    ]);
    const normalizedKeyData = Array.isArray(keyData)
      ? { keys: keyData, active_count: keyData.length, max_active_keys: 2 }
      : keyData;
    res.status(200).json({
      ...normalizedKeyData,
      has_active_subscription: hasActiveSubscription,
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

app.post("/create-key", portalAuthMiddleware, requireActiveSubscription, jsonParser, async function (req, res) {
  try {
    const apiKey = await createSnApiKey(req.user, {
      name: req.body?.name || "API key",
      description: req.body?.description,
    });
    res.status(200).send({ apikey: apiKey.api_key });
  } catch (error) {
    sendKeyManagementError(res, error);
  }
});

app.get(
  "/embed-charts(/:authUserId)",
  portalAuthMiddleware,
  async function (req, res) {
    // if authMiddleware is enabled, the data for user should come from the auth data.
    // otherwise use query param.
    const email = req.user?.email;

    // depends your data model (see assumptions in DATA_MODEL.md),
    // and if in your API gateway if you identifyUser using stripeCustomerId
    // or the userId from authorization provider.
    // Perhaps, you have your own userId for your own system.
    // the most important aspect is the user_id used in your identifyUser hook
    try {
      const companyId = req.user?.moesif_company_id;
      if (!companyId) {
        console.error("Canonical company ID not found when fetching for " + email);
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
