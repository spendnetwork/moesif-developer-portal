const DEFAULT_SALES_CONTACT_EMAIL = "contact@spendnetwork.com";
const CONTACT_LED_PLAN_KEYS = new Set(["growth", "enterprise"]);

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

module.exports = {
  DEFAULT_SALES_CONTACT_EMAIL,
  getContactLedPlanDetails,
  normalizedSalesContactEmail,
};
