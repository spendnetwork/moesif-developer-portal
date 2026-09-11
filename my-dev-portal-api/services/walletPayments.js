const crypto = require("node:crypto");

function failure(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function amountPence(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw failure("invalid_credit_amount", "Enter a valid GBP amount.", 422);
  const pence = Math.round(value * 100);
  if (!Number.isSafeInteger(pence) || pence < 5000 || pence > 2147483647 || Math.abs(pence / 100 - value) > Number.EPSILON * 100) {
    throw failure("invalid_credit_amount", "Purchase at least GBP 50, with no more than two decimal places.", 422);
  }
  return pence;
}

function requestIdentity(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw failure("invalid_request_id", "A UUID request ID is required.", 422);
  }
  return id;
}

async function createPurchase(user, input, deps, actor = null) {
  const id = requestIdentity(input.requestId);
  const kind = input.purchaseKind;
  if (!["credit", "growth", "enterprise"].includes(kind)) throw failure("invalid_purchase_kind", "Choose credit, Growth or Enterprise.", 422);
  const amount = amountPence(input.amountGbp);
  if ((kind === "growth" && amount !== 500000) || (kind === "enterprise" && amount !== 1200000)) {
    throw failure("invalid_package_amount", "Growth is GBP 5,000; Enterprise is GBP 12,000.", 422);
  }
  const context = await deps.getSnApiPortalContext(user);
  const purchase = await deps.createWalletPurchase({
    request_id: id, auth0_user_id: user.sub, organization_id: context.organization_id,
    purchase_kind: kind, payment_provider: amount >= 500000 ? "invoice" : "stripe",
    amount_gbp_pence: amount, requested_by: actor || user.sub,
  });
  if (purchase.status === "paid" || purchase.payment_provider === "invoice") return purchase;
  // Stripe's idempotency retention is finite. An old unconfirmed request must
  // be reconciled, never silently submitted as a fresh card charge.
  if (purchase.created_at && Date.now() - Date.parse(purchase.created_at) > 23 * 60 * 60 * 1000) {
    throw failure("wallet_checkout_review_required", "This checkout needs a payment review. Contact our team before paying again.");
  }
  const customer = await deps.getOrCreateStripeCustomerId(user.email, user);
  const session = await deps.stripe.checkout.sessions.create({
    mode: "payment", customer, client_reference_id: user.sub, payment_method_types: ["card"],
    success_url: `${deps.frontendOrigin}/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${deps.frontendOrigin}/credit?cancelled=1`,
    metadata: { purchase_type: "wallet_credit", wallet_purchase_id: id, auth0_user_id: user.sub,
      organization_id: String(context.organization_id), amount_gbp_pence: String(amount) },
    payment_intent_data: { metadata: { purchase_type: "wallet_credit", wallet_purchase_id: id,
      auth0_user_id: user.sub, organization_id: String(context.organization_id) } },
    line_items: [{ price_data: { currency: "gbp", unit_amount: amount,
      product_data: { name: "Open Opportunities API credit" } }, quantity: 1 }],
  }, { idempotencyKey: `wallet-checkout-${crypto.createHash("sha256").update(`${user.sub}:${id}`).digest("hex")}` });
  return { ...purchase, checkoutUrl: session.url };
}

async function reconcilePayment(sessionId, user, deps) {
  const session = await deps.stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent.latest_charge", "customer", "line_items"],
  });
  if (session.metadata?.purchase_type !== "wallet_credit" || session.mode !== "payment" || session.subscription || session.status !== "complete") {
    throw failure("invalid_wallet_checkout", "This is not a completed wallet purchase.");
  }
  if (session.payment_status !== "paid") throw failure("checkout_payment_pending", "Payment is still pending.");
  const payment = session.payment_intent;
  const customer = session.customer;
  const sub = session.metadata.auth0_user_id;
  const amount = Number(session.metadata.amount_gbp_pence);
  if (!sub || (user && user.sub !== sub) || session.client_reference_id !== sub || customer?.metadata?.authUserId !== sub ||
      !Number.isSafeInteger(amount) || amount < 5000 || amount >= 500000 ||
      session.amount_total !== amount || session.currency !== "gbp" || payment?.status !== "succeeded" ||
      payment.amount_received !== amount || payment.currency !== "gbp" ||
      (typeof payment.customer === "string" ? payment.customer : payment.customer?.id) !== customer.id ||
      !payment.latest_charge?.paid || payment.latest_charge.refunded || payment.latest_charge.disputed ||
      !Number.isSafeInteger(payment.latest_charge.created) ||
      session.line_items?.has_more || session.line_items?.data?.length !== 1 ||
      session.line_items.data[0].quantity !== 1 || session.line_items.data[0].amount_total !== amount) {
    throw failure("wallet_payment_verification_failed", "The payment could not be matched to this account.");
  }
  const context = await deps.getSnApiPortalContext({ sub });
  if (String(context.organization_id) !== session.metadata.organization_id) throw failure("organization_identity_mismatch", "Payment account mismatch.");
  const result = await deps.confirmWalletPayment(requestIdentity(session.metadata.wallet_purchase_id), {
    organization_id: context.organization_id, payment_reference: payment.id,
    stripe_customer_id: customer.id, amount_gbp_pence: amount, currency: "GBP",
    paid_at: new Date(payment.latest_charge.created * 1000).toISOString(), confirmed_by: "stripe_verified_payment",
  });
  return { status: "complete", plan_key: result.receipt?.plan_key, purchase_type: "wallet_credit", purchase: result };
}

async function reviewPaymentEvent(event, deps) {
  const paymentId = event.data.object.payment_intent;
  if (!paymentId) return;
  const payment = await deps.stripe.paymentIntents.retrieve(typeof paymentId === "string" ? paymentId : paymentId.id);
  if (payment.metadata?.purchase_type !== "wallet_credit") return;
  const context = await deps.getSnApiPortalContext({ sub: payment.metadata.auth0_user_id });
  if (String(context.organization_id) !== payment.metadata.organization_id) throw failure("payment_identity_mismatch", "Payment account mismatch.");
  return deps.flagWalletPaymentReview({ organization_id: context.organization_id,
    request_id: requestIdentity(payment.metadata.wallet_purchase_id), stripe_customer_id: typeof payment.customer === "string" ? payment.customer : payment.customer.id,
    payment_reference: payment.id, event_id: event.id, reason: event.type });
}

module.exports = { createPurchase, reconcilePayment, reviewPaymentEvent, amountPence, requestIdentity };
