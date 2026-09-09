const crypto = require("crypto");
const { isBasicCreditSession } = require("./basicPurchasePolicy");

function stripeId(value) {
  return typeof value === "string" ? value : value?.id;
}

function prepaidError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
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

async function reconcileBasicCreditPurchase(sessionOrId, authUser, deps) {
  const sessionId = stripeId(sessionOrId);
  if (!sessionId) {
    throw prepaidError("checkout_session_required", "A Stripe Checkout Session ID is required");
  }
  // Both signed webhooks and browser returns re-read Stripe. Neither supplies credit data.
  const session = await deps.verifyStripeSession(sessionId);
  if (!isBasicCreditSession(session)) {
    throw prepaidError(
      "not_basic_credit_purchase",
      "Checkout session is not a Basic credit purchase"
    );
  }
  const purchaseType = session.metadata.purchase_type;
  if (session.status !== "complete") {
    throw prepaidError("checkout_incomplete", "Checkout is not complete");
  }
  if (session.payment_status !== "paid") {
    throw prepaidError(
      "checkout_payment_pending",
      "Basic credit payment has not completed"
    );
  }
  if (session.mode !== "payment" || session.subscription) {
    throw prepaidError("invalid_basic_checkout_mode", "Basic requires a one-off payment");
  }

  const amountPence = Number(session.metadata?.amount_gbp_pence);
  if (
    !Number.isSafeInteger(amountPence) ||
    amountPence <= 0 || amountPence > 2147483647 ||
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
  const transactionId = stripeId(session.payment_intent);
  const payment = session.payment_intent;
  const lineItems = session.line_items?.data;
  if (!transactionId || typeof payment !== "object" ||
      payment.status !== "succeeded" || payment.amount_received !== amountPence ||
      String(payment.currency).toLowerCase() !== "gbp" ||
      stripeId(payment.customer) !== customerId ||
      !Array.isArray(lineItems) || lineItems.length !== 1 ||
      session.line_items.has_more || lineItems[0].quantity !== 1 ||
      lineItems[0].amount_total !== amountPence ||
      stripeId(lineItems[0].price?.product) !== planId) {
    throw prepaidError("basic_payment_verification_failed", "Stripe payment details do not match this credit purchase");
  }
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
  const linkedIdentities = [authUser?.sub, session.client_reference_id,
    session.metadata?.auth0_user_id, customer.metadata?.authUserId].filter(Boolean);
  if (new Set(linkedIdentities).size !== 1) {
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

  const planKey = await deps.getPlanKeyForProduct(planId);
  if (planKey !== "basic") {
    throw prepaidError(
      "invalid_top_up_plan",
      "Credit purchase does not belong to the Basic plan"
    );
  }
  // Capture the original expected plan in Checkout metadata. Never derive retry
  // payloads from mutable current context: API operations are immutable receipts.
  const expected = session.metadata.expected_current_plan_key;
  const expectedPlan = expected === "none" ? null : expected ||
    (purchaseType === "basic_credit_top_up" ? "basic" : null);
  if (![null, "development", "basic"].includes(expectedPlan)) {
    throw prepaidError("basic_plan_conflict", "This checkout cannot replace a commitment plan");
  }
  const provisioned = await deps.provisionSnApiLocalPrepaidCustomer({
    request_id: `basic-${crypto.createHash("sha256").update(transactionId).digest("hex").slice(0, 48)}`,
    auth0_user_id: auth0UserId,
    plan_key: "basic",
    expected_current_plan_key: expectedPlan,
    requested_by: "stripe_checkout",
    stripe_customer_id: customerId,
  });
  if (provisioned?.plan_key !== "basic" || !provisioned.subscription_id ||
      provisioned.debit_owner !== "api") {
    throw prepaidError("prepaid_provision_invalid", "API prepaid setup did not return a local Basic ledger");
  }
  const credit = await deps.registerSnApiPaidCredit({
    auth0_user_id: auth0UserId,
    subscription_id: provisioned.subscription_id,
    stripe_customer_id: customerId,
    stripe_payment_intent_id: transactionId,
    amount_gbp_pence: amountPence,
    currency: "GBP",
  });
  if (credit?.subscription_id !== provisioned.subscription_id ||
      credit.amount_gbp_pence !== amountPence ||
      credit.source_reference !== `stripe_payment_intent:${transactionId}`) {
    throw prepaidError("paid_credit_receipt_invalid", "API paid credit confirmation is incomplete");
  }

  return {
    purchaseType,
    customer,
    planKey,
    amountPence,
    subscriptionId: provisioned.subscription_id,
    credit,
    provisioned,
  };
}

module.exports = {
  prepaidError,
  prepaidSubscriptionPeriodEnd,
  reconcileBasicCreditPurchase,
  validateBasicMeteredPrices,
};
