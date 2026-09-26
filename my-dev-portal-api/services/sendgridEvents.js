"use strict";
const { createPublicKey, verify } = require("node:crypto");

// Verify the timestamp and exact raw bytes, before parsing any provider data.
function verifyEvents(raw, signature, timestamp, publicKey) {
  if (!Buffer.isBuffer(raw) || typeof signature !== "string" || !/^\d{1,12}$/.test(timestamp || "")) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec") return false;
    return verify("sha256", Buffer.concat([Buffer.from(timestamp), raw]), key, Buffer.from(signature, "base64"));
  } catch { return false; }
}

function createSendgridEventHandler({ request, env = process.env }) {
  return async (req, res) => {
    if (!env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY) return res.status(503).json({ code: "email_feedback_not_configured" });
    if (!verifyEvents(req.body, req.headers["x-twilio-email-event-webhook-signature"],
      req.headers["x-twilio-email-event-webhook-timestamp"], env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY)) {
      return res.status(401).json({ code: "invalid_email_event_signature" });
    }
    let events;
    try {
      const values = JSON.parse(req.body.toString("utf8"));
      if (!Array.isArray(values) || values.length > 1000) throw new Error();
      events = values.filter(item => ["delivered", "bounce", "dropped", "spamreport"].includes(item.event) && item.delivery_id)
        .map(item => ({ delivery_id: item.delivery_id, email: item.email, event: item.event, timestamp: item.timestamp }));
    } catch { return res.status(400).json({ code: "invalid_email_events" }); }
    try {
      if (events.length) await request("/api/v3/developer-portal/notification-deliveries/provider-events", { method: "POST", body: { events } });
      return res.status(200).json({ received: true });
    } catch {
      // Provider retries; never log the body, which contains customer addresses.
      console.warn(JSON.stringify({ event: "email_feedback_delayed" }));
      return res.status(503).json({ code: "email_feedback_delayed" });
    }
  };
}

module.exports = { verifyEvents, createSendgridEventHandler };
