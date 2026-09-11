const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createPurchase, reconcilePayment, reviewPaymentEvent, amountPence } = require("../services/walletPayments");
const user = { sub: "auth0|wallet", email: "wallet@example.test" };

function setup() {
  const id = crypto.randomUUID();
  const calls = [];
  const session = {
    id: "cs_wallet", mode: "payment", status: "complete", payment_status: "paid",
    client_reference_id: user.sub, currency: "gbp", amount_total: 5000,
    metadata: { purchase_type: "wallet_credit", wallet_purchase_id: id, auth0_user_id: user.sub, organization_id: "12", amount_gbp_pence: "5000" },
    customer: { id: "cus_wallet", metadata: { authUserId: user.sub } },
    payment_intent: { id: "pi_wallet", customer: "cus_wallet", status: "succeeded", currency: "gbp", amount_received: 5000,
      latest_charge: { paid: true, refunded: false, disputed: false, created: 1789000000 } },
    line_items: { has_more: false, data: [{ quantity: 1, amount_total: 5000 }] },
  };
  const deps = {
    frontendOrigin: "https://developers.example.test",
    getSnApiPortalContext: async () => ({ organization_id: 12 }),
    createWalletPurchase: async payload => { calls.push(["purchase", payload]); return { ...payload, status: "awaiting_payment", created_at: new Date().toISOString() }; },
    confirmWalletPayment: async (...args) => { calls.push(["confirm", ...args]); return { request_id: id, receipt: { plan_key: "basic" } }; },
    getOrCreateStripeCustomerId: async () => "cus_wallet",
    stripe: { checkout: { sessions: {
      create: async (...args) => { calls.push(["stripe", ...args]); return { url: "https://checkout.stripe.com/test" }; },
      retrieve: async () => structuredClone(session),
    } } },
  };
  return { id, calls, session, deps };
}

test("wallet amounts reject rounding, coercion and amounts below GBP50", () => {
  for (const amount of ["50", 49.99, 50.001, NaN, Infinity, -1]) assert.throws(() => amountPence(amount));
  assert.equal(amountPence(50), 5000);
  assert.equal(amountPence(50.01), 5001);
});

test("refund review binds a verified PaymentIntent to the API organisation", async () => {
  const { id, deps } = setup();
  const reviews = [];
  const payment = { id: "pi_wallet", customer: "cus_wallet", metadata: {
    purchase_type: "wallet_credit", wallet_purchase_id: id, auth0_user_id: user.sub, organization_id: "12",
  } };
  deps.stripe.paymentIntents = { retrieve: async () => payment };
  deps.flagWalletPaymentReview = async body => reviews.push(body);
  const event = { id: "evt_review", type: "charge.refunded", data: { object: { payment_intent: "pi_wallet" } } };
  await reviewPaymentEvent(event, deps);
  assert.equal(reviews[0].organization_id, 12);
  assert.equal(reviews[0].payment_reference, "pi_wallet");
  payment.metadata.organization_id = "99";
  await assert.rejects(reviewPaymentEvent(event, deps), { code: "payment_identity_mismatch" });
  assert.equal(reviews.length, 1);
});
test("card checkout is one-off with a server-owned price and stable retry key", async () => {
  const { id, calls, deps } = setup();
  const body = { requestId: id, purchaseKind: "credit", amountGbp: 50, organization_id: 99 };
  await createPurchase(user, body, deps); await createPurchase(user, body, deps);
  const stripe = calls.filter(c => c[0] === "stripe");
  assert.deepEqual(stripe[0], stripe[1]);
  assert.equal(stripe[0][1].mode, "payment");
  assert.equal(stripe[0][1].line_items[0].price_data.unit_amount, 5000);
  assert.equal(calls[0][1].organization_id, 12);
});
test("exact packages and large credit purchases request an invoice without contacting Stripe", async () => {
  for (const [kind, amount] of [["growth", 5000], ["enterprise", 12000], ["credit", 6500]]) {
    const { id, calls, deps } = setup();
    await createPurchase(user, { requestId: id, purchaseKind: kind, amountGbp: amount }, deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].payment_provider, "invoice");
  }
  const { id, deps } = setup();
  await assert.rejects(createPurchase(user, { requestId: id, purchaseKind: "growth", amountGbp: 5001 }, deps));
});
test("old uncertain card requests cannot create a second Checkout after idempotency expires", async () => {
  const { id, calls, deps } = setup();
  deps.createWalletPurchase = async () => ({ status: "awaiting_payment", payment_provider: "stripe", created_at: new Date(Date.now() - 86400000).toISOString() });
  await assert.rejects(createPurchase(user, { requestId: id, purchaseKind: "credit", amountGbp: 50 }, deps), { code: "wallet_checkout_review_required" });
  assert.equal(calls.length, 0);
});
test("browser and webhook confirmation use the same verified Stripe receipt", async () => {
  const { calls, deps } = setup();
  await reconcilePayment("cs_wallet", user, deps); await reconcilePayment("cs_wallet", null, deps);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0][2].payment_reference, "pi_wallet");
  assert.equal(calls[0][2].confirmed_by, "stripe_verified_payment");
});
test("unpaid, refunded, disputed, cross-tenant and tampered payments never grant credit", async () => {
  const changes = [s => s.payment_status = "unpaid", s => s.customer.metadata.authUserId = "other",
    s => s.metadata.organization_id = "99", s => s.payment_intent.latest_charge.refunded = true,
    s => s.payment_intent.latest_charge.disputed = true, s => s.amount_total = 5001,
    s => s.payment_intent.amount_received = 4999, s => s.line_items.data[0].quantity = 2];
  for (const change of changes) {
    const { calls, deps, session } = setup(); change(session);
    await assert.rejects(reconcilePayment("cs_wallet", user, deps));
    assert.equal(calls.length, 0);
  }
  const { calls, deps } = setup();
  await assert.rejects(reconcilePayment("cs_wallet", { sub: "auth0|other" }, deps));
  assert.equal(calls.length, 0);
});
