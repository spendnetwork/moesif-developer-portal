# 6. Security, Errors and Acceptance

## Security Boundaries

The frontend is untrusted for payment, plan and identity assertions. The backend validates Auth0 and obtains canonical SN API context. Stripe and Moesif secrets remain backend-only. Admin routes require the admin service token; SN API provisioning uses its dedicated token. CORS does not replace authentication.

## Customer Error States

| Condition | Experience |
|---|---|
| Signed out/expired | Return to login with clear session message |
| No plan | Explain requirement and link to Plans |
| Payment pending | Keep keys locked and continue payment/reconciliation |
| Provisioning delayed | Show safe retry without another payment |
| Manual invoice pending | Keep existing plan or new-account lock unchanged |
| Moesif sync failed | Explain delay and route to support/admin retry |
| Credit exhausted | Show zero balance and correct top-up/contact action |
| Permission denied | Explain that the endpoint requires a higher plan |
| Embedded workspace invalid | Show dashboard configuration error without breaking billing totals |

## Testing

Tests cover signup/reconciliation, paid and unpaid checkout, forged payment data, credit idempotency, top-ups, duplicate subscriptions, manual invoice retries, plan changes, cancellation races, key limits and company-scoped usage.

## Acceptance

The portal is acceptable when a new customer can register, fund or request a plan, receive one canonical company and subscription, create a usable key only after confirmation, see correctly scoped usage and credit, and recover from provider delays without duplicate charges, subscriptions or credit.

