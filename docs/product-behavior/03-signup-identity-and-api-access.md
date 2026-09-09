# 3. Signup, Identity and API Access

## Signup and Login

Auth0 authenticates the person. The backend registers or reconciles the subject with SN API, which returns canonical user and company identifiers. A genuine sign-in is recorded separately from background provisioning. The customer remains unfunded until a plan activates.

Stripe identity is not required at signup; it is created when a Basic payment needs it.

## Company Ownership

Plans, credit, usage and API keys belong to the company. Auth0 identifies the person, not the billing account. Repeat login must return to the same canonical company.

## Unlocking Keys

Key management unlocks only when the company has a current active subscription, confirmed payment/commitment, required Moesif synchronization, no access hold and sufficient credit under the active policy.

## Key Lifecycle

- Maximum active keys: two.
- Name required; description optional.
- Full plaintext is displayed once.
- Only secure hash and short prefix are retained.
- Warning begins after 60 days; rotation is recommended at 90 days.
- Revoked keys remain historical and cannot authenticate.

## Programmatic Use

Customers send `X-API-Key`. SN API validates key, company, subscription, credit and RBAC permissions, then sends canonical usage identity to Moesif.

