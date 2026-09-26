"use strict";
const { renderJob } = require("./customerNotificationDelivery");
const { renderEmail } = require("./notificationEmail");

function installNotificationRoutes(app, { auth, request, origin }) {
  app.get("/notifications", ...auth, async (req, res) => {
    try {
      const rows = await request(`/api/v3/developer-portal/customer-notifications?auth0_user_id=${encodeURIComponent(req.user.sub)}`, { method: "GET" });
      return res.json(rows.map(row => {
        const content = renderJob(row, origin);
        const heading = renderEmail(row.kind, content).subject;
        const message = content.message || content.explanation || (row.kind === "welcome"
          ? "Your Open Opportunities account is ready. Choose a plan or contact us about development credit."
          : row.kind === "payment_confirmed" ? `${content.amount} credit was confirmed. ${content.pricingLine || ""} Review your current balance in Billing.`
          : heading);
        return { id: row.id, heading, message, created_at: row.created_at, read_at: row.read_at };
      }));
    } catch (error) {
      return res.status(error.status === 403 ? 403 : 503).json({ message: error.status === 403
        ? "Account notifications are available to company administrators." : "Notifications could not be loaded. Please try again." });
    }
  });
  app.post("/notifications/:id/read", ...auth, async (req, res) => {
    try {
      await request(`/api/v3/developer-portal/customer-notifications/${encodeURIComponent(req.params.id)}/read?auth0_user_id=${encodeURIComponent(req.user.sub)}`, { method: "POST" });
      return res.json({ ok: true });
    } catch (error) {
      return res.status([403, 404].includes(error.status) ? error.status : 503).json({ message: "The notification could not be marked as read. Please try again." });
    }
  });
}
module.exports = { installNotificationRoutes };
