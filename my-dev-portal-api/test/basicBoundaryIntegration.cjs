// Opt-in integration: real portal services + FastAPI handlers + isolated PG.
// Stripe is replaced at the SDK boundary; no live billing calls are possible.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { once } = require("node:events");
const path = require("node:path");
const crypto = require("node:crypto");

if (!process.env.SN_PREPAID_TEST_PYTHON || !process.env.SN_PREPAID_TEST_API_ROOT || !process.env.SN_PREPAID_TEST_DATABASE_URL) {
  throw new Error("Set SN_PREPAID_TEST_PYTHON, SN_PREPAID_TEST_API_ROOT and the isolated SN_PREPAID_TEST_DATABASE_URL");
}
process.env.SN_API_BASE_URL = "http://127.0.0.1:55492";
process.env.SN_API_PROVISIONING_TOKEN = "isolated-portal-token";
const api = require("../services/snApiProvisioning");
const { completeBasicDowngrade, reconcileDuePlanChanges } = require("../services/planChangeService");
const { processSubscriptionLifecycle } = require("../services/subscriptionReconciliation");
const { reconcileBasicCreditPurchase } = require("../services/prepaidReconciliation");
const { assertBasicCreditCheckoutReady } = require("../services/basicPurchasePolicy");
const { localUsageSummary } = require("../services/localUsageSummary");

async function scenario(plan) {
  const child = spawn(process.env.SN_PREPAID_TEST_PYTHON, [path.join(__dirname, "basic_boundary_api.py")], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  const closed = once(child, "exit");
  const pending = new Map();
  let sequence = 0;
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(`API bridge: ${message.error}`));
    else handler.resolve(message.result);
  });
  child.on("exit", code => {
    for (const handler of pending.values()) handler.reject(new Error(`API bridge exited ${code}`));
  });
  const rpc = body => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ ...body, id }) + "\n");
  });
  const nativeFetch = global.fetch;
  let loseCompletionResponse = false;
  global.fetch = async (url, options = {}) => {
    const target = new URL(url);
    assert.equal(target.origin, process.env.SN_API_BASE_URL);
    const result = await rpc({ action: "http", path: target.pathname + target.search,
      method: options.method || "GET", headers: options.headers, body: options.body });
    if (loseCompletionResponse && options.method === "PATCH" && JSON.parse(options.body).status === "active") {
      loseCompletionResponse = false;
      throw new Error("Simulated lost completion response after database commit");
    }
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
  };
  try {
    const fixture = await rpc({ action: "initialize", plan });
    const authUser = { sub: fixture.auth0_user_id, email: "prepaid@example.com" };
    const customer = { id: "cus_boundary", email: authUser.email, metadata: { authUserId: authUser.sub, current_subscription_id: "sub_boundary" } };
    const oldSubscription = { id: "sub_boundary", customer: customer.id, status: "canceled", current_period_end: Math.floor(Date.now() / 1000) - 86400 * 31 };
    let paidSession;
    const Stripe = require("stripe");
    const stripePath = require.resolve("stripe");
    require.cache[stripePath].exports = () => ({
      products: { retrieve: async () => ({ id: "prod_basic", metadata: { plan_key: "basic" } }) },
      customers: { retrieve: async () => customer, search: async () => ({ data: [customer] }), update: async () => { throw new Error("Must not rewrite customer identity"); } },
      subscriptions: { retrieve: async id => { assert.equal(id, oldSubscription.id); return oldSubscription; }, list: async () => ({ data: [] }), cancel: async () => { throw new Error("Already cancelled source must not be cancelled again"); } },
      checkout: { sessions: {
        create: async payload => {
          const amount = payload.line_items[0].price_data.unit_amount;
          paidSession = { id: `cs_${plan}`, status: "complete", payment_status: "paid", mode: "payment", amount_total: amount, currency: "gbp", customer, client_reference_id: authUser.sub, metadata: payload.metadata,
            payment_intent: { id: `pi_${plan}`, customer: customer.id, status: "succeeded", amount_received: amount, currency: "gbp" },
            line_items: { data: [{ quantity: 1, amount_total: amount, price: { product: "prod_basic" } }], has_more: false } };
          return paidSession;
        }, retrieve: async () => paidSession,
      } },
    });
    delete require.cache[require.resolve("../services/stripeApis")];
    const stripe = require("../services/stripeApis");
    require.cache[stripePath].exports = Stripe;
    const created = await api.createSnApiPlanChange(authUser, {
      request_id: crypto.randomUUID(), stripe_customer_id: customer.id, stripe_subscription_id: oldSubscription.id,
      from_plan_key: plan, to_plan_key: "basic", target_product_id: "prod_basic", effective_at: fixture.end, commitment_ends_at: fixture.end,
      metadata: { change_type: "downgrade" },
    });
    const change = await rpc({ action: "advance", request_id: created.request_id });
    const lifecycle = await processSubscriptionLifecycle(oldSubscription, {
      ...api, ...stripe, liveStatuses: stripe.LIVE_SUBSCRIPTION_STATUSES,
      handleSubscriptionEnded: async () => { throw new Error("Due boundary must not revoke keys"); },
    });
    assert.equal(lifecycle.status, "scheduled_downgrade_transition");
    const deps = { ...api, ...stripe, claimSnApiDuePlanChanges: undefined };
    let failCleanup = true;
    deps.endStripeSubscriptionForBasicDowngrade = async request => {
      assert.equal((await rpc({ action: "inspect" })).plan, "basic");
      if (failCleanup) { failCleanup = false; throw new Error("Simulated source lookup failure"); }
      return stripe.endStripeSubscriptionForBasicDowngrade(request);
    };
    const failed = await reconcileDuePlanChanges(deps);
    assert.match(failed[0].error, /Simulated source lookup failure/);
    const activating = await rpc({ action: "inspect" });
    assert.deepEqual(activating.statuses, ["activating"]);
    assert.equal(activating.credits.length, 2);
    const emptySummary = await api.getSnApiUsageSummary(authUser);
    assert.equal(emptySummary.balances.commercial.spendable_gbp_pence, 0);
    assert.equal(emptySummary.access_block_reason, "insufficient_credit");
    assert.equal(emptySummary.historical_balances.legacy.remaining_gbp_pence, 12345);
    assert.equal(emptySummary.historical_balances.development.remaining_gbp_pence, 4567);
    assertBasicCreditCheckoutReady(emptySummary, {});
    loseCompletionResponse = true;
    assert.match((await reconcileDuePlanChanges(deps))[0].error, /lost completion response/);
    assert.deepEqual((await rpc({ action: "inspect" })).statuses, ["active"]);
    await completeBasicDowngrade(change, deps);
    assert.equal(customer.metadata.current_subscription_id, "sub_boundary");
    await stripe.createBasicCreditCheckoutSession(authUser.email, "prod_basic", 100, "basic_credit_top_up", authUser, crypto.randomUUID(), {
      current_plan_key: "basic", current_subscription_id: emptySummary.subscription_id,
    });
    await Promise.all(Array.from({ length: 4 }, () => reconcileBasicCreditPurchase(paidSession.id, authUser, deps)));
    const funded = await api.getSnApiUsageSummary(authUser);
    assert.equal(localUsageSummary(funded).credit.remaining, 10000);
    assert.equal(funded.access_block_reason, null);
    assert.equal((await rpc({ action: "inspect" })).credits.length, 3);
    await rpc({ action: "replace" });
    customer.metadata.current_subscription_id = "sub_newer";
    await reconcileBasicCreditPurchase(paidSession.id, authUser, deps);
    await completeBasicDowngrade(change, { ...deps, endStripeSubscriptionForBasicDowngrade: stripe.endStripeSubscriptionForBasicDowngrade });
    const final = await rpc({ action: "inspect" });
    assert.equal(final.subscription, "sub_newer");
    assert.equal(final.credits.length, 3);
    assert.equal(customer.metadata.current_subscription_id, "sub_newer");
    assert.deepEqual(final.credits.slice(0, 2).map(credit => credit.remaining), [12345, 4567]);
    console.log(`PASS real API/PG: Stripe ${plan} boundary, canceled source, monthly period, cleanup retries, GBP100 paid top-up, replay after newer plan, historical credit preserved`);
  } finally {
    global.fetch = nativeFetch;
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0, "API bridge must exit after dropping its isolated schema");
  }
}

(async () => {
  for (const plan of ["growth", "enterprise"]) await scenario(plan);
})().catch(error => { console.error(error); process.exitCode = 1; });
