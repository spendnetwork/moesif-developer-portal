const BASIC_ACTIVATION = "basic_activation";
const BASIC_CREDIT_TOP_UP = "basic_credit_top_up";
const BASIC_PURCHASE_TYPES = [BASIC_ACTIVATION, BASIC_CREDIT_TOP_UP];

function basicPurchaseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isBasicPurchaseType(value) {
  return BASIC_PURCHASE_TYPES.includes(value);
}

function isBasicCreditSession(session) {
  return isBasicPurchaseType(session?.metadata?.purchase_type);
}

function assertBasicPurchaseAllowed(
  purchaseType,
  entitlement,
  { allowIdempotentActivation = false } = {}
) {
  if (!isBasicPurchaseType(purchaseType)) {
    throw basicPurchaseError(
      "invalid_basic_purchase_type",
      "Choose Basic before purchasing API credit."
    );
  }

  const active = entitlement?.active === true;
  const planKey = entitlement?.planKey || null;

  if (purchaseType === BASIC_ACTIVATION) {
    if (!active && (!planKey || planKey === "basic")) return;
    if (planKey === "basic" && allowIdempotentActivation) return;
    if (planKey === "basic") {
      throw basicPurchaseError(
        "basic_already_active",
        "Basic is already active. Use Add credit instead."
      );
    }
    throw basicPurchaseError(
      "basic_plan_conflict",
      "Basic cannot be activated while Growth or Enterprise is current. Switch to Basic at renewal first."
    );
  }

  // A scheduled downgrade lands on Basic with access paused until credit is
  // purchased. Keep the confirmed plan identity so that this first top-up can
  // reactivate access without requiring a second plan selection.
  if (planKey === "basic") return;
  if (active) {
    throw basicPurchaseError(
      "basic_plan_conflict",
      "Credit can only be added after Basic becomes your active plan."
    );
  }
  throw basicPurchaseError(
    "basic_plan_required",
    "Select Basic and complete the initial credit purchase before adding credit."
  );
}

module.exports = {
  BASIC_ACTIVATION,
  BASIC_CREDIT_TOP_UP,
  BASIC_PURCHASE_TYPES,
  assertBasicPurchaseAllowed,
  basicPurchaseError,
  isBasicCreditSession,
  isBasicPurchaseType,
};
