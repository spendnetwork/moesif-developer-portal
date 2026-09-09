# 1. Requirements

## Functional Requirements

| ID | Requirement |
|---|---|
| DP-FR-001 | Visitors authenticate through the configured Auth0 portal application. |
| DP-FR-002 | First login provisions or reconciles an SN API user and company. |
| DP-FR-003 | Signed-in navigation remains authenticated across protected pages. |
| DP-FR-004 | The portal displays Basic, Growth and Enterprise; Test remains internal. |
| DP-FR-005 | Basic activation and top-up use one-off Stripe card payments. |
| DP-FR-006 | Growth and Enterprise use contact-led external invoicing. |
| DP-FR-007 | API keys remain locked until the active plan is funded and synchronized. |
| DP-FR-008 | Customers can create, name, describe, rotate and revoke keys within the limit. |
| DP-FR-009 | Plaintext key material is shown once only. |
| DP-FR-010 | Usage shows cost, remaining credit and per-metric quantities for the current subscription. |
| DP-FR-011 | Basic top-up adds credit without resetting usage or creating a subscription. |
| DP-FR-012 | Growth or Enterprise customers cannot purchase Basic credit while committed. |
| DP-FR-013 | Upgrades remain pending until invoice payment and synchronization. |
| DP-FR-014 | Normal downgrades take effect at the commitment boundary. |
| DP-FR-015 | Stale cancelled subscriptions are not presented as current. |

## Non-Functional Requirements

| ID | Requirement |
|---|---|
| DP-NFR-001 | The backend validates Auth0 tokens before returning protected data. |
| DP-NFR-002 | Secrets remain in the backend and secure runtime configuration. |
| DP-NFR-003 | Payment and credit reconciliation is idempotent. |
| DP-NFR-004 | Customer identity uses canonical SN API mappings. |
| DP-NFR-005 | Usage queries include current company and subscription scope. |
| DP-NFR-006 | Provider calls use bounded retries, timeouts and safe errors. |
| DP-NFR-007 | Cached usage reduces provider load without presenting unbounded stale data. |
| DP-NFR-008 | Responsive UI preserves functionality and avoids overlap. |
| DP-NFR-009 | Navigation, forms, focus and contrast meet accessibility expectations. |
| DP-NFR-010 | Protected flows fail closed when entitlement cannot be proven. |

