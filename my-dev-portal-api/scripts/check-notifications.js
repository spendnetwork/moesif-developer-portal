"use strict";
require("dotenv").config();
const { createInvitations } = require("../services/invitations");
const { renderEmail, createNotificationEmail } = require("../services/notificationEmail");

// Local by default. --sandbox validates with SendGrid but never delivers mail.
async function checkNotifications({ env = process.env, sandbox = false, email, report = console.log } = {}) {
  createInvitations({ env }).settings();
  report("Invitation and SendGrid settings: valid format (secret values are never printed)");
  const data = { name: "Test Customer", company: "Example", currency: "GBP", creditAmount: "50.00", validityDays: "30",
    invitationUrl: "https://example.com/signup#invitation=synthetic", portalUrl: "https://example.com/dashboard",
    invitationExpiresAt: "26 September 2026 12:00 UTC", creditExpiresAt: "19 October 2026 12:00 UTC" };
  for (const kind of ["invite", "accepted_email"]) {
    renderEmail(kind, data);
    report("Local email template renders: " + kind);
    if (sandbox) await (email || createNotificationEmail({ env })).send({
      kind, to: "notification-check@example.com", data, deliveryId: "preflight-only",
    }, { sandbox: true });
  }
  report(sandbox ? "SendGrid sandbox validation passed; no email sent or credit changed." : "No network calls made. Use --sandbox to validate the send request with SendGrid without delivery.");
  report("Slack URL format is valid; channel access is not tested.");
  report("Sender verification, inbox delivery and bounce/complaint handling must be verified separately. Submitted does not mean delivered.");
}
if (require.main === module) {
  checkNotifications({ sandbox: process.argv.includes("--sandbox") }).catch(error => {
    const code = /^[A-Za-z0-9_]{1,80}$/.test(error.code || error.name || "") ? error.code || error.name : "CheckFailed";
    console.error("Notification preflight failed: " + code + ". Check backend configuration and SendGrid sender/API-key permissions.");
    process.exitCode = 1;
  });
}
module.exports = { checkNotifications };
