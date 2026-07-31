function stripeId(value) {
  return typeof value === "string" ? value : value?.id;
}

function prepaidError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isBasicTopUpSession(session) {
  return session?.metadata?.purchase_type === "basic_credit_top_up";
}

function prepaidSubscriptionPeriodEnd(now = new Date()) {
  const periodEnd = new Date(now);
  periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 49);
  return periodEnd.toISOString();
}

function validateBasicMeteredPrices(prices) {
  const meteredPrices = prices?.meteredPrices || [];
  const priceIds = new Set(meteredPrices.map((price) => price.id).filter(Boolean));
  const meterIds = new Set(
    meteredPrices.map((price) => price.recurring?.meter).filter(Boolean)
  );
  if (
    prices?.commitmentPrices?.length ||
    meteredPrices.length !== 4 ||
    priceIds.size !== 4 ||
    meterIds.size !== 4
  ) {
    throw prepaidError(
      "basic_price_configuration_invalid",
      "Basic requires exactly four active metered prices, each linked to a different Stripe billing meter"
    );
  }
  return meteredPrices;
}

async function reconcileBasicTopUp(sessionOrId, authUser, deps) {
  const sessionId = stripeId(sessionOrId);
  const session = sessionId
    ? await deps.verifyStripeSession(sessionId)
    : sessionOrId;
  if (!isBasicTopUpSession(session)) {
    throw prepaidError(
      "not_basic_top_up",
      "Checkout session is not a Basic credit purchase"
    );
  }
  if (session.status !== "complete") {
    throw prepaidError("checkout_incomplete", "Checkout is not complete");
  }
  if (session.payment_status !== "paid") {
    throw prepaidError(
      "checkout_payment_pending",
      "Basic credit payment has not completed"
    );
  }

  const amountPence = Number.parseInt(
    session.metadata?.amount_gbp_pence || "",
    10
  );
  if (
    !Number.isSafeInteger(amountPence) ||
    amountPence <= 0 ||
    session.amount_total !== amountPence ||
    String(session.currency || "").toLowerCase() !== "gbp"
  ) {
    throw prepaidError(
      "top_up_amount_mismatch",
      "The paid amount does not match the Basic credit purchase"
    );
  }

  const customerId = stripeId(session.customer);
  const planId = session.metadata?.plan_id;
  if (!customerId || !planId) {
    throw prepaidError(
      "top_up_identity_missing",
      "Basic credit purchase is missing its customer or plan"
    );
  }
  const customer =
    typeof session.customer === "object"
      ? session.customer
      : await deps.getStripeCustomerById(customerId);
  const auth0UserId =
    authUser?.sub ||
    session.client_reference_id ||
    session.metadata?.auth0_user_id ||
    customer.metadata?.authUserId;
  const email = authUser?.email || customer.email || session.customer_details?.email;
  if (!auth0UserId || !email) {
    throw prepaidError(
      "top_up_identity_missing",
      "Basic credit purchase is missing its authenticated identity"
    );
  }
  if (
    authUser?.sub &&
    session.client_reference_id &&
    authUser.sub !== session.client_reference_id
  ) {
    throw prepaidError(
      "stripe_customer_identity_mismatch",
      "Checkout belongs to a different authenticated account"
    );
  }
  if (
    customer.email &&
    customer.email.toLowerCase() !== email.toLowerCase()
  ) {
    throw prepaidError(
      "stripe_customer_identity_mismatch",
      "Stripe customer does not match the authenticated email"
    );
  }

  const [product, prices, planKey] = await Promise.all([
    deps.getStripeProduct(planId),
    deps.getPlanPrices(planId),
    deps.getPlanKeyForProduct(planId),
  ]);
  if (planKey !== "basic") {
    throw prepaidError(
      "invalid_top_up_plan",
      "Credit purchase does not belong to the Basic plan"
    );
  }
  const meteredPrices = validateBasicMeteredPrices(prices);

  const identity = {
    sub: auth0UserId,
    email,
    name: authUser?.name || authUser?.nickname || customer.name || email,
  };
  let existingContext = null;
  if (deps.getSnApiPortalContext) {
    try {
      existingContext = await deps.getSnApiPortalContext(identity);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const hasActiveBasicAccess =
    existingContext?.current_plan_key === "basic" &&
    existingContext?.billing_status === "active";

  // Create the canonical SN API identity first, but keep API access blocked
  // until both the Moesif subscription and its paid credit exist. Existing
  // Basic customers remain active while adding more credit.
  const pendingProvision = await deps.provisionSnApiPrepaidCustomer({
    authUser: identity,
    customer,
    product,
    subscriptionStatus: hasActiveBasicAccess ? "active" : "provisioning",
  });
  const companyId = String(
    pendingProvision.moesif_company_id || pendingProvision.organization_id
  );
  await deps.updateStripeCustomerIdentity(customerId, {
    moesifUserId: pendingProvision.user_id,
    moesifCompanyId: companyId,
    auth0UserId,
    subscriptionId: null,
  });
  await deps.syncToMoesif({
    companyId,
    userId: String(pendingProvision.user_id),
    email,
    auth0UserId,
    stripeCustomerId: customerId,
    planKey: "basic",
  });
  const subscriptionId = await deps.sendPrepaidSubscriptionToMoesif({
    companyId,
    stripeCustomerId: customerId,
    planId,
    priceIds: meteredPrices.map((price) => price.id),
    currentPeriodStart: new Date(
      (customer.created || session.created || Math.floor(Date.now() / 1000)) *
        1000
    ).toISOString(),
    currentPeriodEnd: prepaidSubscriptionPeriodEnd(),
  });
  const transactionId = stripeId(session.payment_intent) || session.id;
  await deps.createMoesifBalanceTransaction({
    companyId,
    subscriptionId,
    amountGbp: amountPence / 100,
    transactionId,
    description: `Open Opportunities Basic top-up from ${session.id}`,
  });
  const provisioned = await deps.provisionSnApiPrepaidCustomer({
    authUser: identity,
    customer,
    product,
    subscriptionStatus: "active",
  });
  await deps.markBasicTopUpReconciled(transactionId, {
    companyId,
    subscriptionId,
  });

  return {
    active: true,
    purchaseType: "basic_credit_top_up",
    customer,
    planKey,
    amountPence,
    moesifSubscriptionId: subscriptionId,
    provisioned,
  };
}

module.exports = {
  isBasicTopUpSession,
  prepaidError,
  prepaidSubscriptionPeriodEnd,
  reconcileBasicTopUp,
  validateBasicMeteredPrices,
};
