"use strict";
const { slackNotification } = require("./slackNotification");

const PLAN_NAMES = { basic: "Basic", growth: "Growth", enterprise: "Enterprise", test: "Test", development: "Development" };
const money = value => Number.isSafeInteger(value)
  ? new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value / 100)
  : "Not available";

function creditUtilisationSlack(job, env = process.env) {
  const p = job.payload || {};
  const threshold = Number(p.threshold);
  const development = p.funding === "development";
  const severity = threshold >= 100 ? "Critical" : threshold >= 90 ? "High" : "Warning";
  const percent = Number.isFinite(p.utilisation_percent) ? `${p.utilisation_percent}% used` : `Reached ${threshold}%`;
  const title = `API credit utilisation: ${threshold}%`;
  const fields = [
    ["Company", job.company], ["Plan", PLAN_NAMES[p.plan_key] || "Not available"],
    [development ? "Development credit" : "Purchased credit", money(p.granted_gbp_pence)],
    ["Remaining", money(p.remaining_gbp_pence)], ["Used", money(p.used_gbp_pence)],
    ["Utilisation", percent], ["Customer id", job.organization_id],
    ["Stripe customer", job.stripe_customer_id], ["Moesif company", job.moesif_company_id],
  ];
  // Exhaustion concerns this funding pool, not necessarily the whole account.
  let note = `${development ? "Development" : "Purchased"} credit only. Other eligible credit may still be available.`;
  if (p.request_rejected_at && p.remaining_gbp_pence > 0) {
    note += " A request was rejected for insufficient credit; the balance is not zero. Smaller requests may still be affordable.";
  }
  const notes = [note];
  if (p.measured_at && Number.isFinite(Date.parse(p.measured_at))) {
    notes.push(`Balance checked: ${new Date(p.measured_at).toISOString()}`);
  }
  return slackNotification({ title, severity, fields, notes, organizationId: job.organization_id }, env);
}

module.exports = { creditUtilisationSlack };
