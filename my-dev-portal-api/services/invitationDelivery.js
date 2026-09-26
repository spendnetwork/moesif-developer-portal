"use strict";
const { createNotificationEmail } = require("./notificationEmail");
function deliveryError(code) { return Object.assign(new Error(code), { name: code }); }
function displayDate(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw deliveryError("InvalidCreditExpiry");
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
}

function createDeliveryWorker({ service, email, env = process.env, fetcher = fetch }) {
  let running = false;
  async function deliver(job) {
    const invite = job.invitation;
    const team = invite.kind === "team_member";
    if (job.kind === "accepted_slack") {
      const webhook = new URL(env.INVITATION_SLACK_WEBHOOK_URL);
      if (webhook.protocol !== "https:" || !["hooks.slack.com", "hooks.slack-gov.com"].includes(webhook.hostname)) throw deliveryError("InvalidSlackConfiguration");
      const text = team
        ? `Teammate joined\n${invite.full_name} (${invite.email})\n${invite.company_name}\nTeam invitation: no credit granted.\nInvitation: ${invite.id}`
        : `Invitation accepted\n${invite.full_name} (${invite.email})\n${invite.company_name}\nGBP ${(invite.amount_gbp_pence / 100).toFixed(2)} development credit granted for ${invite.validity_days} days.\nInvitation: ${invite.id}`;
      const response = await fetcher(webhook, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blocks: [{ type: "section", text: { type: "plain_text", text } }] }) });
      if (!response.ok || (await response.text()).trim() !== "ok") throw deliveryError("SlackDeliveryRejected");
      return "slack";
    }
    const invitation = job.kind === "invite";
    if (!invitation && job.kind !== "accepted_email") throw deliveryError("UnknownDeliveryKind");
    if (team) {
      const origin = service.settings().origin;
      if (invitation) {
        return (email || createNotificationEmail({ env })).send({ kind: "team_invite", to: invite.email, deliveryId: job.id,
          data: { name: invite.full_name || "", company: invite.company_name || "", invitationUrl: service.link(invite.id),
            invitationExpiresAt: displayDate(invite.expires_at) } });
      }
      // Admins only; sn-api resolves them and cancels the job when there are none.
      const recipients = Array.isArray(job.recipients) ? job.recipients.filter(item => typeof item === "string" && item) : [];
      if (!recipients.length) throw Object.assign(deliveryError("NoAdminRecipients"), { permanent: true });
      return (email || createNotificationEmail({ env })).send({ kind: "team_joined", to: recipients, deliveryId: job.id,
        data: { memberName: invite.full_name || invite.email, memberEmail: invite.email, company: invite.company_name || "",
          teamUrl: `${origin}/settings` } });
    }
    const data = {
      name: invite.full_name || "", company: invite.company_name || "",
      creditAmount: (invite.amount_gbp_pence / 100).toFixed(2), currency: "GBP", validityDays: String(invite.validity_days),
      invitationUrl: invitation ? service.link(invite.id) : `${service.settings().origin}/dashboard`,
      portalUrl: `${service.settings().origin}/dashboard`,
      invitationExpiresAt: invitation ? displayDate(invite.expires_at) : "",
      creditExpiresAt: invitation ? "" : displayDate(invite.credit_receipt?.expires_at),
    };
    return (email || createNotificationEmail({ env })).send({
      kind: job.kind, to: invite.email, data, deliveryId: job.id,
    });
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
          console.warn(JSON.stringify({ event: "invitation_delivery_failed", deliveryId: job.id, code: result.failure_code, retryable: !error.permanent }));
        }
        // An acknowledgement failure leaves the lease to expire. Never undo a credit grant.
        // Retry the acknowledgement, never the provider send, after a lost HTTP response.
        for (let attempt = 0; ; attempt++) {
          try { await service.finish(job, result); break; }
          catch (error) {
            if (attempt >= 2 || (error.status && error.status < 500)) throw error;
          }
        }
        console.info(JSON.stringify({ event: "invitation_delivery_processed", deliveryId: job.id, kind: job.kind, result: result.result }));
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "invitation_worker_delayed", code: /^[a-z_]+$/.test(error.code || "") ? error.code : "delivery_service_unavailable" }));
    } finally { running = false; }
  }
  return { tick };
}

function startInvitationWorker(service) {
  if (process.env.INVITATIONS_ENABLED !== "true") return;
  const worker = createDeliveryWorker({ service });
  const timer = setInterval(() => void worker.tick(), 30000);
  timer.unref();
  void worker.tick();
  return () => clearInterval(timer);
}

module.exports = { createDeliveryWorker, startInvitationWorker };
