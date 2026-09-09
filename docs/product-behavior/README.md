# Open Opportunities Developer Portal

## Customer Product Behaviour Specification

**Status:** Working specification aligned to the customized Moesif portal  
**Last reviewed:** 26 August 2026  
**Audience:** Product, Commercial, Customer Success, Engineering and QA

## Purpose

The Developer Portal is the customer-facing entry point to the Open Opportunities API. It handles authentication, onboarding, plan discovery, Basic card payment, contact-led commitments, usage visibility, subscription status and API-key management.

The portal coordinates Auth0, SN API, Stripe and Moesif, but does not replace them. Customer access is granted only when canonical company, payment, subscription, balance and API-key state agree.

## Contents

| Page | What it contains |
|---|---|
| [1. Requirements](01-requirements.md) | Functional and non-functional requirements for authentication, plans, payments, usage, API keys and customer experience. |
| [2. Pages and Navigation](02-pages-and-navigation.md) | The purpose, content, actions and states of Home, Plans, Checkout, Usage, API Keys, Billing and Settings. |
| [3. Signup, Identity and API Access](03-signup-identity-and-api-access.md) | Signup, company provisioning, repeat login, API-key creation and request authentication. |
| [4. Plans, Payments and Top-Ups](04-plans-payments-and-topups.md) | Basic checkout, Growth/Enterprise invoicing, development credit and subscription visibility. |
| [5. Usage, Credit and Plan Changes](05-usage-credit-and-plan-changes.md) | Usage calculations, reporting freshness, credit exhaustion, upgrades, downgrades and pending states. |
| [6. Security, Errors and Acceptance](06-security-errors-and-acceptance.md) | Browser/backend boundaries, secure configuration, failure recovery, tests and release acceptance. |

## Customer Promise

A customer should always be able to answer which company and plan they use, what their keys can access, how much credit remains, what produced their cost and what action is needed when access is locked or a change is pending.

## Product Principles

- Signing in produces one stable user/company relationship.
- Refresh or retry never duplicates payment or credit.
- API keys remain locked until access is confirmed.
- Usage and balance are company- and subscription-scoped.
- Basic is prepaid and card-funded; Growth and Enterprise are contact-led and externally invoiced.
- Pages distinguish loading, no data, delayed synchronization and failure.

