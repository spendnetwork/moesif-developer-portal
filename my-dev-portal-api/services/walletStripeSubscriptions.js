const crypto = require("node:crypto");

const TYPE = "wallet_subscription";
const AMOUNTS = { basic: 0, growth: 500000, enterprise: 1200000 };
const id = value => typeof value === "string" ? value : value?.id;
const enabled = () => process.env.STRIPE_WALLET_SUBSCRIPTIONS_ENABLED === "true";
const fail = (code, message, status = 409) => {
  throw Object.assign(new Error(message), { code, status });
};

async function catalogPrice(plan, deps) {
  const priceId = process.env[`STRIPE_WALLET_${plan.toUpperCase()}_PRICE_ID`];
  if (!/^price_[A-Za-z0-9_]+$/.test(priceId || "")) {
    fail("subscription_price_not_configured", "The Stripe subscription price has not been configured. Contact our team.", 503);
  }
  const price = await deps.stripe.prices.retrieve(priceId, { expand: ["product"] });
  validatePrice(price, plan);
  if (!price.active || !price.product?.active) fail("subscription_price_not_configured", "The configured Stripe price or product is archived.", 503);
  return price;
}

function validatePrice(price, plan) {
  if (!Object.hasOwn(AMOUNTS, plan) || price?.currency !== "gbp" || price.type !== "recurring" ||
      price.unit_amount !== AMOUNTS[plan] || price.billing_scheme !== "per_unit" || price.transform_quantity ||
      price.recurring?.usage_type !== "licensed" || price.recurring?.interval_count !== 1 ||
      (plan === "basic" ? !["month", "year"].includes(price.recurring.interval) : price.recurring.interval !== "year")) {
    fail("invalid_subscription_price", "Use a GBP fixed recurring price: Basic GBP 0, Growth GBP 5,000/year or Enterprise GBP 12,000/year. Metered prices cannot fund this prepaid wallet.", 503);
  }
}

async function openSubscriptions(customer, deps) {
  const result = await deps.stripe.subscriptions.list({ customer, status: "all", limit: 100 });
  if (result.has_more) fail("subscription_review_required", "This account needs a subscription review.");
  return result.data.filter(sub => !["canceled", "incomplete_expired"].includes(sub.status));
}

async function createCheckout(user, purchase, context, deps) {
  const kind = purchase.purchase_kind;
  const plan = kind === "credit" ? "basic" : kind;
  let price;
  const customer = await deps.getOrCreateStripeCustomerId(user.email, user);
  let { subscription: binding } = await deps.getWalletCardSubscription(user);
  const open = await openSubscriptions(customer, deps);
  const existing = binding?.stripe_subscription_id && open.find(sub => sub.id === binding.stripe_subscription_id);
  if (open.some(sub => sub.metadata?.wallet_purchase_id !== purchase.request_id && sub.id !== existing?.id)) {
    fail("card_subscription_exists", "An existing Stripe subscription needs review before another can be created.");
  }
  if (binding?.stripe_subscription_id && !existing) {
    const latest = await deps.stripe.subscriptions.retrieve(binding.stripe_subscription_id);
    if (["canceled", "incomplete_expired"].includes(latest.status) && id(latest.customer) === customer) {
      await deps.syncWalletCardSubscription({ request_id: binding.request_id, stripe_subscription_id: latest.id,
        stripe_customer_id: customer, state: "closed" });
      binding = null;
    }
  }
  // Top-ups preserve the existing subscription and discounted-pricing term.
  if (kind === "credit" && binding?.status === "active" && existing && binding.request_id !== purchase.request_id) {
    return createTopUp(user, purchase, customer, binding.plan_key, deps);
  }
  if (kind !== "credit" && binding?.plan_key === "basic" && existing) {
    // Replacing the free Basic subscription cannot forfeit paid credit or
    // trigger an invoice. The paid tier still starts only on cleared payment.
    const verified = await verifySubscription(existing, deps, user);
    if (!verified || verified.meta.plan_key !== "basic") fail("card_subscription_mismatch", "The Basic subscription needs review.");
    price = await catalogPrice(plan, deps);
    await deps.stripe.subscriptions.cancel(existing.id, { invoice_now: false, prorate: false });
    await deps.syncWalletCardSubscription({ request_id: binding.request_id, stripe_subscription_id: existing.id,
      stripe_customer_id: customer, state: "closed" });
    binding = null;
  }
  if (binding && binding.request_id !== purchase.request_id) {
    fail("card_subscription_exists", "A card subscription or checkout already exists. Resume it, or contact our team to change it before purchasing another plan.");
  }
  if (kind === "credit" && ["growth", "enterprise", "test"].includes(context.current_plan_key)) {
    if (open.length) fail("card_subscription_exists", "Your existing subscription needs review.");
    return createTopUp(user, purchase, customer, "basic", deps);
  }
  price ||= await catalogPrice(plan, deps);
  await deps.reserveWalletCardSubscription({ request_id: purchase.request_id, auth0_user_id: user.sub,
    stripe_customer_id: customer, price_id: price.id, plan_key: plan });
  await deps.updateStripeCustomerIdentity(customer, { moesifUserId: context.user_id,
    moesifCompanyId: context.organization_id, auth0UserId: user.sub });
  const metadata = { purchase_type: TYPE, wallet_purchase_id: purchase.request_id,
    auth0_user_id: user.sub, organization_id: String(context.organization_id), plan_key: plan,
    wallet_price_id: price.id, amount_gbp_pence: String(purchase.amount_gbp_pence) };
  const items = [{ price: price.id, quantity: 1 }];
  if (plan === "basic") items.push({ price_data: { currency: "gbp", unit_amount: purchase.amount_gbp_pence, product: id(price.product) }, quantity: 1 });
  const session = await deps.stripe.checkout.sessions.create({
    mode: "subscription", customer, client_reference_id: user.sub, payment_method_types: ["card"],
    metadata, subscription_data: { metadata }, line_items: items,
    success_url: `${deps.frontendOrigin}/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${deps.frontendOrigin}/credit${kind === "credit" ? "?" : `?package=${kind}&`}cancelled=1`,
    allow_promotion_codes: false, automatic_tax: { enabled: false },
  }, { idempotencyKey: `wallet-card-${crypto.createHash("sha256").update(`${user.sub}:${purchase.request_id}`).digest("hex")}` });
  if (session.status === "expired") {
    await deps.syncWalletCardSubscription({ request_id: purchase.request_id, stripe_customer_id: customer, state: "closed" });
    fail("card_checkout_closed", "This checkout expired without payment. Start a new purchase.");
  }
  if (session.status === "complete") return (await reconcileCheckout(session, user, deps)).purchase;
  return { ...purchase, checkoutUrl: session.url };
}

async function createTopUp(user, purchase, customer, plan, deps) {
  const price = await catalogPrice(plan, deps);
  const metadata = { purchase_type: "wallet_credit", wallet_purchase_id: purchase.request_id,
    auth0_user_id: user.sub, organization_id: String(purchase.organization_id), amount_gbp_pence: String(purchase.amount_gbp_pence) };
  const session = await deps.stripe.checkout.sessions.create({ mode: "payment", customer,
    client_reference_id: user.sub, payment_method_types: ["card"], metadata, payment_intent_data: { metadata },
    line_items: [{ price_data: { currency: "gbp", unit_amount: purchase.amount_gbp_pence, product: id(price.product) }, quantity: 1 }],
    success_url: `${deps.frontendOrigin}/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${deps.frontendOrigin}/credit?cancelled=1`,
  }, { idempotencyKey: `wallet-card-${crypto.createHash("sha256").update(`${user.sub}:${purchase.request_id}`).digest("hex")}` });
  return { ...purchase, checkoutUrl: session.url };
}

function subscriptionId(invoice) {
  return id(invoice.parent?.subscription_details?.subscription || invoice.subscription);
}

async function verifySubscription(sub, deps, user = null) {
  if (sub.metadata?.purchase_type !== TYPE) return null;
  const meta = sub.metadata;
  if (!meta.auth0_user_id || (user && user.sub !== meta.auth0_user_id) || !Object.hasOwn(AMOUNTS, meta.plan_key) ||
      sub.items?.has_more || sub.items?.data?.length !== 1 || sub.items.data[0].quantity !== 1 ||
      id(sub.items.data[0].price) !== meta.wallet_price_id) fail("card_subscription_mismatch", "The subscription could not be verified.");
  // A deployment or archived catalogue price must not change old invoices.
  const price = await deps.stripe.prices.retrieve(meta.wallet_price_id);
  validatePrice(price, meta.plan_key);
  const customer = await deps.stripe.customers.retrieve(id(sub.customer));
  const context = await deps.getSnApiPortalContext({ sub: meta.auth0_user_id });
  if (customer.deleted || customer.metadata?.authUserId !== meta.auth0_user_id ||
      String(context.organization_id) !== meta.organization_id) fail("organization_identity_mismatch", "Subscription account mismatch.");
  const purchase = await deps.getWalletPurchase({ sub: meta.auth0_user_id }, meta.wallet_purchase_id);
  if (!purchase || purchase.organization_id !== context.organization_id || purchase.payment_provider !== "stripe" ||
      purchase.purchase_kind !== (meta.plan_key === "basic" ? "credit" : meta.plan_key) ||
      String(purchase.amount_gbp_pence) !== meta.amount_gbp_pence) fail("card_subscription_mismatch", "Subscription purchase mismatch.");
  return { meta, customer, context, purchase, price };
}

async function reconcileInvoice(invoiceId, deps, user = null) {
  const invoice = await deps.stripe.invoices.retrieve(invoiceId);
  const sid = subscriptionId(invoice);
  if (!sid) return { handled: false };
  const sub = await deps.stripe.subscriptions.retrieve(sid);
  const verified = await verifySubscription(sub, deps, user);
  if (!verified) return { handled: false };
  const { meta, customer, price } = verified;
  if (invoice.status !== "paid") fail("checkout_payment_pending", "Payment is still pending.");
  const initial = invoice.billing_reason === "subscription_create";
  const amount = meta.plan_key === "basic" ? (initial ? verified.purchase.amount_gbp_pence : 0) : AMOUNTS[meta.plan_key];
  const lines = invoice.lines?.data || [];
  const linePrice = line => id(line.pricing?.price_details?.price || line.price);
  const recurring = lines.filter(line => linePrice(line) === price.id);
  if (!["subscription_create", "subscription_cycle"].includes(invoice.billing_reason) ||
      id(invoice.customer) !== customer.id || invoice.currency !== "gbp" || invoice.collection_method !== "charge_automatically" ||
      invoice.total !== amount || invoice.amount_paid !== amount || invoice.amount_due !== amount || invoice.amount_remaining !== 0 ||
      invoice.paid_out_of_band || invoice.starting_balance || invoice.ending_balance ||
      invoice.pre_payment_credit_notes_amount || invoice.post_payment_credit_notes_amount ||
      invoice.lines?.has_more || lines.length !== (initial && meta.plan_key === "basic" ? 2 : 1) ||
      recurring.length !== 1 || recurring[0].amount !== AMOUNTS[meta.plan_key] ||
      lines.some(line => line.quantity !== 1 || line.proration || line.parent?.subscription_item_details?.proration) ||
      !Number.isSafeInteger(invoice.status_transitions?.paid_at)) {
    fail("subscription_invoice_mismatch", "The paid invoice does not match the prepaid subscription. Contact our team.");
  }
  if (!amount) return { handled: true, no_credit: true };
  // A marked-paid invoice or Stripe account balance is not a new card payment.
  const payments = await deps.stripe.invoicePayments.list({ invoice: invoice.id, status: "paid", limit: 100 });
  if (payments.has_more || payments.data.length !== 1 || payments.data[0].payment?.type !== "payment_intent" ||
      payments.data[0].amount_paid !== amount || payments.data[0].currency !== "gbp") {
    fail("subscription_payment_unverified", "A cleared card payment is required.");
  }
  const payment = await deps.stripe.paymentIntents.retrieve(id(payments.data[0].payment.payment_intent), { expand: ["latest_charge"] });
  if (id(payment.customer) !== customer.id || payment.status !== "succeeded" || payment.currency !== "gbp" ||
      payment.amount_received !== amount || !payment.latest_charge?.paid || payment.latest_charge.refunded ||
      payment.latest_charge.amount_refunded > 0 || payment.latest_charge.disputed) {
    fail("subscription_payment_unverified", "The subscription payment could not be verified.");
  }
  const result = await deps.settleWalletSubscriptionInvoice({ request_id: meta.wallet_purchase_id,
    stripe_subscription_id: sub.id, stripe_customer_id: customer.id, price_id: price.id,
    invoice_id: invoice.id, billing_reason: invoice.billing_reason, amount_gbp_pence: amount,
    paid_at: new Date(invoice.status_transitions.paid_at * 1000).toISOString() });
  return { handled: true, status: "complete", purchase_type: "wallet_credit", plan_key: result.receipt?.plan_key, purchase: result };
}

async function reconcileCheckout(session, user, deps) {
  if (session.metadata?.purchase_type !== TYPE || session.mode !== "subscription" || session.status !== "complete" ||
      session.payment_status !== "paid" || !id(session.invoice) || !id(session.subscription) ||
      (user && session.client_reference_id !== user.sub)) fail("checkout_payment_pending", "The subscription payment is not yet confirmed.");
  const invoice = await deps.stripe.invoices.retrieve(id(session.invoice));
  if (subscriptionId(invoice) !== id(session.subscription)) fail("card_subscription_mismatch", "Checkout subscription mismatch.");
  return reconcileInvoice(invoice.id, deps, user);
}

async function handleEvent(event, deps) {
  const object = event.data.object;
  if (["charge.refunded", "charge.dispute.created"].includes(event.type)) {
    const paymentId = id(object.payment_intent);
    if (!paymentId) return { handled: false };
    const intent = await deps.stripe.paymentIntents.retrieve(paymentId);
    if (intent.metadata?.purchase_type === "wallet_credit") return { handled: false };
    const payments = await deps.stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: paymentId }, limit: 100 });
    if (payments.has_more) fail("subscription_review_required", "Payment allocation needs review.");
    let handled = false;
    for (const payment of payments.data) {
      const invoice = await deps.stripe.invoices.retrieve(id(payment.invoice));
      const sid = subscriptionId(invoice);
      if (!sid) continue;
      const sub = await deps.stripe.subscriptions.retrieve(sid);
      const verified = await verifySubscription(sub, deps);
      if (!verified) continue;
      await deps.reviewWalletSubscriptionPayment({ request_id: verified.meta.wallet_purchase_id,
        stripe_subscription_id: sub.id, stripe_customer_id: id(sub.customer), invoice_id: invoice.id,
        event_id: event.id, reason: event.type });
      handled = true;
    }
    return { handled };
  }
  if (event.type === "invoice.paid") return reconcileInvoice(object.id, deps);
  if (event.type.startsWith("customer.subscription.")) {
    const sub = await deps.stripe.subscriptions.retrieve(object.id);
    if (sub.metadata?.purchase_type !== TYPE) return { handled: false };
    const verified = await verifySubscription(sub, deps);
    await deps.syncWalletCardSubscription({ request_id: verified.meta.wallet_purchase_id,
      stripe_subscription_id: sub.id, stripe_customer_id: id(sub.customer),
      state: ["canceled", "incomplete_expired"].includes(sub.status) ? "closed" : "active" });
    return { handled: true };
  }
  if (event.type === "invoice.payment_failed") {
    const sid = subscriptionId(object);
    const sub = sid && await deps.stripe.subscriptions.retrieve(sid);
    return { handled: sub?.metadata?.purchase_type === TYPE };
  }
  if (event.type === "checkout.session.expired" && object.metadata?.purchase_type === TYPE) {
    const session = await deps.stripe.checkout.sessions.retrieve(object.id);
    if (session.status !== "expired" || session.subscription) fail("card_checkout_not_expired", "Checkout still requires reconciliation.");
    await deps.syncWalletCardSubscription({ request_id: session.metadata.wallet_purchase_id,
      stripe_customer_id: id(session.customer), state: "closed" });
    return { handled: true };
  }
  return { handled: false };
}

module.exports = { TYPE, enabled, createCheckout, reconcileCheckout, reconcileInvoice, handleEvent, validatePrice };
