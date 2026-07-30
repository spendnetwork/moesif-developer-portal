// Shared portal API helpers used by SWR data hooks and mutations.
// Errors carry `.status` so pages can distinguish not-provisioned (404),
// inactive subscription (402), etc.

import { notifySessionExpired } from "./session-expiry";

const BASE = import.meta.env.REACT_APP_DEV_PORTAL_API_SERVER;

async function parseBody(response) {
  if (response.status === 204) return null;
  // An expired token can also be answered by a proxy/gateway with HTML, so
  // never let a JSON parse failure mask the status code we care about.
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function throwWithStatus(body, response) {
  const error = new Error(body?.message || "Request failed");
  error.status = response.status;
  error.code = body?.code;
  throw error;
}

// The API's auth middleware answers 401 for a missing, malformed or expired
// token (403s come from subscription checks, so they are deliberately not
// treated as an auth failure). Rather than let each page render its own
// "we could not load…" message, tell the app the session is over so it can
// log the user out and ask them to sign in again.
function throwAuthError(body, response) {
  const error = new Error(body?.message || "Your session has expired");
  error.status = response.status;
  error.code = body?.code;
  error.sessionExpired = true;
  notifySessionExpired();
  throw error;
}

function throwForResponse(body, response) {
  if (response.status === 401) throwAuthError(body, response);
  throwWithStatus(body, response);
}

// Authenticated fetcher for useSWR. Key is `[path, idToken]` so the cache is
// scoped per token and refetches automatically when the token changes.
export async function authedFetcher([path, idToken]) {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
  });
  const body = await parseBody(response);
  if (!response.ok) throwForResponse(body, response);
  return body;
}

// Public (unauthenticated) fetcher for useSWR, e.g. the plans catalogue.
export async function publicFetcher(path) {
  const response = await fetch(`${BASE}${path}`);
  const body = await parseBody(response);
  if (!response.ok) throwWithStatus(body, response);
  return body;
}

// Mutation helper (create/rotate/revoke) — same shape as the old inline one.
export async function apiRequest(path, idToken, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
      ...options.headers,
    },
  });
  const body = await parseBody(response);
  if (!response.ok) throwForResponse(body, response);
  return body;
}
