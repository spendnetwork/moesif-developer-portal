"use strict";
// Delivers SN API's customer and staff outbox. SN API resolves active company
// admins and cancels notices that no longer describe the account.
const { createNotificationEmail, emailSettings } = require("./notificationEmail");
const { creditUtilisationSlack } = require("./creditUtilisationSlack");
const { slackNotification } = require("./slackNotification");

const PREFIX = "/api/v3/developer-portal/notification-deliveries";
const PLAN_NAMES = { basic: "Basic", growth: "Growth", enterprise: "Enterprise", test: "Test", development: "Development" };

function deliveryError(code, permanent = false) { return Object.assign(new Error(code), { name: code, permanent }); }
function diagnostic(error, phase) {
  // Never log upstream messages, response bodies, URLs or credentials.
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : undefined;
  const codes = { 401: "notification_api_unauthorized", 403: "notification_api_forbidden", 404: "notification_api_route_missing" };
  const configErrors = new Set(["NotificationOriginInvalid", "SendGridNotConfigured"]);
  return { phase, status, code: codes[status] || (configErrors.has(error?.name) ? error.name
    : error?.code === "sn_api_unavailable" ? "sn_api_unavailable" : "delivery_service_unavailable") };
}
function money(pence) {
  if (!Number.isInteger(pence)) throw deliveryError("InvalidNotificationAmount", true);
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}
function displayDate(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw deliveryError("InvalidNotificationDate", true);
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(date);
}
function pauseExplanation(reason, company) {
  // Customers only ever see these fixed texts, never the staff reason.
  if (reason === "payment_review") {
    return `We're reviewing a recent card payment for ${company}, so API access is paused for now. Your credit is safe, so please don't pay again. We'll be in touch, or you can contact us.`;
  }
  return `Our team has paused API access for ${company}. Contact us and we'll help you resolve this.`;
}

function renderJob(job, origin) {
  const payload = job.payload || {};
  const company = job.company || "your company";
  const portalUrl = `${origin}/dashboard`;
  switch (job.kind) {
    case "welcome":
      return { name: payload.name || "", company, plansUrl: `${origin}/plans`, portalUrl };
    case "payment_confirmed": {
      const plan = PLAN_NAMES[payload.plan_key] || "Your new";
      return {
        heading: payload.renewal ? "Renewal payment confirmed" : "Payment confirmed",
        company, portalUrl, amount: money(payload.amount_gbp_pence), available: money(payload.available_gbp_pence),
        creditExpiresAt: displayDate(payload.credit_expires_at),
        pricingLine: payload.pricing_applied && payload.pricing_ends_at
          ? `${plan} pricing is active until ${displayDate(payload.pricing_ends_at)}.` : "",
      };
    }
    case "access_paused":
      return { company, explanation: pauseExplanation(payload.reason, company) };
    case "access_restored":
      return { company, portalUrl, heading: "The staff pause on your account was removed",
        message: `Our team has removed the account pause for ${company}. Requests still require sufficient valid credit, accepted terms and an active API key. Check your account status in the portal before resuming requests.` };
    case "development_granted":
      return { heading: "Your development credit is ready", portalUrl,
        message: `${money(payload.amount_gbp_pence)} development credit has been granted to ${company}. It is metered at Basic rates${payload.expires_at ? ` and expires on ${displayDate(payload.expires_at)}` : ""}. Purchased credit is kept separately.` };
    case "credit_low":
    case "credit_exhausted": {
      const funding = payload.funding === "development" ? "development" : "purchased";
      const exhausted = payload.remaining_gbp_pence === 0;
      const heading = exhausted ? `Your ${funding} API credit is exhausted`
        : `${payload.threshold}% ${funding} API credit usage alert`;
      return { heading, company, portalUrl: `${origin}/billing`, exhausted,
        fundingLabel: funding === "development" ? "Development credit" : "Purchased credit",
        threshold: payload.threshold,
        remaining: money(payload.remaining_gbp_pence),
        granted: Number.isInteger(payload.granted_gbp_pence) ? money(payload.granted_gbp_pence) : "Not available",
        used: Number.isInteger(payload.used_gbp_pence) ? money(payload.used_gbp_pence) : "Not available",
        utilisation: Number.isFinite(payload.utilisation_percent) ? `${payload.utilisation_percent}%` : "Not available",
        message: `${company} has ${money(payload.remaining_gbp_pence)} ${funding} credit remaining. ${payload.threshold}% utilisation has been reached for this credit balance.`,
        nextSteps: funding === "development"
          ? "If you have valid purchased credit, it remains available after development credit runs out. Otherwise, purchase credit from GBP 50 or contact our team to discuss your access."
          : "You can purchase more credit from GBP 50 in Billing. Any valid development credit is tracked separately and may still be available.",
      };
    }
    case "credit_expiring":
    case "credit_expired":
      return { heading: job.kind === "credit_expired" ? "API credit expired" : "API credit expires soon", portalUrl,
        message: `${money(payload.remaining_gbp_pence)} ${payload.funding === "development" ? "development" : "purchased"} credit ${job.kind === "credit_expired" ? "expired" : "expires"} on ${displayDate(payload.expires_at)}. ${payload.funding === "development" ? "Purchases do not extend development credit." : "A cleared purchase before expiry extends the validity of unexpired purchased credit."} Review your balance in Billing.` };
    case "pricing_expiring":
    case "pricing_expired":
      return { heading: job.kind === "pricing_expired" ? "Your pricing period ended" : "Your pricing period ends soon", portalUrl,
        message: `${PLAN_NAMES[payload.plan_key] || "Discounted"} pricing ${job.kind === "pricing_expired" ? "ended" : "ends"} on ${displayDate(payload.expires_at)}. Without a new qualifying purchase, remaining purchased credit is spent at Basic rates. Credit expiry is separate from your pricing period.` };
    case "payment_failed":
      return { heading: "Payment was not completed", portalUrl,
        message: "A card payment was unsuccessful. No credit was granted for this attempt. Check Billing before trying again; contact us if your bank shows a completed charge." };
    case "api_key_changed":
      return { heading: "An API key was updated", portalUrl: `${origin}/keys`,
        message: `An API key for ${company} was ${payload.action}. No API key secret is included in this email. Review API Keys or contact us if you did not expect this change.` };
    case "purchase_requested":
      return { heading: "Invoice purchase recorded", portalUrl,
        message: `An invoice purchase of ${money(payload.amount_gbp_pence)} has been recorded for ${company}. Credit and any pricing change activate only after payment is confirmed as cleared.` };
    case "purchase_cancelled":
      return { heading: "Invoice request cancelled", portalUrl: `${origin}/plans`,
        message: `The invoice request of ${money(payload.amount_gbp_pence)} for ${company} has been cancelled, so no invoice will be issued for it. Your credit and pricing are unchanged. You can make a new request from Plans at any time.` };
    default:
      throw deliveryError("UnknownNotificationKind", true);
  }
}

function accountSlack(job, origin, env) {
  if (["credit_low", "credit_exhausted"].includes(job.kind)) return creditUtilisationSlack(job, env);
  const p = job.payload || {};
  const summary = job.kind === "delivery_failed"
    ? { heading: "Customer notification delivery failed", message: "Check notification health and provider configuration." }
    : renderJob(job, origin);
  const titles = { welcome: "Customer signed up", access_paused: "Customer API access paused",
    access_restored: "Customer API access restored", development_granted: "Development credit granted",
    purchase_requested: "Invoice requested", purchase_cancelled: "Invoice request cancelled by customer" };
  const fields = [["Company", job.company], ["Plan", PLAN_NAMES[p.plan_key || job.plan_key] || "Not available"]];
  if (job.kind === "payment_confirmed") fields.push(["Payment", summary.amount], ["Available credit", summary.available], ["Credit expires", summary.creditExpiresAt]);
  if (["development_granted", "purchase_requested", "purchase_cancelled"].includes(job.kind)) fields.push(["Credit amount", money(p.amount_gbp_pence)]);
  if (job.kind === "purchase_cancelled") fields.push(["Package", PLAN_NAMES[p.purchase_kind] || "Credit top-up"], ["Cancelled by", p.cancelled_by || "Not available"]);
  if (["credit_expiring", "credit_expired"].includes(job.kind)) fields.push(["Credit type", p.funding === "development" ? "Development" : "Purchased"], ["Remaining", money(p.remaining_gbp_pence)]);
  if (p.expires_at) fields.push(["Expiry", displayDate(p.expires_at)]);
  if (job.kind === "delivery_failed") fields.push(["Failed notification", p.notification_kind]);
  if (job.kind === "welcome" && p.name) fields.push(["Name", p.name]);
  fields.push(["Customer id", job.organization_id], ["Stripe customer", job.stripe_customer_id], ["Moesif company", job.moesif_company_id]);
  const severity = ["delivery_failed", "payment_failed", "access_paused"].includes(job.kind) ? "High"
    : ["credit_expiring", "credit_expired", "pricing_expiring", "pricing_expired"].includes(job.kind) ? "Warning" : "Information";
  return slackNotification({ title: titles[job.kind] || summary.heading, severity, fields,
    notes: [summary.message || summary.explanation || summary.pricingLine], organizationId: job.organization_id }, env);
}

function createCustomerNotificationWorker({ service, email, env = process.env, fetchImpl = fetch }) {
  let running = false;
  let after = 0;
  let nextScanAt = 0;
  async function deliver(job) {
    if (job.channel === "slack") {
      const webhook = env.NOTIFICATION_SLACK_WEBHOOK_URL || env.INVITATION_SLACK_WEBHOOK_URL;
      let url;
      try { url = new URL(webhook); } catch { throw deliveryError("SlackNotConfigured"); }
      if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || !url.pathname.startsWith("/services/") || url.username || url.password) {
        throw deliveryError("SlackNotConfigured");
      }
      const slackPayload = accountSlack(job, service.settings().origin, env);
      const response = await fetchImpl(url.href, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(slackPayload) });
      if (!response.ok || (await response.text()).trim() !== "ok") throw deliveryError("SlackDeliveryFailed");
      return null;
    }
    const recipients = Array.isArray(job.recipients) ? job.recipients.filter(item => typeof item === "string" && item) : [];
    if (!recipients.length) throw deliveryError("NoAdminRecipients", true);
    const data = renderJob(job, service.settings().origin);
    return (email || createNotificationEmail({ env })).send({ kind: job.kind, to: recipients, data, deliveryId: job.id });
  }
  async function tick() {
    if (running) return;
    running = true;
    let phase = "settings";
    try {
      service.settings();
      if (service.scan && Date.now() >= nextScanAt) {
        try {
          phase = "scan";
          const page = await service.scan(after);
          after = page.after;
          nextScanAt = after ? 0 : Date.now() + 300000;
          phase = "health";
          const health = await service.health();
          if (health.failed || health.undeliverable || health.oldest_pending_seconds > 900) {
            console.warn(JSON.stringify({ event: "notification_queue_unhealthy", ...health }));
          }
        } catch (error) { console.warn(JSON.stringify({ event: "notification_scan_delayed", ...diagnostic(error, phase) })); }
      }
      for (let count = 0; count < 10; count++) {
        phase = "claim";
        const job = await service.claim();
        if (!job) break;
        let result;
        try { result = { result: "sent", message_id: await deliver(job) }; }
        catch (error) {
          result = { result: error.permanent ? "failed" : "retry", failure_code: /^[A-Za-z0-9_]{1,80}$/.test(error.name || "") ? error.name : "DeliveryFailed" };
          console.warn(JSON.stringify({ event: "customer_notification_failed", deliveryId: job.id, code: result.failure_code, retryable: !error.permanent }));
        }
        // Retry the acknowledgement, never the provider send, after a lost HTTP response.
        phase = "acknowledge";
        for (let attempt = 0; ; attempt++) {
          try { await service.finish(job, result); break; }
          catch (error) {
            if (attempt >= 2 || (error.status && error.status < 500)) throw error;
          }
        }
        console.info(JSON.stringify({ event: "customer_notification_processed", deliveryId: job.id, kind: job.kind, result: result.result }));
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "customer_notification_worker_delayed", ...diagnostic(error, phase) }));
    } finally { running = false; }
  }
  return { tick };
}

function notificationSettings(env = process.env) {
  emailSettings(env);
  let origin;
  try { origin = new URL(env.INVITATION_PORTAL_URL || ""); } catch { throw deliveryError("NotificationOriginInvalid"); }
  if (origin.username || origin.password || origin.search || origin.hash ||
      (origin.protocol !== "https:" && !(env.NODE_ENV !== "production" && origin.protocol === "http:" &&
       ["localhost", "127.0.0.1"].includes(origin.hostname)))) throw deliveryError("NotificationOriginInvalid");
  return { origin: origin.origin };
}

function notificationService(invitationService, request) {
  return {
    settings: () => notificationSettings(),
    claim: () => request(`${PREFIX}/claim`, { method: "POST" }),
    finish: (job, result) => request(`${PREFIX}/${encodeURIComponent(job.id)}/result`, { method: "POST", body: { lease_id: job.lease_id, ...result } }),
    scan: after => request(`${PREFIX}/scan?after=${after}`, { method: "POST" }),
    health: () => request(`${PREFIX}/health`, { method: "GET" }),
  };
}

// Runs alongside the invitation worker, under the same email configuration.
function startCustomerNotificationWorker(invitationService, request) {
  if ((process.env.CUSTOMER_NOTIFICATIONS_ENABLED ?? process.env.INVITATIONS_ENABLED) !== "true") return;
  const worker = createCustomerNotificationWorker({ service: notificationService(invitationService, request) });
  const timer = setInterval(() => void worker.tick(), 30000);
  timer.unref();
  void worker.tick();
  return () => clearInterval(timer);
}

module.exports = { createCustomerNotificationWorker, notificationService, notificationSettings, renderJob, accountSlack, startCustomerNotificationWorker };
