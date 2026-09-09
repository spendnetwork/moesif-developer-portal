const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BASIC_ACTIVATION,
  BASIC_CREDIT_TOP_UP,
  assertBasicCreditCheckoutReady,
  assertBasicPurchaseAllowed,
  isBasicCreditSession,
} = require("../services/basicPurchasePolicy");

test("initial Basic purchase is allowed only when no plan is active", () => {
  assert.doesNotThrow(() =>
    assertBasicPurchaseAllowed(BASIC_ACTIVATION, { active: false })
  );
  assert.throws(
    () =>
      assertBasicPurchaseAllowed(BASIC_ACTIVATION, {
        active: true,
        planKey: "basic",
      }),
    (error) => error.code === "basic_already_active"
  );
  assert.throws(
    () =>
      assertBasicPurchaseAllowed(BASIC_ACTIVATION, {
        active: true,
        planKey: "growth",
      }),
    (error) => error.code === "basic_plan_conflict"
  );
});

test("Basic top-up requires a confirmed active Basic plan", () => {
  assert.doesNotThrow(() =>
    assertBasicPurchaseAllowed(BASIC_CREDIT_TOP_UP, {
      active: true,
      planKey: "basic",
    })
  );
  assert.throws(
    () =>
      assertBasicPurchaseAllowed(BASIC_CREDIT_TOP_UP, { active: false }),
    (error) => error.code === "basic_plan_required"
  );
  assert.throws(
    () =>
      assertBasicPurchaseAllowed(BASIC_CREDIT_TOP_UP, {
        active: true,
        planKey: "enterprise",
      }),
    (error) => error.code === "basic_plan_conflict"
  );
});

test("Basic top-up reactivates a confirmed Basic plan with no credit", () => {
  assert.doesNotThrow(() =>
    assertBasicPurchaseAllowed(BASIC_CREDIT_TOP_UP, {
      active: false,
      planKey: "basic",
    })
  );
  assert.throws(
    () =>
      assertBasicPurchaseAllowed(BASIC_CREDIT_TOP_UP, {
        active: false,
        planKey: "growth",
      }),
    (error) => error.code === "basic_plan_required"
  );
});

test("inactive Growth cannot be replaced through Basic activation", () => {
  assert.throws(
    () =>
      assertBasicPurchaseAllowed(BASIC_ACTIVATION, {
        active: false,
        planKey: "growth",
      }),
    (error) => error.code === "basic_plan_conflict"
  );
});

test("activation reconciliation is idempotent after Basic becomes active", () => {
  assert.doesNotThrow(() =>
    assertBasicPurchaseAllowed(
      BASIC_ACTIVATION,
      { active: true, planKey: "basic" },
      { allowIdempotentActivation: true }
    )
  );
});

test("only explicit Basic purchase types enter prepaid reconciliation", () => {
  assert.equal(
    isBasicCreditSession({ metadata: { purchase_type: BASIC_ACTIVATION } }),
    true
  );
  assert.equal(
    isBasicCreditSession({ metadata: { purchase_type: BASIC_CREDIT_TOP_UP } }),
    true
  );
  assert.equal(
    isBasicCreditSession({ metadata: { purchase_type: "subscription" } }),
    false
  );
});
test("Development can buy Basic while active or exhausted, but cannot use Basic top-up first", () => {
  for (const active of [true, false]) {
    assert.doesNotThrow(() => assertBasicPurchaseAllowed("basic_activation", { active, planKey: "development" }));
    assert.throws(() => assertBasicPurchaseAllowed("basic_credit_top_up", { active, planKey: "development" }));
  }
});

test("legacy Basic cannot create checkout until deliberate migration is confirmed by the API", () => {
  for (const summary of [{ prepaid_enabled: true }, { prepaid_enabled: true, plan_key: "basic", debit_owner: "admin", subscription_id: "legacy_basic" }]) {
    assert.throws(() => assertBasicCreditCheckoutReady(summary, { current_plan_key: "basic", debit_owner: "api" }),
      error => error.code === "legacy_basic_migration_required" && error.status === 409);
  }
  assert.throws(() => assertBasicCreditCheckoutReady({ prepaid_enabled: true }, {}, { planKey: "basic" }), /balance review/);
  assert.doesNotThrow(() => assertBasicCreditCheckoutReady({ prepaid_enabled: true, plan_key: "basic", debit_owner: "api", subscription_id: "prepaid_new", access_block_reason: "insufficient_credit" }, {}));
  for (const plan of [null, "development", "growth", "enterprise"]) {
    assert.doesNotThrow(() => assertBasicCreditCheckoutReady({ prepaid_enabled: true, plan_key: plan }, { current_plan_key: plan }));
  }
});

test("every new Basic checkout requires explicit API readiness without provisioning a plan", () => {
  for (const plan of [null, "development", "basic"]) {
    for (const summary of [null, {}, { prepaid_enabled: false }, { prepaid_enabled: "true" }]) {
      assert.throws(() => assertBasicCreditCheckoutReady(summary, { current_plan_key: plan }),
        error => error.code === "prepaid_checkout_unavailable" && error.status === 503);
    }
  }
});
