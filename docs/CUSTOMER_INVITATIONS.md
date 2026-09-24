# Customer invitations and SendGrid delivery

**Documentation source review:** 23 September 2026. This document describes invitation delivery, not a completed general notification feature. Environment readiness and real delivery must be verified separately.

For the cross-project implemented/partial/missing coverage, see `sn-api/docs/api-billing-technical-architecture/11-limits-notifications-recovery.md`. The wider product event list is in `sn-api/docs/developer-portal-product-behavior/11-notifications.md`.

## Customer and admin flow

1. In the admin tool, open Customers > Invite customer. Enter the customer's name, email, company, development-credit amount and validity. Default credit is GBP 50 for 30 days; internal notes stay private.
2. The invitation is recorded before sending. Sending an invitation does not grant credit.
3. Its signed link opens the portal's Create account flow. Existing customers can sign in instead.
4. Acceptance requires a verified Auth0 email matching the invited address and any existing API account. SN API creates the account if needed; it never joins organisations by company name or email domain.
5. Acceptance and the development-credit grant commit together. Repeated acceptance returns the original receipt, not more credit.
6. A confirmation email, customer in-app notice and private team Slack notification follow. A delivery failure does not undo credit or require acceptance again.

Invitations expire seven days after creation. Resending does not change terms or extend expiry. Development credit is separate from paid credit, metered at Basic rates and expires after the assigned validity. Existing paid pricing is preserved. Unsupported billing states fail closed.

## SendGrid configuration

Email is now sent through the official `@sendgrid/mail` SDK. The two templates are rendered locally with Handlebars from `my-dev-portal-api/email-templates/`; they ship inside both backend Docker images. No SendGrid-hosted templates or template IDs are needed. HTML substitutions are escaped; the plain-text alternative retains readable text.

Set these variables in the portal backend only:

| Variable | Purpose |
| --- | --- |
| `SENDGRID_API_KEY` | Dedicated SendGrid key with Mail Send permission. Store as a secret. |
| `EMAIL_FROM` | Authenticated sender address, e.g. `welcome@openopps.com`. |
| `EMAIL_FROM_NAME` | Display name, e.g. `Open Opportunities`. |
| `INVITATIONS_ENABLED` | Set `true` only after the API and delivery settings are ready. |
| `INVITATION_SIGNING_SECRET` | Existing stable random secret, at least 32 bytes, shared across replicas. Do not rotate during the provider switch. |
| `INVITATION_PORTAL_URL` | Frontend origin; HTTPS in production. Local HTTP is allowed only for localhost/127.0.0.1 outside production. |
| `INVITATION_SLACK_WEBHOOK_URL` | Existing private team Slack webhook. Keep secret. |

Keep the existing admin-to-portal and portal-to-SN-API tokens. Sender authentication must be completed in SendGrid; SES verification does not transfer. This implementation uses SendGrid's default global API endpoint.

The SES SDK and runtime settings are no longer used. Root `email-templates/` JSON files are historical SES exports, not runtime templates. AWS credential forwarding via `start-local-with-aws.ps1` or `compose.aws-local.yaml` is unnecessary for email; leave unrelated AWS integrations alone. No SES recipient verification or SES production-access request is needed for SendGrid, but SendGrid account restrictions still apply.

## Local setup and deployment

1. Deploy SN API's invitation endpoints, including terminal delivery-result `failed`, before updating the portal. Existing migration `6cf3b4c5d6e7` must already be applied. The provider switch needs no additional migration.
2. Populate the backend environment. Never put the key in frontend/Vite configuration or commit it.
3. Install backend dependencies. For Compose's persistent dependency volume, run from the repository root:

```powershell
docker compose run --rm --no-deps portal-api npm ci
docker compose up -d --build --force-recreate portal-api
```

4. In ECS, reference the SendGrid key through encrypted Parameter Store/Secrets Manager and set the two sender variables. The existing execution role needs permission to read the secret. SES send permission is not needed for this worker. Keep outbound HTTPS access.
5. Keep the signing secret and portal origin unchanged so existing unexpired invitation links work. Queued emails use SendGrid after restart; already submitted jobs are not resent automatically.
6. Run the checks below. Then send one explicitly authorised test invitation and verify signup, credit, email and Slack. Do not create another invitation to work around a delivery failure: use Resend or Retry notifications after fixing configuration.

## Checks

From `my-dev-portal-api`:

```powershell
npm.cmd run notifications:check
npm.cmd run notifications:check -- --sandbox
```

The first command is offline: it validates local configuration and renders both templates without contacting any provider. The second submits synthetic validation-only requests to SendGrid with sandbox mode forced on; it does not deliver messages, consume invitations, grant credit or post to Slack. It needs only the sending key, not account-management permissions.

Sandbox validation does not prove inbox delivery, sender verification or bounce handling. The worker never uses sandbox mode. It requires HTTP 202 plus a provider message ID before recording a submission.

## Queue, safety and recovery

SN API owns `customer_invitation`, `invitation_delivery` and `invitation_audit`. Existing billing credit/ledger tables own the grant. The portal accesses these through authenticated SN API endpoints, not direct writes.

The worker runs every 30 seconds, claims up to ten jobs with two-minute leases, and makes at most eight attempts for transient failures. SendGrid requests time out after 15 seconds; rate limits and server failures use the existing durable backoff. Permanent rejection goes to Needs attention immediately. Examples:

| Code | Action |
| --- | --- |
| `SendGridAuthenticationFailed` | Check the key in the running backend. |
| `SendGridSenderOrPermissionDenied` | Check sender authentication, Mail Send permission and account sending restrictions. |
| `SendGridRequestRejected` | Review the recipient/template request before resending. |
| `SendGridRateLimited` / `SendGridUnavailable` | Allow the scheduled retry. |
| `SendGridSubmissionUnconfirmed` | Outcome may be uncertain; avoid starting another invitation. |

Logs contain safe codes and delivery IDs, not API keys, signed links, addresses or raw SDK errors. Internal notes are never included in customer email. Click/open/subscription/analytics tracking is disabled on these transactional emails to avoid rewriting invitation links.

Acknowledgement retries do not immediately resend the email. Delivery remains at-least-once: a process crash or ambiguous timeout can still duplicate a message. Credit remains once-only. The admin's Submitted status means SendGrid accepted the request, not inbox delivery.

Existing failed accepted-email/Slack jobs can be requeued with Retry notifications; this never grants credit again or intentionally resends successful notifications.

## Delivery monitoring and scope

The in-app implementation is invitation-specific: authenticated customers poll `/invitation-notifications` every 60 seconds and can dismiss their accepted-invitation notices. It is not a general company notification inbox or a read/unread history for payment and usage events.

Use SendGrid Email Activity and its suppression/bounce/complaint tools to investigate downstream delivery. This switch does not add an Event Webhook receiver or claim to track delivered/bounced states in the application. A future receiver must verify SendGrid signatures and deduplicate events before changing stored statuses. Do not configure a webhook pointing at a nonexistent endpoint.

This change covers invitation email and invitation-acceptance credit confirmation. Team Slack and in-app notices stay unchanged. Purchase confirmations, standalone admin grants and customer low-balance emails require their own event/queue integration; they are not silently enabled by changing the email provider.

References: [SendGrid Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send), [Sandbox validation](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sandbox-mode).
