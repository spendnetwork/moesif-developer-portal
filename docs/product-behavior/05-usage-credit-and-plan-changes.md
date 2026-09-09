# 5. Usage, Credit and Plan Changes

## Usage and Credit

The portal retrieves company- and subscription-scoped API calls, records, aggregate calls and attachments. Cost uses the subscription's rate-card snapshot. Remaining credit equals granted credit less authoritative usage cost.

## Reporting Freshness

Moesif events, billing reports and balance aggregation update at different times. Bounded caching and periodic refresh are used. The portal preserves confirmed totals during temporary failure and labels delayed reporting.

## Exhaustion

Basic has no overage. At zero credit, API requests are rejected and the customer is directed to add credit. Growth and Enterprise follow the configured policy; unresolved bounded-overage terms must not be presented as unlimited access.

## Upgrades

Basic-to-Growth, Basic-to-Enterprise and Growth-to-Enterprise are contact-led. Pending upgrades do not change current prices or permissions. Growth-to-Enterprise preserves subscription history and activates Enterprise rates only after invoice payment.

## Downgrades and Cancellation

Customers cannot immediately self-service a downgrade. Lower plans take effect at the commitment boundary. Cancellation locks access if no live replacement exists, and delayed events from old subscriptions cannot revoke a newer current subscription.

