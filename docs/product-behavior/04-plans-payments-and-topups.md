# 4. Plans, Payments and Top-Ups

## Basic

Basic is flexible prepaid access. The customer selects a GBP amount above the configured minimum and pays through Stripe Checkout in payment mode. The backend verifies ownership, amount, currency and payment before applying credit and unlocking access.

## Development Credit

The current implementation grants one £50 company-level promotion during first Basic activation. Its deterministic transaction ID prevents duplicate grants. Granting it immediately at signup remains a product decision.

## Basic Top-Up

A confirmed Basic customer can add credit before or after exhaustion. Top-up increases the existing balance, retains prior usage and does not create another subscription.

## Growth and Enterprise

Growth (£5,000) and Enterprise (£12,000) are annual prepaid commitments. Customers contact Open Opportunities; staff issue and confirm an external invoice in the Admin Portal. Activation waits for SN API and Moesif synchronization.

## Payment Safety

The browser cannot authoritatively choose amount or plan. Stripe IDs or stable UUIDs provide idempotency. A timeout after payment shows delayed setup and continues the same reconciliation rather than requesting payment again.

