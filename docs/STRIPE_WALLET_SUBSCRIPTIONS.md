# Stripe subscriptions funding prepaid wallets

## Behaviour

This checkout uses the existing Stripe-provider products/prices displayed in
Moesif. It does not use Custom-provider plans to collect card payments.

| Purchase | Stripe checkout | Credit |
| --- | --- | --- |
| First Basic card purchase | GBP 0 recurring licensed price plus the initial one-off top-up | Actual cleared top-up, minimum GBP 50 |
| Subsequent credit purchase | One-off payment under the existing product | Actual cleared top-up; pricing unchanged |
| Growth | Existing GBP 5,000 annual licensed price | GBP 5,000 on each verified paid invoice |
| Enterprise | Existing GBP 12,000 annual licensed price | GBP 12,000 on each verified paid invoice |
| External invoice | Existing admin purchase/confirmation workflow | Only after staff confirm cleared funds |

Basic's zero-value renewal invoices grant nothing and collect nothing. Annual
subscriptions renew automatically; terms are disclosed before redirecting to
Stripe. Failed payments grant no new credit. Existing eligible wallet credit
remains available at the applicable rate. Usage still stops when credit cannot
cover a request. Neither usage overages nor automatic top-ups are introduced.

Annual payment receipts start the pricing term from cleared payment, retaining
the wallet's existing expiry rules. Stripe's renewal billing schedule remains
its own subscription schedule; late payment does not move that schedule.

## Required setup before enabling

1. Deploy SN API migration `7de4c5d6e7f8` and its subscription endpoints first.
2. Under the **existing Basic Stripe product**, create a GBP 0 fixed recurring
   licensed price (monthly or yearly). Do not select a metered usage price.
3. Use the existing Growth GBP 5,000/year and Enterprise GBP 12,000/year fixed
   licensed prices. Currency must be GBP, quantity one, interval count one.
4. Configure these **portal backend** variables in local `.env` or deployed
   environment/SSM injection. Do not expose them as frontend configuration:

```dotenv
STRIPE_WALLET_SUBSCRIPTIONS_ENABLED=false
STRIPE_WALLET_BASIC_PRICE_ID=price_...
STRIPE_WALLET_GROWTH_PRICE_ID=price_...
STRIPE_WALLET_ENTERPRISE_PRICE_ID=price_...
```

These are Stripe `price_` IDs, not `prod_` IDs or Moesif plan IDs. The explicit
allowlist avoids accidentally selecting one of the four usage prices.

5. The existing signed `/stripe/webhook` must receive:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.created/updated/deleted/paused/resumed`,
   `charge.refunded`, and `charge.dispute.created`.
   A restricted Stripe key needs access to prices/products, customers,
   Checkout Sessions, subscriptions, invoices, invoice payments and PaymentIntents,
   including the customer/subscription/Checkout writes used by this flow.
6. Test in Stripe test mode, then enable the flag and restart the portal backend.
   The frontend reads payment terms from `/wallet/payment-options`.

The rollout flag only changes new purchases. Webhooks for subscriptions already
created with `purchase_type=wallet_subscription` continue to work when disabled.
Existing uncertain one-off checkout requests must be resolved before switching
the flag: the saved request contract rejects a mode change, rather than creating
a second checkout under another idempotency key.

These fixed-price subscriptions do not currently support coupons, trials,
proration, Stripe customer-balance funding, manually marked-paid card invoices,
or additional tax/fee line items. Such invoices fail verification and require
review instead of granting the wrong amount. Do not edit the wallet subscription
metadata or add usage prices in the Stripe Dashboard.

No live Stripe catalogue changes, billing charges, database migrations or
deployment are performed merely by applying this code change.

## Moesif and avoiding double billing

The Stripe integration can display/sync these subscriptions and their existing
products. Canonical customer identity metadata is set before checkout.
**Do not attach the four metered usage prices to wallet subscriptions.** The
subscription includes only its fixed recurring price; usage is deducted by the
API from PostgreSQL. The legacy metered-price attachment path explicitly rejects
wallet-owned subscriptions.

Keep Custom-provider plans for external-invoice/reporting workflows. Reporting
meters must not issue a second Stripe usage invoice for wallet-funded requests.
The local subscription ID used for financial settlement remains distinct from
the Stripe collection subscription ID. Do not assume that adding a Stripe
subscription automatically remaps existing Moesif subscription-filtered charts.
Company-scoped analytics and local wallet financial totals remain authoritative
for their respective purposes. Validate live Moesif mappings separately.

## Subscription changes and cancellation

- A paid annual subscription cannot be duplicated by opening another checkout.
  Growth-to-Enterprise changes and early re-commitments on a live card
  subscription remain **staff-assisted**, not a self-service subscription-update
  or automatic proration flow. The customer receives an actionable message.
- Staff must stop the old subscription's renewal in Stripe and reconcile it
  before creating another annual card subscription or confirming a conflicting
  external invoice. Merely scheduling cancellation at period end does not release
  the reservation; the subscription must actually be canceled when replacing it.
- Basic-to-annual replacement closes only the verified GBP 0 Basic subscription,
  without proration or an invoice, before opening the paid checkout. Existing
  wallet credit is preserved even if that checkout is abandoned. Do not cancel
  a customer's paid commitment just to work around a checkout conflict.
- Cancellation leaves already-purchased credit and its applicable pricing term
  intact. A later creation event cannot reopen a closed subscription binding.
- A failed/paused renewal never grants fresh credit and does not confiscate
  previous purchases. Refunds/disputes pause API access for staff review; they do
  not silently rewrite the ledger.
- An expired unpaid Stripe Checkout releases its reservation. The frontend
  recognizes the canceled purchase and allows a new purchase.

## Transaction and recovery design

`billing_wallet_card_subscription` binds a purchase, organisation, Stripe
customer, price and subscription. A database partial unique index allows at most
one pending/open binding per organisation. Reservation and financial writes lock
the organisation, so multiple backend instances do not rely on an in-memory lock.

The portal retrieves the invoice, subscription, price, customer and successful
PaymentIntent from Stripe. It verifies identity, GBP amount, exact line items,
payment allocation, no refunds/disputes and no unexpected proration before
calling the service-token-protected API endpoint. Marking an invoice paid outside
Stripe is not sufficient proof for the card path.

The first paid invoice funds the original purchase. Renewal purchases use a
deterministic UUID derived from the Stripe invoice ID. Binding, credit lot,
ledger, purchase receipt and pricing are committed together. Webhook and browser
reconciliation share this path, and repeated/out-of-order invoices cannot grant
the same payment twice or roll pricing back behind a newer purchase.

An external timeout retains the checkout reservation and same idempotency key.
Do not delete that reservation to retry a payment. Check Stripe for the original
Checkout; resume/reconcile it or let a confirmed expiry release it. Requests older
than the provider idempotency safety window require staff reconciliation.

## Acceptance checks

- All three checkouts use approved existing Stripe products, with no metered items.
- Annual renewal grants once; duplicate and out-of-order events are safe.
- Basic zero renewal grants nothing; top-ups do not reset paid pricing.
- Unpaid, mismatched, refunded, disputed and manually marked-paid invoices fail closed.
- Concurrent checkouts cannot create competing reservations.
- Existing prepaid API exhaustion checks and promotional-credit priority still pass.
- Customer cancellation and failed renewal do not erase previously purchased credit.
- Live webhook delivery, Moesif mapping and a full Stripe test-card checkout must
  be verified in the target environment before production rollout.
