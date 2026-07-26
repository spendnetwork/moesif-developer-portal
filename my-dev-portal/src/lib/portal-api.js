// Shared portal API helpers used by SWR data hooks and mutations.
// Errors carry `.status` so pages can distinguish not-provisioned (404),
// inactive subscription (402), etc.

const BASE = import.meta.env.REACT_APP_DEV_PORTAL_API_SERVER;

async function parseBody(response) {
  return response.status === 204 ? null : await response.json();
}

function throwWithStatus(body, response) {
  const error = new Error(body?.message || "Request failed");
  error.status = response.status;
  throw error;
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
  if (!response.ok) throwWithStatus(body, response);
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
  if (!response.ok) throwWithStatus(body, response);
  return body;
}
