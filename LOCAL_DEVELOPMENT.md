# Local Developer Portal

The root `compose.yaml` runs the Open Opportunities developer portal frontend
and portal API from the checked-out source. Both services reload when their
source files change.

## Prerequisites

- Docker Desktop with Docker Compose v2
- Auth0 configured to allow `http://127.0.0.1:4000` as a callback URL, logout
  URL, and web origin
- Stripe test-mode credentials for local checkout testing
- Access to the development SN API

## Configuration

Create the local environment files if they do not already exist:

```powershell
Copy-Item my-dev-portal/.env.template my-dev-portal/.env
Copy-Item my-dev-portal-api/.env.template my-dev-portal-api/.env
```

Populate both files with development credentials. Keep `SN_API_BASE_URL`
pointed at the development SN API. Compose supplies the local frontend origin
and portal API URL, so those addresses do not need to be changed in the files.

The `.env` files are excluded from Git and the Docker build context. They are
provided to the containers only at runtime.

## Start

From the repository root:

```shell
docker compose up --build
```

Open `http://127.0.0.1:4000`. The portal API is available at
`http://127.0.0.1:3030`, with a health endpoint at
`http://127.0.0.1:3030/health`.

## Common Commands

```shell
docker compose ps
docker compose logs -f portal-api
docker compose restart portal-api
docker compose down
```

After changing either `package-lock.json`, run `docker compose up --build`.
After changing an `.env` file, recreate the affected service so Compose loads
the new values:

```shell
docker compose up -d --force-recreate portal-api
```

Use `docker compose down --volumes` only when the dependency volumes need to be
rebuilt from scratch.

## Stripe Webhooks

Stripe cannot directly call a service bound only to your computer. To exercise
webhook-driven subscription flows locally, use the Stripe CLI in test mode:

```shell
stripe listen --forward-to http://127.0.0.1:3030/stripe/webhook
```

Put the generated `whsec_...` signing secret in
`my-dev-portal-api/.env` as `PORTAL_STRIPE_WEBHOOK_SECRET`, then recreate the
service so Compose loads the changed environment:

```shell
docker compose up -d --force-recreate portal-api
```
