const test = require("node:test");
const assert = require("node:assert/strict");

process.env.STRIPE_API_KEY ||= "sk_test_placeholder";

const {
  assertBasicTopUpAllowed,
  getSubscriptionPlanKey,
  subscriptionProductIds,
} = require("../services/stripeApis");

function subscription(id, productId, overrides = {}) {
  return {
    id,
    status: "active",
    metadata: {},
    items: {
      data: [{ price: { product: productId } }],
    },
    ...overrides,
  };
}

test("Basic top-up remains available with a live Basic subscription", async () => {
  const live = [subscription("sub_basic", "prod_basic")];
  const classified = await assertBasicTopUpAllowed(
    live,
    async () => "basic"
  );

  assert.equal(classified.length, 1);
  assert.equal(classified[0].planKey, "basic");
});

test("Basic top-up is blocked by a live Growth subscription", async () => {
  const live = [subscription("sub_growth", "prod_growth")];

  await assert.rejects(
    assertBasicTopUpAllowed(live, async () => "growth"),
    (error) =>
      error.code === "active_subscription_exists" &&
      error.subscriptionIds[0] === "sub_growth" &&
      error.planKeys[0] === "growth"
  );
});

test("Basic top-up is blocked when Basic and Enterprise are both live", async () => {
  const live = [
    subscription("sub_basic", "prod_basic"),
    subscription("sub_enterprise", "prod_enterprise"),
  ];

  await assert.rejects(
    assertBasicTopUpAllowed(live, async (candidate) =>
      candidate.id === "sub_basic" ? "basic" : "enterprise"
    ),
    (error) =>
      error.code === "active_subscription_exists" &&
      error.subscriptionIds.length === 1 &&
      error.subscriptionIds[0] === "sub_enterprise"
  );
});

test("subscription plan classification resolves expanded and string products", async () => {
  const candidate = subscription("sub_basic", { id: "prod_basic" }, {
    metadata: { plan_id: "prod_basic" },
    items: {
      data: [
        { price: { product: { id: "prod_basic" } } },
        { price: { product: "prod_basic" } },
      ],
    },
  });

  assert.deepEqual(subscriptionProductIds(candidate), ["prod_basic"]);
  assert.equal(
    await getSubscriptionPlanKey(candidate, async (productId) => {
      assert.equal(productId, "prod_basic");
      return "basic";
    }),
    "basic"
  );
});

test("ambiguous subscription products fail closed", async () => {
  const candidate = subscription("sub_mixed", "prod_basic", {
    items: {
      data: [
        { price: { product: "prod_basic" } },
        { price: { product: "prod_growth" } },
      ],
    },
  });

  await assert.rejects(
    getSubscriptionPlanKey(candidate, async (productId) =>
      productId === "prod_basic" ? "basic" : "growth"
    ),
    (error) => error.code === "mixed_subscription_products"
  );
});

test("stale Basic metadata cannot disguise a Growth subscription", async () => {
  const candidate = subscription("sub_growth", "prod_growth", {
    metadata: { plan_key: "basic" },
  });

  await assert.rejects(
    getSubscriptionPlanKey(candidate, async () => "growth"),
    (error) => error.code === "subscription_plan_mismatch"
  );
});
