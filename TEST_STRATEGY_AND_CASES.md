# Open Opportunities Developer Portal

## Test Strategy and Cross-System Test Catalogue

| Field | Value |
| --- | --- |
| Product specification | `PRODUCT_SPECIFICATION.md` |
| Systems under test | Developer portal, portal API, Auth0, Stripe, Moesif, SN API, PostgreSQL, and AWS deployment |
| Primary environments | Local, development, and staging |
| Production testing | Read-only smoke tests and explicitly approved controlled transactions only |
| Last reviewed | 3 August 2026 |

This document defines how the Open Opportunities developer portal should be
tested as one product. It includes the intended customer journeys, edge cases,
malicious or abnormal use, asynchronous integration behaviour, recovery, and
operational checks.

The catalogue is intentionally broader than the current automated test suite.
It is the shared starting point for product, engineering, QA, security, finance,
and customer support. New cases should be added when a defect, commercial rule,
or customer journey reveals another meaningful state.

---

## 1. Test objectives

The test programme must prove that:

1. A legitimate customer can register, pay, receive a key, and make a correctly
   metered API request without manual intervention.
2. Basic, Growth, and Enterprise apply the correct commercial rules, rates,
   credits, and permissions.
3. One organization cannot view, spend, modify, or authenticate as another.
4. Payment, webhook, and provisioning retries do not create duplicate customers,
   subscriptions, credits, charges, organizations, or API keys.
5. A successful payment is never lost, and a failed or forged payment never
   grants access.
6. Delayed or out-of-order events recover to the correct state.
7. SN API remains the final authority for API access.
8. Every billable request is attributed to the correct SN API user,
   organization, plan, and subscription.
9. Secrets and personal data do not leak into logs, Moesif, URLs, or the browser.
10. The product fails safely and tells the customer what to do next.

---

## 2. Testing safety rules

Adversarial tests must only run in an authorized local, development, or staging
environment using synthetic accounts and Stripe test mode. Do not run load,
injection, token-forgery, cross-tenant, webhook-replay, or rate-limit tests
against production without written authorization, a defined window, and an
agreed rollback plan.

Never place real API keys, Stripe secret keys, Auth0 client secrets, provisioning
tokens, personal data, or production payment details in test output. Any secret
exposed during a test must be rotated after the test.

---

## 3. Priorities and test layers

### 3.1 Priority

| Priority | Meaning | Release treatment |
| --- | --- | --- |
| P0 | Access, money, tenant isolation, or secret exposure | Must pass before release |
| P1 | Core customer journey, data accuracy, or recoverability | Must pass before general availability |
| P2 | Secondary UX, compatibility, or operational convenience | May ship only with an accepted issue and owner |

### 3.2 Test layers

| Layer | Purpose | Typical execution |
| --- | --- | --- |
| Unit | Pure policy, parsing, classification, and calculations | Every pull request |
| Component | Portal API service with mocked external systems | Every pull request |
| API integration | Real database and service boundaries, external APIs mocked or in test mode | Every merge to development |
| Browser E2E | Real frontend, portal API, Auth0 test tenant, and Stripe test mode | Staging release candidate |
| Cross-system E2E | Stripe, Moesif, SN API, and database state verified together | Staging release candidate and scheduled regression |
| Security | Abuse, isolation, validation, and secret-handling checks | Each material auth or billing change |
| Operational | Deployment, alarms, reconciliation, backup, and support procedures | Before launch and quarterly |

---

## 4. Test data and environment design

### 4.1 Required synthetic organizations

Create reusable test fixtures with unique emails and immutable labels:

| Fixture | Starting state |
| --- | --- |
| `ORG_NEW` | Auth0 user only; no Stripe customer, SN API organization, or plan |
| `ORG_BASIC_EMPTY` | Active Basic, zero credit, no active keys |
| `ORG_BASIC_FUNDED` | Active Basic, known credit balance, one active key |
| `ORG_GROWTH` | Active Growth, known annual credit, one active key |
| `ORG_ENTERPRISE` | Active Enterprise, known annual credit, one active key |
| `ORG_PAST_DUE` | Commitment subscription in `past_due` |
| `ORG_CANCELLED` | Ended plan and revoked keys |
| `ORG_DUPLICATE_CUSTOMER` | Two matching Stripe customers for conflict testing |
| `ORG_DUPLICATE_SUBSCRIPTION` | Two live Stripe subscriptions for conflict testing |
| `ORG_LEGACY` | Existing manually created SN API user and organization |
| `ORG_MULTI_USER` | Two Auth0 users mapped to one SN API organization |
| `ORG_OTHER_TENANT` | Isolation target that must never be accessible from the primary fixture |

### 4.2 Required catalogue data

Test mode must contain exactly one active Basic, Growth, and Enterprise product,
each with stable `plan_key` metadata and the correct four usage prices. Growth
and Enterprise also require one commitment price. Stripe meters and Moesif
billing meters must be distinct for each metric.

### 4.3 Evidence for every cross-system test

Capture the following where relevant:

- browser state and network response;
- portal API correlation ID and structured log result;
- Auth0 user subject;
- SN API user ID, organization ID, role, plan, and billing status;
- Stripe customer, checkout session, PaymentIntent, subscription, invoice,
  credit grant, and meter state;
- Moesif user ID, company ID, subscription ID, event metadata, and meter result;
- API key metadata without the raw secret; and
- timestamps showing synchronization delay.

The case passes only when the customer experience and authoritative backend
states agree.

---

## 5. Release gates

### 5.1 Pull request gate

- All unit and component tests pass.
- New business rules have tests for success, rejection, and retry.
- No secret appears in fixtures, snapshots, or logs.
- Database migrations upgrade and downgrade in an isolated database.

### 5.2 Staging gate

- All P0 and P1 browser and cross-system cases for affected flows pass.
- Stripe webhook delivery is healthy.
- Moesif events contain canonical identity and billing fields.
- No duplicate customer, entitlement, or credit is created by retries.
- Support can diagnose a deliberately broken fixture using the runbook.

### 5.3 Production gate

- Staging release candidate uses the same image digests and configuration shape.
- Production secrets, URLs, Auth0 application, Stripe mode, and Moesif
  application are confirmed isolated.
- Read-only smoke tests pass.
- Rollback and reconciliation procedures have named owners.

---

## 6. Canonical end-to-end journeys

These cases should be automated in the browser and verified across systems.

| ID | Pri | Journey | Expected result |
| --- | --- | --- | --- |
| E2E-001 | P0 | New user registers, activates Basic with GBP 25, creates a key, and calls a Basic endpoint | One identity and organization, one payment, GBP 25 credit, silver role, working key, correct Moesif event and usage |
| E2E-002 | P0 | Active Basic customer adds GBP 10 | Same customer and plan, balance increases once, prior usage does not reset, no recurring subscription is created |
| E2E-003 | P0 | New user buys Growth and makes all four billable request types | One paid commitment subscription, four metered prices, gold role, credit granted once, all four meters increment correctly |
| E2E-004 | P0 | New user buys Enterprise and makes all four billable request types | Enterprise rates and gold permissions apply; commitment and meter state are correct |
| E2E-005 | P0 | Basic customer upgrades to Growth | Growth activates only after required payment; one current entitlement remains; existing unscoped key receives gold permissions |
| E2E-006 | P0 | Basic customer upgrades to Enterprise | Enterprise activates only after required payment; Basic cannot still receive top-ups |
| E2E-007 | P0 | Growth subscription ends with no replacement | Portal locks key management, SN API denies existing key, webhook revokes keys, billing page shows ended state |
| E2E-008 | P1 | Customer rotates an API key and updates their application | New key works, old key fails immediately, no usage is attributed to the old key after rotation |
| E2E-009 | P1 | Customer logs in on a second browser after subscribing | Server state is recovered; plan, keys, usage, and billing appear without relying on first-browser local storage |
| E2E-010 | P1 | Existing manually created customer is linked to Auth0 | Existing SN API organization is reused, no duplicate customer is created, existing permissions remain |
| E2E-011 | P1 | Two users in one organization make API calls | Distinct Moesif user IDs, shared company ID, shared plan and credit balance, organization-level totals include both |
| E2E-012 | P1 | Usage reaches a Growth overage | Credit is consumed first and only the uncovered amount appears on the monthly invoice |

---

## 7. Authentication and session cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| AUTH-001 | P1 | Create account with email/password | Auth0 account is created and portal session starts |
| AUTH-002 | P1 | Create account with configured social login | Immutable Auth0 subject is used; no duplicate SN API user is created for the same linked identity |
| AUTH-003 | P1 | Log in with an existing account | User returns to authenticated Usage page |
| AUTH-004 | P1 | Visit `/` while authenticated | Redirect to `/dashboard`; no Login or Create account buttons remain visible |
| AUTH-005 | P1 | Open a protected route while unauthenticated | Redirect to Auth0 and return to the intended route after login |
| AUTH-006 | P1 | Log out | Local session is cleared and protected routes require login |
| AUTH-007 | P1 | Let ID token expire while portal is open | User is cleanly reauthenticated or logged out; no misleading billing error is shown |
| AUTH-008 | P1 | Refresh browser on each protected route | Auth state resolves before page data; no unauthenticated flash or redirect loop |
| AUTH-009 | P1 | Open portal in two tabs and log out in one | Other tab loses access on its next authenticated request |
| AUTH-010 | P1 | Disable user in Auth0 | New sessions fail; existing session stops working according to configured token lifetime |
| AUTH-011 | P0 | Send token with wrong issuer | Portal API returns 401 and performs no external writes |
| AUTH-012 | P0 | Send token with wrong audience | Portal API returns 401 and performs no external writes |
| AUTH-013 | P0 | Send expired or not-yet-valid token | Portal API returns 401 and performs no external writes |
| AUTH-014 | P0 | Send unsigned token or change algorithm to `none` | Token is rejected |
| AUTH-015 | P0 | Modify token subject or email without resigning | Token is rejected; no customer lookup or provisioning occurs |
| AUTH-016 | P0 | Reuse a valid token from another Auth0 tenant | Token is rejected by issuer/audience validation |
| AUTH-017 | P1 | Auth0 JWKS endpoint is temporarily unavailable | Cached valid keys are used where safe; otherwise fail with retryable authentication error |
| AUTH-018 | P2 | Login callback includes malformed state | Request is rejected without redirecting to an attacker-controlled URL |

---

## 8. Organization and provisioning cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| ORG-001 | P0 | First successful purchase for a new Auth0 subject | One SN API user and one organization are created |
| ORG-002 | P0 | Retry provisioning with the same Auth0 subject | Existing user and organization are returned; no duplicates |
| ORG-003 | P0 | Same email appears with a different Auth0 subject | Flow fails closed for identity review unless an approved account-link operation exists |
| ORG-004 | P0 | Existing SN API email is claimed after ownership verification | Existing user is linked rather than duplicated |
| ORG-005 | P0 | Existing SN API email is claimed without verification | Claim is rejected |
| ORG-006 | P0 | Portal sends a plan key not in `basic`, `growth`, or `enterprise` | SN API rejects provisioning |
| ORG-007 | P0 | Portal requests an arbitrary role name | Role is derived from approved plan mapping or request is rejected |
| ORG-008 | P0 | Provisioning token is missing | SN API returns service unavailable and creates nothing |
| ORG-009 | P0 | Provisioning token is incorrect | SN API returns 403 and creates nothing |
| ORG-010 | P0 | Provisioning token is valid but Auth0 subject is blank | Validation rejects the request |
| ORG-011 | P0 | Portal repeats a request after network timeout | Idempotent result; one organization and entitlement |
| ORG-012 | P0 | Two provisioning requests race for the same subject | Database uniqueness and transaction handling produce one canonical user |
| ORG-013 | P0 | Two requests race to set current subscription | One current subscription remains; the loser receives a conflict or reconciles |
| ORG-014 | P1 | SN API transaction fails halfway through provisioning | No partial active entitlement remains; retry can complete safely |
| ORG-015 | P1 | Stripe metadata write fails after SN API provisioning | Reconciliation repairs metadata without duplicating SN API state |
| ORG-016 | P1 | Moesif identification fails after payment | Access state follows approved policy; operation is retryable and alert is raised |
| ORG-017 | P1 | Portal user returns after a partial failure | Self-healing reconciliation resumes from authoritative state |
| ORG-018 | P0 | User A requests portal context for User B | Tenant-scoped lookup prevents access |
| ORG-019 | P0 | User changes email in Auth0 | Immutable subject still resolves the same organization; controlled email synchronization occurs |
| ORG-020 | P1 | Organization has two members | Both map to one company; individual user IDs remain distinct |

---

## 9. Plan catalogue and Plans page cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| PLAN-001 | P1 | Load plans while signed out | Public plan comparison renders without exposing private account data |
| PLAN-002 | P1 | Load plans while signed in with no plan | All active plans and correct actions render |
| PLAN-003 | P1 | Load plans with active Basic | Basic shows Current plan and Add credit; Growth and Enterprise show valid upgrade actions |
| PLAN-004 | P1 | Load plans with active Growth | Growth shows Current plan; Basic top-up is unavailable |
| PLAN-005 | P1 | Load plans with active Enterprise | Enterprise shows Current plan; Basic top-up is unavailable |
| PLAN-006 | P0 | Catalogue contains missing `plan_key` | Product is excluded or page shows configuration error; it cannot be purchased |
| PLAN-007 | P0 | Catalogue contains duplicate active `plan_key` products | Purchase is blocked and operations are alerted |
| PLAN-008 | P0 | Plan has missing usage price | Purchase is blocked before payment |
| PLAN-009 | P0 | Growth or Enterprise has missing commitment price | Purchase is blocked before payment |
| PLAN-010 | P0 | Plan has two commitment prices | Purchase is blocked as ambiguous |
| PLAN-011 | P0 | Two prices use the same Stripe meter unexpectedly | Configuration test fails before release |
| PLAN-012 | P1 | Moesif catalogue API times out | Bounded retry/cache is used; customer sees retryable state rather than blank page |
| PLAN-013 | P1 | Cached catalogue expires | Fresh data replaces cache without duplicate requests or visible layout jump |
| PLAN-014 | P1 | Stripe price differs from hardcoded frontend text | Catalogue price wins and test flags stale copy |
| PLAN-015 | P2 | Narrow mobile viewport | Cards, rates, buttons, and comparison remain readable with no overlap |
| PLAN-016 | P1 | Customer double-clicks a plan action | One checkout or one scheduled change is created |

---

## 10. Basic activation and credit cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| BAS-001 | P0 | Activate Basic with GBP 1.00 | Payment and credit succeed; Basic becomes active |
| BAS-002 | P1 | Activate Basic with a normal decimal amount | Exact pence value is charged and credited |
| BAS-003 | P0 | Enter GBP 0.99 | Frontend and backend reject below-minimum amount |
| BAS-004 | P0 | Enter zero | Rejected; no Stripe session |
| BAS-005 | P0 | Enter a negative amount | Rejected; no Stripe session |
| BAS-006 | P0 | Enter more than two decimal places | Rejected or normalized only under an explicitly documented rule |
| BAS-007 | P0 | Enter letters, NaN, Infinity, exponent notation, or whitespace-only | Rejected; no Stripe session |
| BAS-008 | P1 | Enter a very large valid amount | Server applies approved Stripe/platform bounds and requires explicit confirmation |
| BAS-009 | P0 | Change amount in browser request after validation | Backend validates authoritative amount and rejects forged data |
| BAS-010 | P0 | Change `plan_id` to Growth while using Basic purchase type | Request is rejected |
| BAS-011 | P0 | Omit purchase type | Request is rejected before payment |
| BAS-012 | P0 | Use `basic_credit_top_up` before Basic activation | Rejected; top-up cannot establish access |
| BAS-013 | P0 | Use `basic_activation` when Basic is already active | Rejected with instruction to Add credit; reconciliation remains idempotent |
| BAS-014 | P0 | Activate Basic while Growth is active | Rejected before payment |
| BAS-015 | P0 | Top up Basic while Enterprise is active | Rejected before payment |
| BAS-016 | P0 | Payment succeeds and return endpoint is called twice | Credit is applied once |
| BAS-017 | P0 | Payment succeeds and both webhook and browser return race | Credit and entitlement are applied once |
| BAS-018 | P0 | Replay old successful Checkout session for a new user | Session ownership mismatch is rejected |
| BAS-019 | P0 | Payment remains unpaid or incomplete | No access or credit is granted |
| BAS-020 | P0 | Payment amount differs from signed session metadata | Provisioning is rejected and alerted |
| BAS-021 | P0 | Moesif credit write fails for first activation | New Basic access remains locked; retry can finish without another charge |
| BAS-022 | P1 | Moesif credit write fails for an existing customer's top-up | Existing access remains unchanged; customer is told payment is synchronizing |
| BAS-023 | P0 | Customer tops up twice successfully | Both paid amounts are added; usage and prior credit history remain |
| BAS-024 | P0 | Customer refreshes during payment | Checkout resumes or reconciles; no second charge |
| BAS-025 | P0 | Credit reaches exactly zero | Next billable request is denied under the approved zero-balance rule |
| BAS-026 | P0 | Request cost exceeds remaining credit | No unapproved negative balance or overage invoice; documented atomic policy applies |
| BAS-027 | P1 | Non-billable health/docs request at zero balance | Remains accessible if intended; no charge |
| BAS-028 | P1 | Add credit after zero-balance suspension | Access resumes after authoritative balance and entitlement reconcile |
| BAS-029 | P0 | Refund a Basic payment | Credit and access respond according to approved refund policy; no silent free credit remains |
| BAS-030 | P0 | Chargeback a Basic payment | Alert and suspension follow approved policy |

---

## 11. Growth and Enterprise commitment cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| COM-001 | P0 | Buy Growth | GBP 5,000 commitment is charged in test mode and credit is granted once |
| COM-002 | P0 | Buy Enterprise | GBP 12,000 commitment is charged in test mode and credit is granted once |
| COM-003 | P0 | Inspect resulting subscription | One commitment item and four correct metered items exist |
| COM-004 | P0 | Commitment payment fails | Gold access is not granted |
| COM-005 | P0 | Checkout completes but payment is processing | Access remains pending until success |
| COM-006 | P0 | Invoice paid event is replayed | Commitment credit is not duplicated |
| COM-007 | P0 | Metered prices are attached twice by racing reconciliation | Stripe subscription contains each active price once |
| COM-008 | P0 | Product contains a foreign plan's price | Checkout or reconciliation rejects mixed products |
| COM-009 | P0 | Subscription metadata says Growth but items are Enterprise | Reconciliation fails closed |
| COM-010 | P1 | Growth reaches end of annual period and renews | Renewal payment grants the next commitment once with correct expiry |
| COM-011 | P1 | Annual renewal payment fails | Access and collections follow approved grace-period policy |
| COM-012 | P0 | Credit is still available when metered invoice is created | Stripe applies credit before charging card |
| COM-013 | P0 | Credit is exhausted | Only overage is charged monthly |
| COM-014 | P1 | Invoice preview is temporarily unavailable | Usage page degrades gracefully; billing records remain unaffected |
| COM-015 | P0 | Customer removes payment method before overage | Stripe rules prevent removal or portal clearly reports payment action required |
| COM-016 | P0 | Customer cancels at period end | Access remains through paid period and stops at boundary |
| COM-017 | P0 | Customer cancels immediately through support | Entitlement and keys follow approved immediate-cancellation policy |
| COM-018 | P1 | Stripe marks subscription `past_due` | Status and access follow explicit grace policy consistently across portal and SN API |
| COM-019 | P0 | Stripe marks subscription `unpaid` or `paused` | Access is denied and keys are revoked or suspended |
| COM-020 | P1 | Custom Enterprise price carries valid metadata | Correct Enterprise permissions and rates are provisioned without hardcoded product IDs |

---

## 12. Plan-change cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| CHG-001 | P0 | Active Basic requests Growth | One durable plan-change record is created |
| CHG-002 | P0 | Active Basic requests Enterprise | One durable plan-change record is created |
| CHG-003 | P0 | User submits the same change twice | One open change and one target subscription/checkout |
| CHG-004 | P0 | Two different plan changes race | At most one open change; conflict is explicit |
| CHG-005 | P0 | Required target commitment succeeds | Target plan and role activate once |
| CHG-006 | P0 | Required target commitment fails | Basic remains active and target permissions are withheld |
| CHG-007 | P1 | Customer retries failed target payment | Same plan change resumes; no duplicate subscription |
| CHG-008 | P1 | Customer cancels a scheduled change before activation | Change becomes cancelled and current plan remains |
| CHG-009 | P0 | Customer cancels while activation is irreversible | Cancellation is rejected with accurate state |
| CHG-010 | P0 | Old subscription cancellation webhook arrives after replacement activates | New plan remains active and keys are retained |
| CHG-011 | P0 | Target subscription event arrives before Checkout return | Reconciliation converges on one active target plan |
| CHG-012 | P0 | Checkout return arrives before target webhook | Reconciliation converges on one active target plan |
| CHG-013 | P1 | All webhooks are delayed | Due-change reconciliation completes the paid change |
| CHG-014 | P0 | Existing unscoped key after Basic to Growth | Same key gains gold permissions after activation only |
| CHG-015 | P0 | Explicitly scoped key after upgrade | Scope remains restricted despite broader role |
| CHG-016 | P0 | Revoked key exists before upgrade | It remains revoked |
| CHG-017 | P0 | Attempt Growth to Enterprise while unsupported | Blocked before payment with support path |
| CHG-018 | P0 | Attempt Growth to Basic while unsupported | Blocked before payment; no Basic credit session |
| CHG-019 | P1 | Target catalogue product becomes inactive mid-change | Activation stops safely and alerts operations |
| CHG-020 | P1 | Portal restarts during activation | Durable state resumes idempotently |
| CHG-021 | P0 | Duplicate live subscriptions already exist | New change is blocked; neither subscription is guessed as canonical |
| CHG-022 | P1 | Customer has unused Basic credit during upgrade | Behaviour matches approved carry/expire/refund rule and is visible in records |

---

## 13. API key management cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| KEY-001 | P0 | Create first key with name and description | Raw key appears once; hash and safe metadata are stored |
| KEY-002 | P1 | Create key with name only | Key is created with null description |
| KEY-003 | P0 | Create key without a name | Validation rejects request |
| KEY-004 | P1 | Name or description exceeds maximum | Validation rejects or safely constrains input consistently |
| KEY-005 | P0 | Create second key | Both active keys work and remain distinguishable |
| KEY-006 | P0 | Create third active key | Rejected by backend even if UI control is bypassed |
| KEY-007 | P0 | Two second-key requests race | At most two active keys exist after transaction completes |
| KEY-008 | P0 | Refresh after raw key is shown | Raw key cannot be retrieved again |
| KEY-009 | P0 | Inspect database | No plaintext raw key is present |
| KEY-010 | P0 | Inspect portal, SN API, ALB, and Moesif logs | Raw key and sensitive headers are absent or redacted |
| KEY-011 | P1 | Use key prefix shown in UI | Prefix identifies key but cannot authenticate a request |
| KEY-012 | P0 | Rotate a key | Replacement works and old key fails immediately |
| KEY-013 | P0 | Rotate with a concurrent request using old key | Defined atomic boundary applies; no prolonged overlap |
| KEY-014 | P0 | Rotate another user's key ID | Returns not found/forbidden without revealing ownership |
| KEY-015 | P0 | Revoke own key | Key immediately fails; metadata records revocation |
| KEY-016 | P0 | Revoke another user's key ID | Rejected without leaking key details |
| KEY-017 | P1 | Revoke the same key twice | Idempotent safe result; no internal error |
| KEY-018 | P1 | Key reaches 60 days | Rotation reminder appears |
| KEY-019 | P1 | Key reaches 90 days | Rotation recommendation appears |
| KEY-020 | P0 | Expired key is used | SN API rejects it |
| KEY-021 | P0 | Inactive entitlement tries to create or rotate | Rejected |
| KEY-022 | P0 | Plan ends while existing key remains in customer code | SN API rejects request regardless of portal UI |
| KEY-023 | P1 | Last-used timestamp updates after successful use | Correct key metadata updates without delaying request excessively |
| KEY-024 | P1 | Failed authentication with random key | Does not update last-used timestamp |
| KEY-025 | P0 | Key name contains HTML or script | Stored and rendered as text; no execution |
| KEY-026 | P0 | Description contains SQL metacharacters | Safely stored through parameterized database access |
| KEY-027 | P0 | Generated key length and prefix are inspected | Meets configured 128-character target and required entropy |
| KEY-028 | P0 | Attempt to enumerate keys by sequential ID | Tenant ownership check prevents disclosure |

---

## 14. API authentication and authorization cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| API-001 | P0 | Valid Basic key calls silver endpoint | Request succeeds |
| API-002 | P0 | Valid Basic key calls gold-only aggregation | 403 with required permission; no protected data returned |
| API-003 | P0 | Valid Growth key calls gold aggregation | Request succeeds |
| API-004 | P0 | Valid Enterprise key calls gold endpoint | Request succeeds |
| API-005 | P0 | Missing `X-API-Key` | 401/403 without internal details |
| API-006 | P0 | Random API key | Rejected with constant, non-enumerating response |
| API-007 | P0 | Correct prefix and wrong secret | Rejected |
| API-008 | P0 | API key supplied in query string | Rejected or ignored; never logged as a credential |
| API-009 | P0 | API key supplied over HTTP | Redirect without forwarding secret or connection rejected; production uses HTTPS only |
| API-010 | P0 | API key has surrounding whitespace | Behaviour is explicit and consistent; no alternate key interpretation |
| API-011 | P0 | Same key used by concurrent clients | Requests authenticate correctly and count against same organization |
| API-012 | P0 | Organization billing status is cancelled but role remains gold | Billing gate denies request before endpoint execution |
| API-013 | P0 | Role is silver but plan metadata says Growth | Authorization follows SN API role and reconciliation raises mismatch |
| API-014 | P0 | Explicit key scopes are narrower than role | Narrower scope wins |
| API-015 | P0 | Request changes company ID in body/header/query | Identity comes from key, not customer-controlled company input |
| API-016 | P0 | User attempts horizontal access to another organization's saved resource | Object-level authorization rejects it |
| API-017 | P1 | Legacy non-portal internal user calls API | Existing approved authentication remains unaffected by portal billing gate |
| API-018 | P0 | Basic balance is exhausted during high concurrency | Enforcement does not permit unbounded unpaid requests through race conditions |
| API-019 | P1 | Permission cache contains old Basic role after upgrade | Cache invalidation makes new role effective within defined target |
| API-020 | P0 | Permission cache contains old gold role after downgrade/end | Access is removed within defined target; stale cache cannot extend access |

---

## 15. Metering and billing accuracy cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| MTR-001 | P0 | One standard API request succeeds | `api_call_quantity = 1` and correct company/user/subscription are recorded |
| MTR-002 | P0 | Records endpoint returns 10 records | One API call and 10 records-returned units are recorded |
| MTR-003 | P0 | Records endpoint returns zero records | One API call and zero records units |
| MTR-004 | P0 | Aggregate endpoint succeeds | API-call and aggregate-call quantities follow approved charging rule |
| MTR-005 | P0 | Attachment endpoint returns/downloads attachments | Attachment quantity follows documented unit definition |
| MTR-006 | P0 | One request legitimately triggers several metrics | Each intended metric increments once; no accidental duplication |
| MTR-007 | P0 | Endpoint returns 4xx before doing billable work | No charge unless explicitly approved |
| MTR-008 | P0 | Endpoint returns 5xx | No customer charge under default rule |
| MTR-009 | P1 | Client disconnects after server completed billable work | Charging follows documented completion rule consistently |
| MTR-010 | P0 | Portal provisioning endpoint is called | No Moesif billable event |
| MTR-011 | P0 | Billing webhook is called | No Moesif billable event |
| MTR-012 | P0 | Health, docs, favicon, OPTIONS, and probe requests | Not billed |
| MTR-013 | P0 | Internet scanner requests PHP exploit paths | Not attributed to a customer and not billed |
| MTR-014 | P0 | Same application request is retried by client | Each actual successful API execution is metered according to documented idempotency policy |
| MTR-015 | P0 | Moesif event delivery retries | Stripe usage is not duplicated |
| MTR-016 | P0 | Moesif event lacks company ID | Alerted and excluded from customer billing until reconciled |
| MTR-017 | P0 | Moesif event lacks subscription ID | Alerted and cannot be charged to an arbitrary subscription |
| MTR-018 | P0 | User ID is Auth0 subject on one event and numeric ID on another | Test fails; all customer API events use canonical SN API numeric user ID |
| MTR-019 | P0 | Company ID is Stripe customer ID instead of SN API organization ID | Test fails; mapping is corrected |
| MTR-020 | P0 | Event is generated in staging | It reaches only staging Moesif and Stripe test mode |
| MTR-021 | P0 | Basic, Growth, and Enterprise execute identical usage | Accrued amounts use the respective plan rates |
| MTR-022 | P0 | Fractional or malformed quantity reaches meter | Rejected or normalized under explicit metric contract |
| MTR-023 | P0 | Negative quantity reaches meter | Rejected; cannot create credit through usage |
| MTR-024 | P1 | Very high records count | No overflow, truncation, or silent price error |
| MTR-025 | P1 | Meter processing is delayed | Dashboard labels data as updating and later converges |
| MTR-026 | P0 | Compare sampled Moesif events, Stripe usage, and invoice lines | Quantities and money reconcile exactly within documented timing window |

---

## 16. Usage dashboard and page cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| UI-001 | P1 | New user with no plan opens Usage | Subscribe empty state appears |
| UI-002 | P1 | Newly subscribed user with no requests opens Usage | Zero/no-activity state, not an error |
| UI-003 | P1 | Basic customer with usage opens Usage | Four metrics, Basic rates, accrued cost, and authoritative credit render |
| UI-004 | P1 | Growth customer opens Usage | Growth rates, annual credit, period, and overage context render |
| UI-005 | P1 | Enterprise customer opens Usage | Enterprise rates and credit render |
| UI-006 | P0 | User A requests User B's embedded workspace token | Denied; token is company-scoped to A |
| UI-007 | P0 | Modify dynamic company ID in browser | Signed embed remains scoped to canonical company |
| UI-008 | P1 | Embedded workspace link expires | Backend issues a new signed token after authentication |
| UI-009 | P1 | Moesif workspace is revoked or misconfigured | Usage summary remains usable and chart error is actionable |
| UI-010 | P1 | Stripe invoice preview is slower than Moesif metrics | Previous values remain, refresh state is visible, and totals eventually agree |
| UI-011 | P0 | Balance API is temporarily unavailable | Page says Updating; it does not display missing data as GBP 0.00 |
| UI-012 | P1 | Add Basic credit | Credit total increases without usage count resetting |
| UI-013 | P1 | Plan change is scheduled | Banner shows target, effective state, and safe cancellation action |
| UI-014 | P1 | Plan-change payment fails | Current plan remains visible and payment action is clear |
| UI-015 | P1 | Usage refresh interval runs for ten minutes | Bounded requests, no overlapping flood, no memory leak |
| UI-016 | P1 | Browser regains focus | One revalidation occurs and previous data remains during refresh |
| UI-017 | P2 | Large quantities and currency values | Numbers remain readable without overflow or overlap |
| UI-018 | P2 | Empty, loading, error, and success states | Layout remains stable and accessible |

---

## 17. Billing and Settings page cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| BIL-001 | P1 | No-plan user opens Billing | Clear no-active-plan state and View plans action |
| BIL-002 | P1 | Basic user opens Billing | Logical prepaid entitlement and Add credit action render; no fake renewal date |
| BIL-003 | P1 | Growth user opens Billing | Stripe-verified status, period, prices, and Manage billing render |
| BIL-004 | P1 | Enterprise user opens Billing | Correct plan and rates render |
| BIL-005 | P0 | Two live subscriptions exist | Blocking conflict state; no arbitrary plan is shown as canonical |
| BIL-006 | P1 | Checkout just succeeded but SN API is stale | Page reconciles before showing no subscription |
| BIL-007 | P1 | Basic payment is still synchronizing | Message says not to pay again and offers retry |
| BIL-008 | P1 | Stripe customer has been deleted unexpectedly | Stale reference is handled and alerted; no duplicate is silently created during a read |
| BIL-009 | P1 | Manage billing opens Stripe Customer Portal | Correct canonical customer session is used |
| BIL-010 | P0 | Modify prefilled email or customer portal request | Cannot access another customer's portal |
| BIL-011 | P1 | Settings loads Auth0 profile | Correct name/email/image; no billing secrets exposed |
| BIL-012 | P1 | Auth0 user has no picture or name | Graceful fallback content |
| BIL-013 | P0 | Profile field contains HTML | Rendered safely as text |
| BIL-014 | P1 | Stripe management URL is absent | Manage billing is disabled or hidden with clear configuration state |

---

## 18. Webhook and reconciliation cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| WHK-001 | P0 | Valid signed webhook | Accepted and processed once |
| WHK-002 | P0 | Missing Stripe signature | Rejected before parsing business data |
| WHK-003 | P0 | Invalid Stripe signature | Rejected with no writes |
| WHK-004 | P0 | Correctly signed webhook for another Stripe account | Rejected by configured endpoint secret/account context |
| WHK-005 | P0 | Replay same event ID | Idempotent result; no duplicate financial or access write |
| WHK-006 | P0 | Events arrive out of order | Latest authoritative Stripe state wins; old event cannot regress entitlement |
| WHK-007 | P0 | `checkout.session.completed` arrives twice | One customer, entitlement, and credit |
| WHK-008 | P0 | `invoice.paid` arrives twice | One credit grant and one plan transition |
| WHK-009 | P0 | `invoice.payment_failed` follows an older paid event | Current Stripe invoice/subscription state is verified before changing access |
| WHK-010 | P0 | Old subscription deletion arrives after new one activates | New access remains |
| WHK-011 | P0 | Subscription pauses | Status updates and access ends according to policy |
| WHK-012 | P0 | Portal API returns 500 during processing | Stripe retry later completes idempotently |
| WHK-013 | P1 | Portal API restarts during processing | Retry resumes without duplicate writes |
| WHK-014 | P1 | Stripe sends an unhandled event type | Acknowledge safely and log at appropriate level |
| WHK-015 | P0 | Webhook body exceeds configured limit | Rejected without resource exhaustion |
| WHK-016 | P0 | Webhook uses malformed JSON | Rejected safely |
| WHK-017 | P1 | Webhook secret is missing at startup/runtime | Health/config check fails loudly; endpoint returns unavailable |
| WHK-018 | P1 | Reconciliation runs concurrently with webhook | Durable locks/idempotency converge on one state |
| WHK-019 | P1 | Billing or Keys self-heal runs repeatedly | Read-triggered reconciliation does not create repeated writes |
| WHK-020 | P1 | Scheduled reconciliation finds paid Basic session missing credit | Credit is recovered once |
| WHK-021 | P1 | Scheduled reconciliation finds cancelled plan with active key | Key access is removed and alert closes |
| WHK-022 | P0 | Reconciliation sees duplicate Stripe customers | Fails closed and raises support case |

---

## 19. Adversarial and malicious-use cases

### 19.1 Tenant isolation and object authorization

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| SEC-001 | P0 | User A changes API key ID to User B's ID | No read, rotate, or revoke access |
| SEC-002 | P0 | User A changes plan-change request ID to User B's ID | No disclosure or modification |
| SEC-003 | P0 | User A supplies User B's Stripe customer ID | Backend ignores customer input and uses canonical mapping |
| SEC-004 | P0 | User A supplies User B's checkout session ID | Ownership mismatch rejected |
| SEC-005 | P0 | User A supplies User B's Moesif company ID | Backend derives company ID server-side |
| SEC-006 | P0 | User A tries to view User B's subscription | Tenant-scoped result only |
| SEC-007 | P0 | Sequential IDs are enumerated | Uniform not-found/forbidden response; no metadata leakage |
| SEC-008 | P0 | A member without admin rights attempts organization billing change | Rejected when multi-user roles are enabled |

### 19.2 Input and browser security

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| SEC-009 | P0 | Stored XSS payload in key name/description/profile | Rendered as text everywhere |
| SEC-010 | P0 | Reflected XSS payload in query parameters or error text | Not executed |
| SEC-011 | P0 | SQL injection strings in email, names, IDs, and filters | Parameterized handling; no query manipulation |
| SEC-012 | P0 | Header injection in name/email/metadata | Rejected or encoded; no forged response/log lines |
| SEC-013 | P0 | Open redirect payload in return URL | Redirect target restricted to approved frontend origin |
| SEC-014 | P0 | Cross-site request attempts with browser cookies | Auth design and CORS prevent unauthorized state change |
| SEC-015 | P0 | Origin outside allowlist calls portal API | CORS blocks browser access; server still authenticates every request |
| SEC-016 | P0 | Malformed/oversized JSON body | Bounded 4xx response without process instability |
| SEC-017 | P0 | Prototype-pollution keys in JSON | No object or policy mutation |
| SEC-018 | P1 | Unicode confusable plan/key names | Identifier logic uses stable metadata, not display text |

### 19.3 Payment and credit abuse

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| SEC-019 | P0 | Forge Basic amount or purchase type | Server rejects mismatch |
| SEC-020 | P0 | Reuse a paid session across accounts | Ownership mismatch rejected |
| SEC-021 | P0 | Replay payment return repeatedly | No duplicate credit |
| SEC-022 | P0 | Change product/price ID to inactive or cheaper foreign price | Backend resolves approved catalogue and rejects request |
| SEC-023 | P0 | Attempt Basic top-up while a hidden Growth subscription is live | Stripe state classification blocks it |
| SEC-024 | P0 | Manipulate Stripe metadata to say Basic on Growth items | Item classification detects mismatch |
| SEC-025 | P0 | Create a second checkout while first is pending | Idempotency and state checks prevent duplicate active plans |
| SEC-026 | P0 | Cancel/charge back after consuming credit | Approved fraud policy suspends access and alerts operations |
| SEC-027 | P0 | Create repeated Auth0 accounts for promotional credit | One-per-organization controls prevent repeated grants |
| SEC-028 | P0 | Try negative meter events or credits | Rejected and alerted |

### 19.4 Credential and infrastructure abuse

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| SEC-029 | P0 | Brute-force random API keys | Rate limiting and constant responses prevent practical enumeration |
| SEC-030 | P0 | Compare timing for valid and invalid key prefixes | No useful existence oracle |
| SEC-031 | P0 | Provisioning token appears in request logs or Moesif | Redacted or skipped entirely |
| SEC-032 | P0 | API key appears in ALB/application error logs | Redacted |
| SEC-033 | P0 | Access portal backend secret endpoints directly | No debug/config endpoint exposes secrets |
| SEC-034 | P0 | Request cloud metadata URL through any URL input | No SSRF-capable unrestricted server fetch exists |
| SEC-035 | P0 | Path traversal payload in route parameters | No filesystem access or unintended route resolution |
| SEC-036 | P0 | Excessive login, checkout, key, and API requests | Rate limits protect dependencies and return controlled 429 responses |
| SEC-037 | P0 | Send scanner traffic to common exploit paths | Fast 404, no billing, no stack trace, alert only at useful threshold |
| SEC-038 | P0 | Use staging key against production API | Rejected through isolated key stores and environments |
| SEC-039 | P0 | Use production Auth0 token against staging portal | Rejected by issuer/audience isolation |
| SEC-040 | P0 | Try Stripe test identifiers in production | Rejected; live/test mode cannot mix |

### 19.5 Privacy and data exposure

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| SEC-041 | P0 | Inspect browser bundles and source maps | No management token, Stripe secret, or provisioning token |
| SEC-042 | P0 | Inspect Moesif captured headers and bodies | Credentials and prohibited personal data are absent/redacted |
| SEC-043 | P0 | Inspect embedded workspace token | Short-lived and company-scoped; cannot be used for Management API access |
| SEC-044 | P0 | Share embedded URL with another account | Expired/scoped token prevents cross-company analytics |
| SEC-045 | P1 | User requests account data export | Required identity and billing references can be located consistently |
| SEC-046 | P1 | User deletion request | Retention and financial-record rules are applied without orphaning billing data |

---

## 20. Reliability, concurrency, and performance cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| REL-001 | P1 | Stripe latency increases to several seconds | Portal uses timeout, retry, and progress states without duplicate writes |
| REL-002 | P1 | Moesif Management API is unavailable | Catalogue/analytics degrade; API traffic remains available where safe |
| REL-003 | P0 | SN API provisioning endpoint is unavailable after payment | Customer sees synchronization delay, payment is retained, retry completes |
| REL-004 | P0 | Database is unavailable during key authentication | API fails closed without leaking internals |
| REL-005 | P1 | Portal backend restarts during checkout return | Stateless/durable reconciliation resumes |
| REL-006 | P1 | ECS runs two portal backend tasks | Webhooks and checkout retries remain idempotent across instances |
| REL-007 | P1 | 100 users load Plans simultaneously | Cache protects Moesif/Stripe and response target is met |
| REL-008 | P1 | 100 users refresh Usage simultaneously | Cache and request coalescing avoid a dependency request spike |
| REL-009 | P1 | High API concurrency for one organization | Authentication, RBAC, metering, and last-used updates remain correct |
| REL-010 | P1 | Usage values exceed 32-bit integer range | Quantities and costs remain accurate |
| REL-011 | P1 | Clock skew between services | Token, webhook, period, and rotation logic tolerate approved skew |
| REL-012 | P1 | Daylight-saving or timezone boundary | Billing periods display correctly and remain UTC-authoritative |
| REL-013 | P1 | Month/year boundary | Usage period and invoice lines do not overlap or reset incorrectly |
| REL-014 | P1 | Credit and usage update concurrently | Display and enforcement converge without negative/duplicated balance |
| REL-015 | P1 | Cache contains stale entitlement after cancellation | SN API billing gate prevents continued access |
| REL-016 | P1 | Reconciliation processes 100 due changes | Bounded batch, retries, and per-item failure isolation |

---

## 21. Accessibility and compatibility cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| A11Y-001 | P1 | Navigate every page by keyboard | All actions reachable with visible focus and logical order |
| A11Y-002 | P1 | Use screen reader on forms and dialogs | Labels, errors, status, and dialog boundaries are announced |
| A11Y-003 | P1 | Checkout or key creation reports an error | Error is associated with control and announced without relying on color |
| A11Y-004 | P1 | Open and close API key modal | Focus is trapped, restored, and Escape behaves safely |
| A11Y-005 | P1 | View charts without vision | Text summary provides equivalent key information |
| A11Y-006 | P2 | 200 percent browser zoom | Content remains usable with no overlap or clipped controls |
| A11Y-007 | P2 | Reduced-motion preference | Loading and transition effects remain usable without unnecessary motion |
| A11Y-008 | P2 | Current Chrome, Edge, Firefox, and Safari | Core flows function consistently |
| A11Y-009 | P2 | Common desktop and mobile viewports | No horizontal page overflow; tables remain understandable |
| A11Y-010 | P2 | Slow network simulation | Loading states persist without duplicate submissions |

---

## 22. Deployment, configuration, and operations cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| OPS-001 | P0 | Deploy frontend with staging variables | Uses staging Auth0, portal API, Stripe publishable key, and domain only |
| OPS-002 | P0 | Deploy backend with staging parameters | Uses staging Stripe, Moesif, SN API, and webhook secret only |
| OPS-003 | P0 | Inspect Terraform/state/Actions logs | No plaintext secret is exposed |
| OPS-004 | P0 | GitHub Actions assumes staging role | Trust policy restricts correct organization, repository, branch/environment |
| OPS-005 | P0 | Staging workflow attempts production role | Denied |
| OPS-006 | P1 | ECS task starts with missing required secret | Fails health check loudly rather than serving partially configured billing |
| OPS-007 | P1 | ALB health check | `/health` is fast and does not call Stripe/Moesif or create usage |
| OPS-008 | P1 | Amplify frontend deployment rolls back | Previous compatible frontend remains available |
| OPS-009 | P1 | Portal API deployment rolls back | Database and SN API contracts remain backward compatible |
| OPS-010 | P0 | Apply SN API migrations to clean database | All portal tables and constraints are created |
| OPS-011 | P0 | Apply migrations to representative existing database | Existing users remain and constraints are satisfied |
| OPS-012 | P1 | Restore database backup to isolated environment | Portal identities, keys metadata, entitlements, and plan changes are recoverable |
| OPS-013 | P1 | Stripe webhook deliveries begin failing | Alarm triggers within agreed threshold |
| OPS-014 | P1 | Moesif events lose company IDs | Data-quality alarm triggers |
| OPS-015 | P1 | Plan change remains pending too long | State-age alarm triggers with support identifiers |
| OPS-016 | P1 | Duplicate subscriptions are introduced deliberately | Conflict alarm and support runbook identify them |
| OPS-017 | P1 | Rotate portal provisioning token | Coordinated deployment succeeds with no public exposure |
| OPS-018 | P1 | Rotate Stripe webhook secret | New endpoint secret works and old one is retired without event loss |
| OPS-019 | P1 | Rotate Moesif management token | Least-privilege token supports required routes; old token is revoked |
| OPS-020 | P1 | Run local Compose stack and Stripe CLI forwarding | Complete test-mode checkout and webhook flow works without staging deployment |

---

## 23. Database and migration cases

| ID | Pri | Test | Expected result |
| --- | --- | --- | --- |
| DB-001 | P0 | Insert duplicate Auth0 subject | Unique constraint rejects it |
| DB-002 | P0 | Insert duplicate API key hash | Unique constraint rejects it |
| DB-003 | P0 | Insert two current subscriptions for one organization | Partial unique constraint rejects second row |
| DB-004 | P0 | Insert duplicate plan-change request ID | Unique constraint rejects it |
| DB-005 | P0 | Revoke key | `is_active`, `revoked_at`, and audit fields are coherent |
| DB-006 | P0 | Rotate key transaction fails after revoking old key | Transaction rollback or recovery prevents unintended lockout |
| DB-007 | P1 | Delete/deactivate user with keys | Foreign-key and retention policy produce documented result |
| DB-008 | P1 | Delete/deactivate organization with billing history | Financial and audit records are preserved under policy |
| DB-009 | P1 | Billing webhook updates an old subscription | It cannot replace a newer current subscription |
| DB-010 | P1 | Permission role changes | User cache is cleared and next request sees new permissions |
| DB-011 | P1 | Migration encounters historical duplicate subscriptions | Preflight detects and reports rows before enforcing constraint |
| DB-012 | P1 | Migration downgrade is run in isolated environment | Schema returns to documented prior state without silent corruption |

---

## 24. Existing automated regression coverage

The following current tests should remain mandatory. This is not exhaustive,
but it prevents new manual cases from duplicating already strong unit coverage.

### 24.1 Portal backend

- `basicPurchasePolicy.test.js`: activation versus top-up policy and idempotency.
- `basicTopUpGuard.test.js`: active-plan classification and Basic conflicts.
- `prepaidReconciliation.test.js`: paid Basic provisioning, forged amounts,
  missing meters, Moesif failure, and period limits.
- `basicUsageSummary.test.js`: credit totals, top-ups, usage preservation, and
  missing balance behaviour.
- `stripeUsageSummary.test.js`: plan-specific usage lines and stale Stripe
  customer handling.
- `subscriptionReconciliation.test.js`: new subscriptions, stale entitlement,
  mixed products, cancellation, key preservation, and missed browser flow.
- `planChangeService.test.js`: invoice ordering, commitment payment, failure,
  recovery, and effective-date boundaries.
- `moesifApis.test.js`: stable error codes, balance parsing, and event counts.

### 24.2 SN API

- `app/tests/api/api_v3/test_developer_portal.py`: subscription replacement and
  current-row behaviour.
- `app/tests/core/test_moesif.py`: subscription attachment and secret masking.
- `app/tests/core/test_security.py`: role and subscription identity behaviour.

### 24.3 Automation gaps to prioritize

1. Browser E2E for Basic, Growth, Enterprise, and checkout return.
2. Real Stripe test-clock renewal and overage tests.
3. Moesif-to-Stripe meter reconciliation tests.
4. Cross-tenant API key and embedded workspace tests.
5. API key limit race and rotation transaction tests.
6. Basic zero-credit enforcement tests under concurrency.
7. Webhook signature, replay, and out-of-order integration tests.
8. Accessibility tests for checkout, Plans, Usage, and API key dialogs.

---

## 25. Detailed execution record template

Use this template when a case is executed manually or when a defect is found:

```text
Test ID:
Environment:
Build / commit:
Tester:
Date and time (UTC):
Test data fixture:
Preconditions:
Steps performed:
Expected result:
Actual result:
Portal correlation ID:
Auth0 subject:
SN API user / organization IDs:
Stripe customer / session / subscription / invoice IDs:
Moesif user / company / subscription IDs:
Evidence links:
Pass / Fail / Blocked:
Defect link and severity:
Cleanup completed:
```

---

## 26. Defect severity

| Severity | Definition | Examples |
| --- | --- | --- |
| Critical | Unauthorized access, cross-tenant disclosure, secret leak, incorrect charge at scale, or unrecoverable financial corruption | User A sees User B's data; forged payment grants access |
| High | Core paid journey fails, duplicate charge/credit/subscription, or cancelled customer retains access | Checkout paid but cannot recover; old key works after cancellation |
| Medium | Important function is wrong but safe workaround exists | Usage delayed without updating state; plan copy inconsistent |
| Low | Cosmetic, minor accessibility, or low-impact compatibility issue | Spacing defect at one viewport |

No Critical or High defect may be accepted for production without executive,
engineering, security, and finance sign-off where money is involved.

---

## 27. Completion criteria

The test programme is complete for a release when:

- every affected P0 and P1 case has a recorded result;
- all automated regression suites pass;
- no unresolved Critical or High defect remains;
- money, credit, meter quantities, roles, and identity mappings reconcile across
  all authoritative systems;
- failure and retry cases prove no duplicate side effects;
- security cases prove tenant isolation and secret protection;
- support has successfully diagnosed at least one deliberately broken account;
  and
- any deferred P2 case has an owner, risk statement, and target date.

Passing the visible browser journey alone is not sufficient. The release passes
only when the browser, portal API, SN API database, Stripe, and Moesif all reach
the same intended state.
