function stripeId(value) {
  return typeof value === "string" ? value : value?.id;
}

function invoiceSubscriptionId(invoice) {
  return stripeId(invoice?.subscription) ||
    stripeId(invoice?.parent?.subscription_details?.subscription);
}

async function completePlanChange(planChange, subscription, deps) {
  const customer = await deps.getStripeCustomerById(planChange.stripe_customer_id);
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

async function processPaidInvoice(invoice, deps) {
  const customerId = stripeId(invoice?.customer);
  if (!customerId) return { skipped: "no_customer" };
  const planChange = await deps.getSnApiPlanChangeByCustomer(customerId);
  if (!planChange) return { skipped: "no_open_plan_change" };
  if (invoiceSubscriptionId(invoice) !== planChange.stripe_subscription_id) {
    return { skipped: "different_subscription" };
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

  if (!["scheduled", "awaiting_current_invoice", "activating"].includes(planChange.status)) {
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
  if (invoiceSubscriptionId(invoice) !== planChange.stripe_subscription_id) {
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

async function reconcileDuePlanChanges(deps) {
  const dueChanges = await deps.listSnApiDuePlanChanges(100);
  const results = [];
  for (const planChange of dueChanges) {
    try {
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
        results.push({ requestId: planChange.request_id, skipped: "invoice_not_ready" });
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
  processPaidInvoice,
  processFailedInvoice,
  reconcileDuePlanChanges,
};
