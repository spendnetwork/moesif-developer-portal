"use strict";
// Delivers SN API's customer and staff outbox. SN API resolves active company
// admins and cancels notices that no longer describe the account.
const { createNotificationEmail, emailSettings } = require("./notificationEmail");

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
      return { company, portalUrl, heading: "The staff pause on your account was removed",
        message: `Our team has removed the account pause for ${company}. Requests still require sufficient valid credit, accepted terms and an active API key. Check your account status in the portal before resuming requests.` };
    case "development_granted":
      return { heading: "Your development credit is ready", portalUrl,
        message: `${money(payload.amount_gbp_pence)} development credit has been granted to ${company}. It is metered at Basic rates${payload.expires_at ? ` and expires on ${displayDate(payload.expires_at)}` : ""}. Purchased credit is kept separately.` };
    case "credit_low":
    case "credit_exhausted": {
      const funding = payload.funding === "development" ? "development" : "purchased";
      return { heading: job.kind === "credit_low" ? "Your API credit is running low" : "Check your API credit balance", portalUrl,
        message: `${company} has ${money(payload.remaining_gbp_pence)} ${funding} credit remaining. ${payload.threshold}% utilisation has been reached, or this balance cannot cover a requested operation. Other eligible credit may still be available. Check Billing to review your balance and purchase credit from GBP 50. API requests require sufficient valid credit.` };
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
    default:
      throw deliveryError("UnknownNotificationKind", true);
  }
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
      // Plain text blocks prevent names or payload values from mentioning a channel.
      const summary = job.kind === "delivery_failed"
        ? { heading: "Customer notification delivery failed", message: `Notification: ${job.payload.notification_kind}. Check notification health and provider configuration.` }
        : renderJob(job, service.settings().origin);
      const detail = job.kind === "payment_confirmed"
        ? `${summary.amount} payment confirmed. Available credit: ${summary.available}. ${summary.pricingLine}`
        : summary.message || summary.explanation || summary.heading || "Account event confirmed.";
      const text = `${job.kind.replaceAll("_", " ")}\nCompany ${job.organization_id}: ${job.company}\n${detail}`;
      const response = await fetchImpl(url.href, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Open Opportunities account notification",
          blocks: [{ type: "section", text: { type: "plain_text", text: text.slice(0, 2900), emoji: false } }] }) });
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
    try {
      service.settings();
      if (service.scan && Date.now() >= nextScanAt) {
        try {
          const page = await service.scan(after);
          after = page.after;
          nextScanAt = after ? 0 : Date.now() + 300000;
          const health = await service.health();
          if (health.failed || health.undeliverable || health.oldest_pending_seconds > 900) {
            console.warn(JSON.stringify({ event: "notification_queue_unhealthy", ...health }));
          }
        } catch { console.warn(JSON.stringify({ event: "notification_scan_delayed" })); }
      }
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

module.exports = { createCustomerNotificationWorker, notificationService, notificationSettings, renderJob, startCustomerNotificationWorker };
