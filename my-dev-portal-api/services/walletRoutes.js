const { createPurchase, reconcilePayment, requestIdentity } = require("./walletPayments");

function installWalletRoutes(app, { auth, jsonParser, serviceTokenMatches, deps, invalidate }) {
  const respondError = (res, error) => {
    const code = typeof error.code === "string" && /^[a-z_]+$/.test(error.code) ? error.code : "wallet_service_unavailable";
    console.warn(JSON.stringify({ event: "wallet_request_failed", code, status: error.status || 503 }));
    const messages = {
      legacy_wallet_reconciliation_required: "This account needs a balance review before wallet purchases can be enabled. Contact our team.",
      enterprise_pricing_still_active: "Growth is available after your Enterprise pricing period ends. You can still buy credit.",
      prepaid_not_enabled: "Prepaid purchases have not been enabled on the API yet. No credit was added.",
      invalid_credit_amount: "The minimum credit purchase is GBP 50. Enter an amount with at most two decimal places.",
      invalid_payment_time: "Enter the actual cleared payment date, not a future date. No credit was added.",
      wallet_checkout_review_required: "This earlier checkout needs a payment review. Contact our team before paying again.",
      migration_balance_changed: "The balance differs from the reviewed amount. Refresh and reconcile it before continuing.",
      pause_access_before_migration: "Pause API access before confirming this migration.",
      pending_usage_requires_reconciliation: "Outstanding usage must be reconciled before migration.",
      resolve_pending_plan_changes: "Resolve the pending plan changes or invoices before migration.",
      migration_subscription_conflict: "The current subscription has changed. Refresh and review it before migration.",
    };
    return res.status(error.status >= 400 && error.status <= 599 ? error.status : 503).json({ code,
      message: messages[code] || (error.status === 422 ? "Check the entered values. This request was rejected before changing credit." : "We could not confirm this purchase. Retry the same request; do not make another payment.") });
  };
  function admin(req, res, next) {
    if (!process.env.ADMIN_PLAN_CHANGE_TOKEN) return res.status(503).json({ code: "admin_not_configured" });
    if (!serviceTokenMatches(req.headers["x-admin-service-token"], process.env.ADMIN_PLAN_CHANGE_TOKEN)) {
      return res.status(401).json({ code: "unauthorized" });
    }
    next();
  }
  app.post("/wallet/purchases", auth, jsonParser, async (req, res) => {
    try {
      const result = await createPurchase(req.user, req.body, deps);
      invalidate(req.user.sub);
      res.status(200).json(result);
    } catch (error) { respondError(res, error); }
  });
  app.get("/wallet/purchases", auth, async (req, res) => {
    try { res.json(await deps.listWalletPurchases(req.user)); }
    catch (error) { respondError(res, error); }
  });
  app.post("/admin/wallet-purchases", admin, jsonParser, async (req, res) => {
    try {
      const user = { sub: req.body.auth0UserId };
      const context = await deps.getSnApiPortalContext(user);
      if (!req.body.requested_by || Number(context.organization_id) !== req.body.organizationId) {
        return res.status(409).json({ code: "organization_identity_mismatch" });
      }
      // Small purchases are self-service card payments, never an admin grant.
      if (req.body.amountGbp < 5000) return res.status(422).json({ code: "card_purchase_required" });
      const result = await createPurchase(user, req.body, deps, req.body.requested_by);
      invalidate(user.sub);
      res.json(result);
    } catch (error) { respondError(res, error); }
  });
  app.post("/admin/wallet-migration", admin, jsonParser, async (req, res) => {
    try {
      const user = { sub: req.body.auth0UserId };
      const context = await deps.getSnApiPortalContext(user);
      if (context.organization_id !== req.body.organizationId) return res.status(409).json({ code: "organization_identity_mismatch" });
      const result = await deps.migrateWallet({ request_id: requestIdentity(req.body.requestId),
        auth0_user_id: user.sub, organization_id: context.organization_id,
        expected_subscription_id: req.body.expectedSubscriptionId,
        expected_paid_remaining_pence: req.body.expectedPaidRemainingPence,
        latest_purchase_at: req.body.latestPurchaseAt, verified_by: req.body.verifiedBy,
        verification_reference: req.body.verificationReference,
        providers_stopped_and_usage_reconciled: req.body.reconciled });
      invalidate(user.sub); res.json(result);
    } catch (error) { respondError(res, error); }
  });
  app.post("/admin/wallet-purchases/:id/confirm", admin, jsonParser, async (req, res) => {
    try {
      const user = { sub: req.body.auth0UserId };
      const context = await deps.getSnApiPortalContext(user);
      if (context.organization_id !== req.body.organizationId || !req.body.confirmedBy || req.body.fundsCleared !== true) {
        return res.status(422).json({ code: "payment_confirmation_required" });
      }
      const purchase = await deps.getWalletPurchase(user, requestIdentity(req.params.id));
      if (!purchase || purchase.payment_provider !== "invoice") return res.status(404).json({ code: "invoice_purchase_not_found" });
      const result = await deps.confirmWalletPayment(purchase.request_id, {
        organization_id: context.organization_id, payment_reference: req.body.invoiceReference,
        amount_gbp_pence: purchase.amount_gbp_pence, currency: "GBP",
        paid_at: req.body.paidAt, confirmed_by: req.body.confirmedBy,
      });
      invalidate(user.sub);
      res.json(result);
    } catch (error) { respondError(res, error); }
  });
  return {
    reconcile: (sessionId, user) => reconcilePayment(sessionId, user, deps),
    review: event => require("./walletPayments").reviewPaymentEvent(event, deps),
  };
}

module.exports = { installWalletRoutes };
