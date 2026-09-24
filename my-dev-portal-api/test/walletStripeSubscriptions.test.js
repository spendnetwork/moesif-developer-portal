const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const subscriptions = require("../services/walletStripeSubscriptions");
const { createPurchase } = require("../services/walletPayments");

for (const plan of ["basic", "growth", "enterprise"]) process.env[`STRIPE_WALLET_${plan.toUpperCase()}_PRICE_ID`] = `price_${plan}`;

function fixture(plan = "growth") {
  const amounts = { basic: 0, growth: 500000, enterprise: 1200000 };
  const user = { sub: "auth0|subscription", email: "customer@example.test" };
  const context = { organization_id: 17, user_id: 12, current_plan_key: "basic" };
  const purchase = { request_id: crypto.randomUUID(), organization_id: 17, payment_provider: "stripe",
    purchase_kind: plan === "basic" ? "credit" : plan, amount_gbp_pence: amounts[plan] || 5000, status: "awaiting_payment" };
  const price = { id: `price_${plan}`, active: true, product: { id: `prod_${plan}`, active: true }, currency: "gbp",
    type: "recurring", unit_amount: amounts[plan], billing_scheme: "per_unit",
    recurring: { usage_type: "licensed", interval: plan === "basic" ? "month" : "year", interval_count: 1 } };
  const sub = { id: "sub_wallet", customer: "cus_wallet", status: "active", metadata: {
    purchase_type: subscriptions.TYPE, wallet_purchase_id: purchase.request_id, auth0_user_id: user.sub,
    organization_id: "17", plan_key: plan, wallet_price_id: price.id, amount_gbp_pence: String(purchase.amount_gbp_pence),
  }, items: { data: [{ price, quantity: 1 }], has_more: false } };
  const customer = { id: "cus_wallet", metadata: { authUserId: user.sub } };
  const invoice = { id: "in_wallet", parent: { subscription_details: { subscription: sub.id } }, customer: customer.id,
    billing_reason: "subscription_create", status: "paid", collection_method: "charge_automatically", currency: "gbp",
    total: purchase.amount_gbp_pence, amount_paid: purchase.amount_gbp_pence, amount_due: purchase.amount_gbp_pence, amount_remaining: 0,
    status_transitions: { paid_at: 1789500000 }, lines: { has_more: false,
      data: [{ pricing: { price_details: { price: price.id } }, amount: amounts[plan], quantity: 1 }] } };
  if (plan === "basic") invoice.lines.data.push({ pricing: { price_details: { price: "price_topup" } }, amount: 5000, quantity: 1 });
  const payment = { id: "pi_wallet", customer: customer.id, status: "succeeded", currency: "gbp", amount_received: purchase.amount_gbp_pence,
    latest_charge: { paid: true, refunded: false, amount_refunded: 0, disputed: false } };
  const payments = { has_more: false, data: [{ payment: { type: "payment_intent", payment_intent: payment.id },
    amount_paid: purchase.amount_gbp_pence, currency: "gbp", invoice: invoice.id }] };
  const calls = [];
  const deps = {
    frontendOrigin: "https://developers.example.test",
    getOrCreateStripeCustomerId: async () => customer.id,
    updateStripeCustomerIdentity: async () => {},
    getSnApiPortalContext: async () => context,
    getWalletCardSubscription: async () => ({ subscription: null }),
    getWalletPurchase: async () => purchase,
    reserveWalletCardSubscription: async body => calls.push(["reserve", body]),
    syncWalletCardSubscription: async body => calls.push(["state", body]),
    settleWalletSubscriptionInvoice: async body => { calls.push(["settle", body]); return { receipt: { plan_key: plan } }; },
    reviewWalletSubscriptionPayment: async body => calls.push(["review", body]),
    stripe: {
      prices: { retrieve: async () => price }, customers: { retrieve: async () => customer },
      subscriptions: { list: async () => ({ data: [], has_more: false }), retrieve: async () => sub,
        cancel: async sid => calls.push(["cancel", sid]) },
      invoices: { retrieve: async () => invoice }, invoicePayments: { list: async () => payments },
      paymentIntents: { retrieve: async () => payment },
      checkout: { sessions: { create: async (...args) => { calls.push(["checkout", ...args]); return { url: "https://checkout.stripe.com/test" }; } } },
    },
  };
  return { plan, user, context, purchase, price, sub, customer, invoice, payment, payments, calls, deps };
}

for (const plan of ["basic", "growth", "enterprise"]) {
  test(`${plan}: checkout uses the existing licensed Stripe price, not usage prices`, async () => {
    const f = fixture(plan);
    await subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps);
    await subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps);
    const requests = f.calls.filter(call => call[0] === "checkout");
    assert.deepEqual(requests[0], requests[1]);
    const body = requests[0][1];
    assert.equal(body.mode, "subscription");
    assert.deepEqual(body.line_items[0], { price: f.price.id, quantity: 1 });
    assert.equal(body.line_items.length, plan === "basic" ? 2 : 1);
    if (plan === "basic") assert.equal(body.line_items[1].price_data.product, "prod_basic");
    assert.equal(body.subscription_data.metadata.purchase_type, subscriptions.TYPE);
    assert.equal(f.calls.filter(call => call[0] === "settle").length, 0);
  });
  test(`${plan}: paid subscription invoice settles with a stable provider receipt`, async () => {
    const f = fixture(plan);
    const first = await subscriptions.reconcileInvoice(f.invoice.id, f.deps, f.user);
    assert.equal(first.handled, true);
    await subscriptions.reconcileInvoice(f.invoice.id, f.deps);
    assert.deepEqual(f.calls[0], f.calls[1]);
    assert.equal(f.calls[0][1].invoice_id, "in_wallet");
    assert.equal(f.calls[0][1].amount_gbp_pence, f.purchase.amount_gbp_pence);
  });
}

test("renewal uses the saved price even after deployment changes the configured ID", async () => {
  const f = fixture();
  f.invoice.billing_reason = "subscription_cycle";
  const before = process.env.STRIPE_WALLET_GROWTH_PRICE_ID;
  process.env.STRIPE_WALLET_GROWTH_PRICE_ID = "price_replacement";
  try {
    await subscriptions.reconcileInvoice(f.invoice.id, f.deps);
    assert.equal(f.calls[0][1].price_id, "price_growth");
    assert.equal(f.calls[0][1].billing_reason, "subscription_cycle");
  } finally { process.env.STRIPE_WALLET_GROWTH_PRICE_ID = before; }
});

test("zero Basic renewal adds no credit and makes no payment lookup", async () => {
  const f = fixture("basic");
  Object.assign(f.invoice, { billing_reason: "subscription_cycle", total: 0, amount_due: 0, amount_paid: 0 });
  f.invoice.lines.data.pop();
  f.deps.stripe.invoicePayments.list = async () => { throw new Error("Unexpected payment lookup"); };
  assert.deepEqual(await subscriptions.reconcileInvoice(f.invoice.id, f.deps), { handled: true, no_credit: true });
  assert.equal(f.calls.length, 0);
});

test("metered, wrong-currency, wrong-amount and wrong-interval prices cannot open checkout", async () => {
  for (const change of [p => p.recurring.usage_type = "metered", p => p.currency = "usd",
    p => p.unit_amount = 499999, p => p.recurring.interval = "month", p => p.active = false, p => p.product.active = false]) {
    const f = fixture(); change(f.price);
    await assert.rejects(subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps));
    assert.equal(f.calls.length, 0);
  }
});

test("unpaid, discounted, manual, refunded, disputed or cross-account invoices never add credit", async () => {
  for (const change of [f => f.invoice.status = "open", f => f.invoice.total = 499999,
    f => f.invoice.paid_out_of_band = true, f => f.invoice.customer = "cus_other",
    f => f.invoice.starting_balance = -5000, f => f.invoice.lines.has_more = true,
    f => f.invoice.lines.data[0].parent = { subscription_item_details: { proration: true } },
    f => f.payment.latest_charge.refunded = true, f => f.payment.latest_charge.disputed = true,
    f => f.payment.latest_charge.amount_refunded = 1, f => f.payment.amount_received = 5,
    f => f.payments.data = [], f => f.payments.data[0].payment.type = "payment_record",
    f => f.customer.metadata.authUserId = "auth0|other", f => f.sub.metadata.organization_id = "99",
    f => f.sub.items.data.push({ price: "price_meter", quantity: 1 }), f => f.purchase.payment_provider = "invoice"]) {
    const f = fixture(); change(f);
    await assert.rejects(subscriptions.reconcileInvoice(f.invoice.id, f.deps));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(subscriptions.reconcileInvoice(f.invoice.id, f.deps, { sub: "other" }));
  assert.equal(f.calls.length, 0);
});

test("existing subscriptions and pending reservations block new competing subscriptions", async () => {
  const f = fixture();
  f.deps.stripe.subscriptions.list = async () => ({ data: [{ id: "sub_old", status: "past_due" }], has_more: false });
  await assert.rejects(subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps), { code: "card_subscription_exists" });
  f.deps.stripe.subscriptions.list = async () => ({ data: [], has_more: false });
  f.deps.getWalletCardSubscription = async () => ({ subscription: { request_id: "different", status: "pending" } });
  await assert.rejects(subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps), { code: "card_subscription_exists" });
  assert.equal(f.calls.length, 0);
});

test("card top-up leaves an existing annual subscription untouched", async () => {
  const f = fixture();
  f.purchase = { ...f.purchase, request_id: crypto.randomUUID(), purchase_kind: "credit", amount_gbp_pence: 5000 };
  f.deps.getWalletCardSubscription = async () => ({ subscription: { request_id: f.sub.metadata.wallet_purchase_id,
    stripe_subscription_id: f.sub.id, status: "active", plan_key: "growth" } });
  f.deps.stripe.subscriptions.list = async () => ({ data: [f.sub], has_more: false });
  await subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].mode, "payment");
  assert.equal(f.calls[0][1].line_items[0].price_data.product, "prod_growth");
});

test("failed renewal and cancellation bypass legacy entitlement revocation", async () => {
  const f = fixture();
  assert.equal((await subscriptions.handleEvent({ type: "invoice.payment_failed", data: { object: f.invoice } }, f.deps)).handled, true);
  assert.equal(f.calls.length, 0);
  f.sub.status = "canceled";
  assert.equal((await subscriptions.handleEvent({ type: "customer.subscription.updated", data: { object: f.sub } }, f.deps)).handled, true);
  assert.equal(f.calls[0][0], "state");
  assert.equal(f.calls[0][1].state, "closed");
});

test("refund and dispute events request a review instead of silently subtracting money", async () => {
  const f = fixture();
  const event = { id: "evt_dispute", type: "charge.dispute.created", data: { object: { payment_intent: f.payment.id } } };
  assert.equal((await subscriptions.handleEvent(event, f.deps)).handled, true);
  assert.equal(f.calls[0][0], "review");
  assert.equal(f.calls[0][1].invoice_id, f.invoice.id);
});

test("expired Checkout releases only a provider-confirmed unpaid reservation", async () => {
  const f = fixture();
  const session = { id: "cs_expired", status: "expired", customer: f.customer.id, metadata: f.sub.metadata };
  f.deps.stripe.checkout.sessions.retrieve = async () => session;
  assert.equal((await subscriptions.handleEvent({ type: "checkout.session.expired", data: { object: session } }, f.deps)).handled, true);
  assert.equal(f.calls[0][1].state, "closed");
  session.status = "complete";
  await assert.rejects(subscriptions.handleEvent({ type: "checkout.session.expired", data: { object: session } }, f.deps));
});

test("rollout mode is persisted in the purchase contract before checkout", async () => {
  const f = fixture();
  process.env.STRIPE_WALLET_SUBSCRIPTIONS_ENABLED = "true";
  f.deps.createWalletPurchase = async body => {
    assert.equal(body.card_checkout_mode, "catalog_subscription");
    return { ...body, status: "awaiting_payment", created_at: new Date().toISOString() };
  };
  try {
    await createPurchase(f.user, { requestId: f.purchase.request_id, purchaseKind: "growth", amountGbp: 5000, paymentMethod: "card" }, f.deps);
    assert.equal(f.calls.find(call => call[0] === "checkout")[1].mode, "subscription");
  } finally { delete process.env.STRIPE_WALLET_SUBSCRIPTIONS_ENABLED; }
});

test("early Basic subscription webhook cannot turn the initial checkout retry into another top-up", async () => {
  const f = fixture("basic");
  f.deps.getWalletCardSubscription = async () => ({ subscription: { request_id: f.purchase.request_id,
    stripe_subscription_id: f.sub.id, plan_key: "basic", status: "active" } });
  f.deps.stripe.subscriptions.list = async () => ({ data: [f.sub], has_more: false });
  await subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps);
  assert.equal(f.calls.find(call => call[0] === "checkout")[1].mode, "subscription");
});

test("expired checkout retry releases its reservation without waiting for another webhook", async () => {
  const f = fixture();
  f.deps.stripe.checkout.sessions.create = async () => ({ status: "expired" });
  await assert.rejects(subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps), { code: "card_checkout_closed" });
  assert.equal(f.calls.at(-1)[0], "state");
  assert.equal(f.calls.at(-1)[1].state, "closed");
});

test("a completed checkout retry reconciles the original invoice", async () => {
  const f = fixture();
  f.deps.stripe.checkout.sessions.create = async () => ({ status: "complete", payment_status: "paid", mode: "subscription",
    client_reference_id: f.user.sub, invoice: f.invoice.id, subscription: f.sub.id, metadata: f.sub.metadata });
  const result = await subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps);
  assert.equal(result.receipt.plan_key, "growth");
  assert.equal(f.calls.filter(call => call[0] === "settle").length, 1);
});

test("Basic can move to an annual subscription without canceling a paid commitment", async () => {
  const basic = fixture("basic");
  const f = fixture("growth");
  f.deps.getWalletCardSubscription = async () => ({ subscription: { request_id: basic.purchase.request_id,
    stripe_subscription_id: basic.sub.id, plan_key: "basic", status: "active" } });
  f.deps.stripe.subscriptions.list = async () => ({ data: [basic.sub], has_more: false });
  f.deps.stripe.prices.retrieve = async priceId => priceId === "price_basic" ? basic.price : f.price;
  f.deps.getWalletPurchase = async () => basic.purchase;
  await subscriptions.createCheckout(f.user, f.purchase, f.context, f.deps);
  assert.equal(f.calls[0][0], "cancel");
  assert.equal(f.calls[1][0], "state");
  assert.equal(f.calls[1][1].state, "closed");
  assert.equal(f.calls.find(call => call[0] === "checkout")[1].line_items[0].price, "price_growth");
});

test("legacy one-off wallet refunds do not require the subscription invoice-payments lookup", async () => {
  const f = fixture();
  f.payment.metadata = { purchase_type: "wallet_credit" };
  f.deps.stripe.invoicePayments.list = async () => { throw new Error("Unexpected subscription lookup"); };
  assert.equal((await subscriptions.handleEvent({ type: "charge.refunded", data: { object: { payment_intent: f.payment.id } } }, f.deps)).handled, false);
});
