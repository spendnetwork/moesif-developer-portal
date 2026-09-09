# 2. Pages and Navigation

## Home

Signed-out visitors receive authentication actions. Signed-in users receive authenticated navigation and direct access to Usage, Plans and API Keys; they must not continue seeing Login/Create account controls.

## Plans

Plans presents Basic, Growth and Enterprise consistently. It identifies the current plan and pending changes. Basic offers activation or top-up; Growth and Enterprise direct customers to Open Opportunities; Test is never public.

## Checkout and Return

Checkout embeds Stripe for Basic only. Return verifies the actual session server-side, shows smooth provisioning progress, retries safely and redirects to API Keys after confirmed access.

## Usage / API Activity

Usage shows total cost, granted/used/remaining credit, and API call, record, aggregate and attachment quantities with rates and costs. Delayed, empty and failed states are distinct from zero usage.

## API Keys

The page shows name, description, status, creation, last use and rotation guidance. The complete secret appears only after creation.

## Billing / Subscription

Billing shows one current plan, provider model, status, period and relevant management action. Basic is prepaid without recurring overage; Growth and Enterprise are annual externally managed commitments.

## Settings and Welcome

Settings contains customer-owned preferences only. Welcome guides a new unfunded customer. Account banners explain pending payment, synchronization, exhaustion, cancellation or access holds with one clear next action.

