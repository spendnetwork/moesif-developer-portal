function stripeId(value) {
  return typeof value === "string" ? value : value?.id;
}

function invoiceSubscriptionId(invoice) {
  return stripeId(invoice?.subscription) ||
    stripeId(invoice?.parent?.subscription_details?.subscription);
}

function invoicePlanChangeRequestId(invoice) {
  return invoice?.metadata?.openopps_plan_change_request_id || null;
}

function invoiceMatchesPlanChange(invoice, planChange) {
  if (invoicePlanChangeRequestId(invoice) === planChange.request_id) return true;
  if (planChange.commitment_invoice_id === invoice?.id) return true;
  return Boolean(
    planChange.stripe_subscription_id &&
      invoiceSubscriptionId(invoice) === planChange.stripe_subscription_id
  );
}

async function completePlanChange(planChange, subscription, deps) {
  const customer = await deps.getStripeCustomerById(
    planChange.stripe_customer_id
  );
  const auth0UserId = customer.metadata?.authUserId;
  if (!auth0UserId || !customer.email) {
    throw new Error("Stripe customer is missing Auth0 identity metadata");
  }
  const price = subscription.items?.data?.[0]?.price;
  const product = typeof price?.product === "object" ? price.product : null;
  const provisioned = await deps.provisionSnApiCustomer({
    authUser: {
      sub: auth0UserId,
      email: customer.email,
      name: customer.name || customer.email,
    },
    customer,
    subscription,
    price,
    product,
  });
  await deps.updateStripeCustomerIdentity(customer.id, {
    moesifUserId: provisioned.user_id,
    moesifCompanyId:
      provisioned.moesif_company_id || provisioned.organization_id,
    auth0UserId,
    subscriptionId: subscription.id,
  });
  await deps.updateSnApiPlanChange(planChange.request_id, { status: "active" });
  return { status: "active", planChange, provisioned };
}

async function completeBasicDowngrade(planChange, deps) {
  const customer = await deps.getStripeCustomerById(planChange.stripe_customer_id);
  const auth0UserId = customer.metadata?.authUserId;
  if (!auth0UserId || !customer.email) {
    throw new Error("Stripe customer is missing Auth0 identity metadata");
  }
  const product = await deps.getStripeProduct(planChange.target_product_id);
  const prices = await deps.getPlanPrices(planChange.target_product_id);
  const meteredPrices = deps.validateBasicMeteredPrices(prices);
  const authUser = {
    sub: auth0UserId,
    email: customer.email,
    name: customer.name || customer.email,
  };
  const pending = await deps.provisionSnApiPrepaidCustomer({
    authUser,
    customer,
    product,
    subscriptionStatus: "provisioning",
  });
  const companyId = String(
    pending.moesif_company_id || pending.organization_id
  );
  await deps.syncToMoesif({
    companyId,
    userId: String(pending.user_id),
    email: customer.email,
    auth0UserId,
    stripeCustomerId: customer.id,
    planKey: "basic",
  });
  const moesifSubscriptionId = await deps.sendPrepaidSubscriptionToMoesif({
    companyId,
    stripeCustomerId: customer.id,
    planId: product.id,
    priceIds: meteredPrices.map((price) => price.id),
    currentPeriodStart: new Date().toISOString(),
    currentPeriodEnd: deps.prepaidSubscriptionPeriodEnd(),
  });
  await deps.endStripeSubscriptionForBasicDowngrade(planChange);
  const provisioned = await deps.provisionSnApiPrepaidCustomer({
    authUser,
    customer,
    product,
    subscriptionStatus: "active",
  });
  await deps.updateStripeCustomerIdentity(customer.id, {
    moesifUserId: provisioned.user_id,
    moesifCompanyId:
      provisioned.moesif_company_id || provisioned.organization_id,
    auth0UserId,
    subscriptionId: null,
  });
  await deps.updateSnApiPlanChange(planChange.request_id, { status: "active" });
  return {
    status: "active",
    planChange,
    provisioned,
    moesifSubscriptionId,
  };
}

async function processPaidInvoice(invoice, deps) {
  const customerId = stripeId(invoice?.customer);
  if (!customerId) return { skipped: "no_customer" };
  const planChange = await deps.getSnApiPlanChangeByCustomer(customerId);
  if (!planChange) return { skipped: "no_open_plan_change" };
  if (!invoiceMatchesPlanChange(invoice, planChange)) {
    return { skipped: "different_subscription" };
  }

  const isReviewedUpgrade =
    planChange.status === "invoice_open" ||
    (planChange.status === "payment_failed" &&
      planChange.change_type === "upgrade");
  if (isReviewedUpgrade) {
    if (planChange.commitment_invoice_id !== invoice.id) {
      return { skipped: "different_invoice" };
    }
    await deps.grantCommitmentFromInvoice(invoice);
    await deps.updateSnApiPlanChange(planChange.request_id, {
      status: "activating",
      failure_code: null,
      failure_message: null,
    });
    const subscription = await deps.activateReviewedPlanChange(planChange);
    return completePlanChange(planChange, subscription, deps);
  }

  if (
    planChange.status === "awaiting_commitment_payment" ||
    planChange.status === "payment_failed"
  ) {
    if (planChange.commitment_invoice_id !== invoice.id) {
      return { skipped: "different_invoice" };
    }
    await deps.grantCommitmentFromInvoice(invoice);
    const subscription = await deps.getStripeSubscription(
      planChange.stripe_subscription_id
    );
    return completePlanChange(planChange, subscription, deps);
  }

  if (
    !["scheduled", "awaiting_current_invoice", "activating"].includes(
      planChange.status
    )
  ) {
    return { skipped: `status_${planChange.status}` };
  }
  if (Date.now() < new Date(planChange.effective_at).getTime()) {
    return { skipped: "before_effective_at" };
  }

  if (planChange.status !== "activating") {
    await deps.updateSnApiPlanChange(planChange.request_id, {
      status: "activating",
      closing_invoice_id: invoice.id,
    });
  }
  const activation = await deps.activateStripePlanChange(planChange);
  if (!activation.commitmentRequired) {
    return completePlanChange(planChange, activation.subscription, deps);
  }

  const commitmentInvoiceId = activation.invoice?.id;
  if (!commitmentInvoiceId) {
    throw new Error("Commitment plan update did not create an invoice");
  }
  await deps.updateSnApiPlanChange(planChange.request_id, {
    status: "awaiting_commitment_payment",
    commitment_invoice_id: commitmentInvoiceId,
  });
  if (!activation.paymentPending && activation.invoice.status === "paid") {
    await deps.grantCommitmentFromInvoice(activation.invoice);
    return completePlanChange(planChange, activation.subscription, deps);
  }
  return {
    status: "awaiting_commitment_payment",
    planChange,
    invoice: activation.invoice,
  };
}

async function processFailedInvoice(invoice, deps) {
  const customerId = stripeId(invoice?.customer);
  if (!customerId) return { skipped: "no_customer" };
  const planChange = await deps.getSnApiPlanChangeByCustomer(customerId);
  if (!planChange) return { skipped: "no_open_plan_change" };
  if (!invoiceMatchesPlanChange(invoice, planChange)) {
    return { skipped: "different_subscription" };
  }

  const isCommitment = planChange.commitment_invoice_id === invoice.id;
  await deps.updateSnApiPlanChange(planChange.request_id, {
    status: isCommitment ? "payment_failed" : "awaiting_current_invoice",
    ...(isCommitment
      ? { commitment_invoice_id: invoice.id }
      : { closing_invoice_id: invoice.id }),
    failure_code: "invoice_payment_failed",
    failure_message: "Stripe could not collect the required payment.",
  });
  return { status: "payment_failed", planChange, invoice };
}

async function issueApprovedPlanChange(planChange, deps) {
  const issued = await deps.issueReviewedPlanChangeInvoice(planChange);
  const subscriptionId =
    issued.subscription?.id || planChange.stripe_subscription_id;
  const updated = {
    ...planChange,
    stripe_subscription_id: subscriptionId,
    commitment_invoice_id: issued.invoice.id,
    status: "invoice_open",
  };
  await deps.updateSnApiPlanChange(planChange.request_id, {
    status: "invoice_open",
    stripe_subscription_id: subscriptionId,
    commitment_invoice_id: issued.invoice.id,
    quoted_amount_gbp_pence: issued.amount,
    currency: String(
      issued.invoice.currency || planChange.currency || "gbp"
    ).toUpperCase(),
  });
  if (issued.invoice.status === "paid") {
    return processPaidInvoice(issued.invoice, {
      ...deps,
      getSnApiPlanChangeByCustomer: async () => updated,
    });
  }
  return { status: "invoice_open", planChange: updated, invoice: issued.invoice };
}

async function reconcileDuePlanChanges(deps) {
  const dueChanges = await deps.listSnApiDuePlanChanges(100);
  const results = [];
  for (const planChange of dueChanges) {
    try {
      if (planChange.status === "approved") {
        const result = await issueApprovedPlanChange(planChange, deps);
        results.push({ requestId: planChange.request_id, ...result });
        continue;
      }
      if (["invoice_open", "payment_failed"].includes(planChange.status)) {
        if (!planChange.commitment_invoice_id) {
          results.push({
            requestId: planChange.request_id,
            skipped: "invoice_not_ready",
          });
          continue;
        }
        const invoice = await deps.getStripeInvoice(
          planChange.commitment_invoice_id
        );
        if (["void", "uncollectible"].includes(invoice.status)) {
          await deps.updateSnApiPlanChange(planChange.request_id, {
            status: "failed",
            failure_code: `invoice_${invoice.status}`,
            failure_message: `Stripe marked the commitment invoice as ${invoice.status}.`,
          });
          results.push({
            requestId: planChange.request_id,
            status: "failed",
            invoice,
          });
          continue;
        }
        const result =
          invoice.status === "paid"
            ? await processPaidInvoice(invoice, deps)
            : { skipped: `invoice_${invoice.status}` };
        results.push({ requestId: planChange.request_id, ...result });
        continue;
      }
      if (
        planChange.status === "scheduled" &&
        planChange.change_type === "downgrade"
      ) {
        if (planChange.to_plan_key === "basic") {
          const result = await completeBasicDowngrade(planChange, deps);
          results.push({ requestId: planChange.request_id, ...result });
          continue;
        }
        const subscription = await deps.activateReviewedPlanChange(planChange);
        const result = await completePlanChange(planChange, subscription, deps);
        results.push({ requestId: planChange.request_id, ...result });
        continue;
      }
      const invoices = await deps.listStripeInvoices(
        planChange.stripe_subscription_id,
        10
      );
      const effectiveAt = new Date(planChange.effective_at).getTime() / 1000;
      const relevantInvoice = invoices.find(
        (invoice) =>
          invoice.id === planChange.commitment_invoice_id ||
          invoice.id === planChange.closing_invoice_id ||
          invoice.created >= effectiveAt - 3600
      );
      if (!relevantInvoice) {
        results.push({
          requestId: planChange.request_id,
          skipped: "invoice_not_ready",
        });
        continue;
      }
      const result =
        relevantInvoice.status === "paid"
          ? await processPaidInvoice(relevantInvoice, deps)
          : relevantInvoice.status === "open" && relevantInvoice.attempt_count > 0
            ? await processFailedInvoice(relevantInvoice, deps)
            : { skipped: `invoice_${relevantInvoice.status}` };
      results.push({ requestId: planChange.request_id, ...result });
    } catch (error) {
      console.error(
        `Plan change reconciliation failed for ${planChange.request_id}`,
        error
      );
      results.push({ requestId: planChange.request_id, error: error.message });
    }
  }
  return results;
}

module.exports = {
  invoiceSubscriptionId,
  invoicePlanChangeRequestId,
  invoiceMatchesPlanChange,
  completeBasicDowngrade,
  processPaidInvoice,
  processFailedInvoice,
  issueApprovedPlanChange,
  reconcileDuePlanChanges,
};
