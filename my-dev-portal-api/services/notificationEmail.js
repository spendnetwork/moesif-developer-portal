"use strict";
const Handlebars = require("handlebars");
const { MailService } = require("@sendgrid/mail");

function emailError(code, permanent = false) {
  return Object.assign(new Error(code), { name: code, code, permanent });
}

function emailSettings(env = process.env) {
  const apiKey = env.SENDGRID_API_KEY || "";
  const from = env.EMAIL_FROM || "";
  const name = env.EMAIL_FROM_NAME || "Open Opportunities";
  if (!/^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(apiKey) ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) || /[\r\n]/.test(name)) {
    throw emailError("SendGridNotConfigured", true);
  }
  return { apiKey, from, name };
}

const templates = Object.fromEntries([
  ["invite", require("../email-templates/customer-invitation.json")],
  ["accepted_email", require("../email-templates/development-credit-granted.json")],
  ["team_invite", require("../email-templates/team-invitation.json")],
  ["team_joined", require("../email-templates/team-member-joined.json")],
  ["welcome", require("../email-templates/welcome.json")],
  ["payment_confirmed", require("../email-templates/payment-confirmed.json")],
  ["access_paused", require("../email-templates/access-paused.json")],
  ["access_restored", require("../email-templates/account-update.json")],
  ["credit_low", require("../email-templates/credit-utilisation.json")],
  ["credit_exhausted", require("../email-templates/credit-utilisation.json")],
  ...["development_granted", "credit_expiring", "credit_expired",
      "pricing_expiring", "pricing_expired", "payment_failed", "api_key_changed", "purchase_requested"]
    .map(kind => [kind, require("../email-templates/account-update.json")]),
].map(([kind, template]) => [kind, {
  subject: Handlebars.compile(template.subject, { strict: true, noEscape: true }),
  text: Handlebars.compile(template.text, { strict: true, noEscape: true }),
  html: Handlebars.compile(template.html, { strict: true }),
}]));

function renderEmail(kind, data) {
  const template = templates[kind];
  if (!template) throw emailError("UnknownEmailTemplate", true);
  try {
    // Names in a subject line must stay on one line.
    const subject = template.subject(data).replace(/\s+/g, " ").trim();
    return { subject, text: template.text(data), html: template.html(data) };
  } catch { throw emailError("EmailTemplateInvalid", true); }
}

function classifySendError(error) {
  const status = Number(error.response?.statusCode || error.code);
  if (status === 401) return emailError("SendGridAuthenticationFailed", true);
  if (status === 403) return emailError("SendGridSenderOrPermissionDenied", true);
  if ([400, 404, 405, 413, 422].includes(status)) return emailError("SendGridRequestRejected", true);
  if (status === 429) return emailError("SendGridRateLimited");
  if (status >= 500) return emailError("SendGridUnavailable");
  // Never log SDK errors: they may contain the API key, recipient or signed link.
  return emailError("SendGridSubmissionUnconfirmed");
}

function createNotificationEmail({ env = process.env, client } = {}) {
  const settings = emailSettings(env);
  const mail = client || new MailService();
  mail.setApiKey(settings.apiKey);
  mail.setTimeout(15000);
  // Do not forward credentials or signed invitation URLs across HTTP redirects.
  mail.client?.setDefaultRequest("maxRedirects", 0);
  return {
    async send({ kind, to, data, deliveryId }, { sandbox = false } = {}) {
      const content = renderEmail(kind, data);
      let response;
      try {
        [response] = await mail.send({
          // Several recipients each get their own copy and never see each other's address.
          to, ...(Array.isArray(to) ? { isMultiple: true } : {}),
          from: { email: settings.from, name: settings.name }, ...content,
          customArgs: { notification: kind, delivery_id: String(deliveryId) },
          trackingSettings: {
            clickTracking: { enable: false, enableText: false },
            openTracking: { enable: false },
            subscriptionTracking: { enable: false },
            ganalytics: { enable: false },
          },
          ...(sandbox ? { mailSettings: { sandboxMode: { enable: true } } } : {}),
        });
      } catch (error) { throw classifySendError(error); }
      if (sandbox && response?.statusCode === 200) return null;
      const messageId = response?.headers?.["x-message-id"];
      if (!sandbox && response?.statusCode === 202 && typeof messageId === "string" &&
          messageId.length > 0 && messageId.length <= 255) return messageId;
      throw emailError("SendGridSubmissionUnconfirmed");
    },
  };
}

module.exports = { emailSettings, renderEmail, createNotificationEmail, emailError };
