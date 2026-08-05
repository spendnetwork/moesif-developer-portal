# Plan change operations

## Invariants

- One Stripe customer per Open Opportunities organization.
- One current Stripe subscription per organization.
- At most one open plan change per organization.
- The current plan, permissions, and API keys remain unchanged until payment succeeds.
- Commitment credit is granted only from a paid commitment invoice.

## Required Stripe webhook events

Configure the portal backend `/stripe/webhook` endpoint with:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`

The endpoint must use `PORTAL_STRIPE_WEBHOOK_SECRET`. Stripe retries are safe:
SN API transitions are guarded and Stripe plan updates use an idempotency key based
on the persisted plan-change request ID.

## Deployment order

1. Deploy SN API code.
2. Check for duplicate portal organizations before applying the uniqueness migration:

   ```sql
   SELECT stripe_customer_id, count(*)
   FROM authorganization
   WHERE stripe_customer_id IS NOT NULL
     AND developer_portal_created = true
   GROUP BY stripe_customer_id
   HAVING count(*) > 1;
   ```

3. Resolve any returned duplicates, then run Alembic migrations through
   `d0e1f2a3b4c5`.
4. Verify the developer-portal subscription and plan-change routes.
5. Configure and verify the Stripe webhook events above.
6. Deploy the developer portal backend.
7. Deploy the developer portal frontend.
8. Run Stripe test-mode Basic to Growth and Growth to Enterprise upgrades through
   review, invoice payment, and entitlement activation.

Do not deploy the portal orchestration before the SN API migration and routes exist.

## State machine

Upgrades:

`pending_review` -> `approved` -> `invoice_open` -> `activating` -> `active`

Downgrades:

`scheduled` -> `activating` -> `active`

Payment failures move an upgrade to `payment_failed`. A customer can cancel before
an invoice is issued or downgrade activation begins. Terminal states are `active`,
`cancelled`, and `failed`.

## Approving an upgrade

Upgrade requests never charge a card automatically. Review the customer, target
plan, current credit, and `quoted_amount_gbp_pence`, then approve through the
protected SN API endpoint using the provisioning token:

```http
PATCH /api/v3/developer-portal/plan-changes/{request_id}
X-Developer-Portal-Token: {DEVELOPER_PORTAL_PROVISIONING_TOKEN}
Content-Type: application/json

{
  "status": "approved",
  "reviewed_by": "operator@spendnetwork.com"
}
```

The portal reconciliation worker then creates an exact Stripe `send_invoice`
invoice. Basic to Growth/Enterprise invoices the full commitment. Growth to
Enterprise invoices the GBP 7,000 difference. The current entitlement remains
unchanged until Stripe reports the invoice as paid.

## Reconciliation

The portal API reconciles due plan changes every five minutes by default using
`PLAN_CHANGE_RECONCILIATION_INTERVAL_MS`. The worker does not overlap runs and uses
the same persisted transitions and Stripe idempotency keys as webhook processing.
Stripe webhooks remain the primary activation path; reconciliation is the fallback.

Alert on:

- more than one live Stripe subscription for a customer;
- plan changes left in `activating` for more than 15 minutes;
- plan changes left in `awaiting_current_invoice` after their effective date;
- `invoice.payment_failed` events;
- Stripe webhook responses other than 2xx;
- SN API provisioning failures during activation.

For a stuck change, compare the persisted request ID with
`subscription.metadata.plan_change_request_id` and the associated Stripe invoices
before retrying the webhook. Never create a replacement subscription to recover a
plan change.

## Supported transitions

- Basic to Growth
- Basic to Enterprise
- Growth to Enterprise
- Growth or Enterprise downgrades scheduled for the commitment boundary

Upgrades require operator review. Existing monetary credit remains on the Stripe
customer; the paid difference is added as a new credit grant and new rates apply
only after activation.

A downgrade to Basic ends the recurring Stripe subscription at the boundary and
restores the non-recurring prepaid Basic entitlement. The downgrade does not
invent credit: existing Basic credit remains available, otherwise the customer
must add credit before billable API calls can continue.

## Entitlement reconciliation

Stripe is the billing authority and SN API is the entitlement authority. Moesif
is used for metering and analytics, but never decides whether an API key works.

The same idempotent reconciliation operation runs from the Checkout return,
`checkout.session.completed`, active subscription lifecycle events, and as a
self-heal when the Billing or API Keys page detects stale SN API context. It:

- resolves the Stripe customer by canonical customer ID or Auth0 metadata;
- refuses to guess when duplicate customers or subscriptions exist;
- ensures all metered prices for the selected product are attached;
- updates the SN API subscription, plan, billing status, and role;
- clears cached SN API permissions;
- writes canonical user/company IDs back to Stripe and Moesif;
- grants credits using Stripe idempotency keys.

An existing unscoped portal API key immediately receives the permissions of the
new role after a successful plan change. A key created with explicit scopes stays
bounded by those scopes. Cancelled or revoked keys are never resurrected after a
new purchase; the customer creates a fresh key.
