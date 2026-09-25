"use strict";

// Routes whose requests or responses carry secrets (raw API keys, Stripe
// payloads, payment details, service-to-service calls). They are never sent
// to Moesif.
const SENSITIVE_PATH_PREFIXES = [
  "/api-keys",
  "/organization-api-keys",
  "/stripe/",
  "/admin/",
  "/wallet/",
  "/create-stripe-checkout-session",
  "/register/stripe/",
];

// Routes skipped because they are internal portal plumbing, not customer usage.
const UNTRACKED_PATH_PREFIXES = [
  "/onboarding",
  "/invitations",
  "/invitation-notifications",
];

const UNTRACKED_PATHS = new Set(["/usage-summary", "/embed-charts", "/portal-context"]);

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-developer-portal-token",
  "x-admin-service-token",
  "stripe-signature",
]);

// Body fields removed from any event that is still sent.
const SENSITIVE_BODY_KEYS = new Set([
  "api_key",
  "apikey",
  "key",
  "secret",
  "client_secret",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "password",
  "card",
  "payment_method",
]);

function pathMatches(path, prefix) {
  if (prefix.endsWith("/")) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`);
}

function shouldSkipMoesifEvent(req) {
  const path = String(req?.path || "");
  if (SENSITIVE_PATH_PREFIXES.some(prefix => pathMatches(path, prefix))) return true;
  if (UNTRACKED_PATH_PREFIXES.some(prefix => pathMatches(path, prefix))) return true;
  return UNTRACKED_PATHS.has(path);
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const redacted = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value;
  }
  return redacted;
}

function redactBody(body, depth = 0) {
  if (depth > 10 || body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map(item => redactBody(item, depth + 1));
  const redacted = {};
  for (const [name, value] of Object.entries(body)) {
    if (SENSITIVE_BODY_KEYS.has(name.toLowerCase())) continue;
    redacted[name] = redactBody(value, depth + 1);
  }
  return redacted;
}

function maskMoesifEvent(event) {
  if (!event || typeof event !== "object") return event;
  for (const part of ["request", "response"]) {
    const section = event[part];
    if (!section || typeof section !== "object") continue;
    section.headers = redactHeaders(section.headers);
    section.body = redactBody(section.body);
  }
  return event;
}

module.exports = { shouldSkipMoesifEvent, maskMoesifEvent };
