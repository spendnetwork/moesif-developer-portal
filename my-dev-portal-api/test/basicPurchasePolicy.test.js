const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BASIC_ACTIVATION,
  BASIC_CREDIT_TOP_UP,
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
