# Prepaid and Development Integration

Shared Development allowance changes are on `feat/development_credits` across
the API, admin tool and portal. Deploy the API and compatible admin consumer
before the portal. This change does not itself deploy or mutate live billing.

## Readiness and Ownership

- Before every new Basic Checkout session, read the API's
  `/api/v3/developer-portal/usage-summary?auth0_user_id=...` and require the exact
  boolean `prepaid_enabled: true`. False, missing, 404 or unavailable summary
  blocks checkout. This preflight never provisions, switches plans or grants credit.
- Existing Basic must also have an API-owned subscription in that fresh summary.
  Legacy Basic remains readable, but new purchases return
  `legacy_basic_migration_required` until deliberate migration is complete.
- The API flag is `API_PREPAID_ENABLED`. No new portal or admin feature flag is used.
- Local balances and settled metric costs are authoritative for
  `debit_owner: api` and manually invoiced plans with `balance_authority: local_ledger`.
  Development is organisation-scoped; paid balances and usage stay subscription-scoped.
  Remaining eligible credit is separate from spendable credit during a pause.

## Payments and Allowances

- New Basic purchases and top-ups require GBP 100 or more. Existing verified paid
  sessions below that minimum remain eligible for reconciliation.
- Signed webhooks and authenticated returns both re-fetch Checkout from Stripe,
  verify paid status, PaymentIntent, customer, identity, currency and line item,
  then register credit through API `/paid-credits`. The PaymentIntent is the stable
  paid-credit reference. API provision receipts also use a deterministic key.
- Already-paid callbacks do not use the new checkout readiness gate. They keep
  retrying reconciliation safely; operators must not ask the customer to pay again.
- Replays cannot replace a newer active plan. No credit is created by a success
  redirect, and no automatic development grant remains in reconciliation.
- Development grants enter the existing service-token-protected
  `/admin/development-credit` route. Body and header request UUIDs must match.
  The verified admin actor is forwarded only after service-token authorization.
  Identity/organization is checked at the proxy and inside the API transaction.
  A single grant call creates Development access only if no plan exists;
  otherwise it preserves the customer's current plan. The payload deliberately
  omits subscription_id, making retries stable across plan changes.
- Admin Move to Basic from Development or no plan returns `paymentRequired` and
  `paymentUrl` without changing the plan. Manual Growth/Enterprise commitments
  request their full amount, without subtracting Development credit.

Paid plans start on activation, not after Development is exhausted. Remaining
Development credit is spent first at the active plan's rates, without changing
its expiry. A new discretionary grant can be added to supported paid plans.
The Plans page hides the Development request banner after paid activation;
admin grants remain available. Usage shows Development and paid balances
separately and preserves the subscription's annual dates.

## Legacy and Scheduled Boundaries

Never infer an empty legacy balance or send automatic bootstrap attestations.
A controlled migration must freeze old writers, settle pending usage, verify all
balances and preserve historical credit. Positive or unknown legacy credit must
not be silently reset, copied or made newly spendable.

The existing Stripe-scheduled Growth/Enterprise-to-Basic worker sends `plan_change_request_id`
to `/prepaid/provision`, with a stable `downgrade-...` operation ID. The API must
authorize the persisted due boundary against its source subscription and current
organization. The result must be an unfunded API-owned Basic subscription, with
historical credit kept separate. Only after API confirmation does the portal
finish recurring-billing cleanup. API refusal leaves that cleanup unperformed.
The API atomically moves the request to `activating`; after source-only Stripe
cleanup, the portal marks it `active`. Retries in both `scheduled` and `activating`
states reuse the same operation. Customer-wide Stripe identity metadata is not
rewritten, so old cleanup cannot erase a newer subscription reference. Legacy
bootstrap proof is not a substitute for persisted boundary authorization.

This does not add a manual-provider downgrade scheduler. Manual-provider annual
transitions were not verified by this boundary integration. Development-to-Basic
checkout and Development/Basic-to-manual Growth/Enterprise remain separate flows.

## Refunds and Disputes

Automatic refund/dispute credit reversal is not implemented. Operations must
reconcile the local ledger, remaining credit and usage before issuing a refund,
and review disputes manually. A Stripe refund alone does not retract API credit.

## Local Verification

- Backend: `node --test test/*.test.js` in `my-dev-portal-api`.
- Opt-in cross-service boundary test: `node test/basicBoundaryIntegration.cjs`
  in `my-dev-portal-api`, with `SN_PREPAID_TEST_PYTHON` pointing to the API test
  Python runtime, `SN_PREPAID_TEST_API_ROOT` to the adjacent API checkout, and
  `SN_PREPAID_TEST_DATABASE_URL=postgresql://prepaid_test@127.0.0.1:55491/postgres`.
  Reuses the API's isolated PostgreSQL fixtures and dependencies, disables dotenv,
  creates/drops its own schema, mocks Stripe at its SDK boundary, and exercises
  real FastAPI routing through TestClient. It is not part of normal `npm test`.
- Frontend amount validation: `npm test` in `my-dev-portal`, also run by frontend CI.
- Isolated browser preview: `node test/preview.mjs`, port 4178. Its auth mock and
  fixture API are only loaded by this separate preview configuration, never the
  production entry point. Mutations are disabled.
- Browser QA: `node test/portal-ui.mjs` with Playwright on `NODE_PATH` and
  `PORTAL_QA_OUTPUT` pointing to a screenshot directory. External requests are
  blocked. Checks cover 1365, 390 and 320 pixels, fixed-header clearance, no
  horizontal overflow, four usage metrics, paused/exhausted/unprovisioned states,
  slow chart loading, route scrolling and Basic top-up navigation.
  This is opt-in: provide Playwright from a separate local installation and
  install Microsoft Edge (the script launches the `msedge` channel). Neither
  Playwright nor its browsers are required by `npm test`, build or frontend CI.

Stripe reference: [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment).
