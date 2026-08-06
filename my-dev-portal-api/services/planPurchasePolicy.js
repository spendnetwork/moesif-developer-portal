const DEFAULT_SALES_CONTACT_EMAIL = "contact@spendnetwork.com";
const CONTACT_LED_PLAN_KEYS = new Set(["growth", "enterprise"]);
const PLAN_RANK = { basic: 0, growth: 1, enterprise: 2 };

function normalizedSalesContactEmail(configuredEmail) {
  const email = String(configuredEmail || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : DEFAULT_SALES_CONTACT_EMAIL;
}

function getContactLedPlanDetails(planKey, configuredEmail) {
  const normalizedPlanKey = String(planKey || "").trim().toLowerCase();
  if (!CONTACT_LED_PLAN_KEYS.has(normalizedPlanKey)) return null;

  const contactEmail = normalizedSalesContactEmail(configuredEmail);
  const planName =
    normalizedPlanKey.charAt(0).toUpperCase() + normalizedPlanKey.slice(1);

  return {
    code: "contact_required",
    contact_email: contactEmail,
    message: `${planName} is arranged by invoice. Contact ${contactEmail} to continue.`,
  };
}

function requiresManagedContact(fromPlanKey, toPlanKey) {
  const from = String(fromPlanKey || "").trim().toLowerCase();
  const to = String(toPlanKey || "").trim().toLowerCase();
  if (!CONTACT_LED_PLAN_KEYS.has(to)) return false;
  if (!(from in PLAN_RANK)) return true;
  return PLAN_RANK[to] > PLAN_RANK[from];
}

function eligiblePaidBasicCreditPence({ totalPurchasedPence, balancePence }) {
  if (
    !Number.isFinite(totalPurchasedPence) ||
    !Number.isFinite(balancePence)
  ) {
    return null;
  }
  return Math.max(
    0,
    Math.min(Math.round(totalPurchasedPence), Math.round(balancePence))
  );
}

function commitmentUpgradeQuote({
  fromPlanKey,
  targetCommitmentPence,
  currentCommitmentPence = 0,
  paidBasicCreditPence = 0,
}) {
  const target = Math.max(0, Math.round(Number(targetCommitmentPence) || 0));
  const current = Math.max(
    0,
    Math.round(
      String(fromPlanKey || "").toLowerCase() === "basic"
        ? Number(paidBasicCreditPence) || 0
        : Number(currentCommitmentPence) || 0
    )
  );
  return {
    targetCommitmentPence: target,
    creditAppliedPence: Math.min(target, current),
    amountDuePence: Math.max(0, target - current),
  };
}

module.exports = {
  DEFAULT_SALES_CONTACT_EMAIL,
  commitmentUpgradeQuote,
  eligiblePaidBasicCreditPence,
  getContactLedPlanDetails,
  normalizedSalesContactEmail,
  requiresManagedContact,
};
