"use strict";
// Delivers sn-api's customer_notification outbox (welcome, payment confirmed,
// access paused/restored). sn-api resolves the recipients, always the
// organisation's active admins, and cancels messages that are no longer true.
const { createNotificationEmail } = require("./notificationEmail");

const PREFIX = "/api/v3/developer-portal/notification-deliveries";
const PLAN_NAMES = { basic: "Basic", growth: "Growth", enterprise: "Enterprise", test: "Test", development: "Development" };

function deliveryError(code, permanent = false) { return Object.assign(new Error(code), { name: code, permanent }); }
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
      return { company, portalUrl };
    default:
      throw deliveryError("UnknownNotificationKind", true);
  }
}

function createCustomerNotificationWorker({ service, email, env = process.env }) {
  let running = false;
  async function deliver(job) {
    const recipients = Array.isArray(job.recipients) ? job.recipients.filter(item => typeof item === "string" && item) : [];
    if (!recipients.length) throw deliveryError("NoAdminRecipients", true);
    const data = renderJob(job, service.settings().origin);
    return (email || createNotificationEmail({ env })).send({ kind: job.kind, to: recipients, data, deliveryId: job.id });
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      service.settings();
      for (let count = 0; count < 10; count++) {
        const job = await service.claim();
        if (!job) break;
        let result;
        try { result = { result: "sent", message_id: await deliver(job) }; }
        catch (error) {
          result = { result: error.permanent ? "failed" : "retry", failure_code: /^[A-Za-z0-9_]{1,80}$/.test(error.name || "") ? error.name : "DeliveryFailed" };
          console.warn(JSON.stringify({ event: "customer_notification_failed", deliveryId: job.id, code: result.failure_code, retryable: !error.permanent }));
        }
        // Retry the acknowledgement, never the provider send, after a lost HTTP response.
        for (let attempt = 0; ; attempt++) {
          try { await service.finish(job, result); break; }
          catch (error) {
            if (attempt >= 2 || (error.status && error.status < 500)) throw error;
          }
        }
        console.info(JSON.stringify({ event: "customer_notification_processed", deliveryId: job.id, kind: job.kind, result: result.result }));
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "customer_notification_worker_delayed", code: /^[a-z_]+$/.test(error.code || "") ? error.code : "delivery_service_unavailable" }));
    } finally { running = false; }
  }
  return { tick };
}

function notificationService(invitationService, request) {
  return {
    settings: () => invitationService.settings(),
    claim: () => request(`${PREFIX}/claim`, { method: "POST" }),
    finish: (job, result) => request(`${PREFIX}/${encodeURIComponent(job.id)}/result`, { method: "POST", body: { lease_id: job.lease_id, ...result } }),
  };
}

// Runs alongside the invitation worker, under the same email configuration.
function startCustomerNotificationWorker(invitationService, request) {
  if (process.env.INVITATIONS_ENABLED !== "true") return;
  const worker = createCustomerNotificationWorker({ service: notificationService(invitationService, request) });
  const timer = setInterval(() => void worker.tick(), 30000);
  timer.unref();
  void worker.tick();
  return () => clearInterval(timer);
}

module.exports = { createCustomerNotificationWorker, notificationService, renderJob, startCustomerNotificationWorker };
