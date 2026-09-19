# Wallet card and invoice payments

Growth (GBP 5,000) and Enterprise (GBP 12,000) offer card checkout first, with an invoice alternative. Both are one-off purchases, not Stripe recurring subscriptions. Each adds credit and starts or restarts the package's 12-month pricing period when payment clears. Credit-only purchases retain their current pricing; purchases below GBP 5,000 use card, and larger credit-only purchases use invoices.

## Payment flow

1. The authenticated customer selects a package and payment method. Exact package amounts are enforced by the portal backend and SN API.
2. SN API records an unpaid purchase. Recording it grants no credit or pricing entitlement.
3. Card purchases open Stripe Checkout in payment mode. The verified webhook and checkout return use the same confirmation path and payment reference.
4. Confirmation verifies the customer, organisation, stored purchase, package, amount, currency and successful payment. Refunded or disputed payments cannot grant credit. SN API applies the payment atomically and returns the original receipt on duplicate confirmations.
5. Invoice purchases remain unpaid until staff confirm cleared funds in the admin tool. Staff recording always uses the invoice provider.

Growth cannot be purchased while Enterprise pricing is active. Existing API safeguards also handle a Growth checkout paid after another purchase activates Enterprise, without silently downgrading the account.

## Recovery

The browser retains the purchase UUID and payment method across cancellations, errors and refreshes. Pending purchases resume the same request rather than silently starting another payment. Uncertain requests older than Stripe's protected retry window require review. Existing saved requests that omit the payment method retain their previous invoice/card routing.

## Deployment and setup

- Deploy SN API on `moesif-dev` first, then the developer portal on `staging`. The API must accept card-funded pricing packages before the portal exposes checkout.
- No new database migration or admin tool change is required for this feature.
- Reuse the existing Stripe secret key and signed webhook configuration in the appropriate test/live environment. No new Stripe product or price IDs are required: checkout uses server-created, one-off price data.
- Keep the existing wallet checkout completion and refund/dispute webhook handling enabled. Do not restore legacy recurring usage subscriptions.
- Test with Stripe test mode: successful payment, authentication challenge, failed/cancelled payment, webhook retry, invoice confirmation, package renewal and Enterprise-to-Growth rejection. Automated checks do not substitute for a real test-mode webhook delivery check after deployment.

## Verification

Portal backend tests cover payment verification, provider and identity mismatches, stable checkout retries and compatibility. SN API wallet tests cover unpaid purchases, atomic duplicate confirmation, credit grants and pricing renewal. Browser tests cover card-first selection, invoices, mobile layout and recovery using mocked payments; they do not charge a card.
