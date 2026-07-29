// Revokes a customer's API keys once their subscription is no longer live.
//
// WHY THIS EXISTS
// ---------------
// `requireActiveSubscription` only guards key *creation* and *rotation*. Before
// this module, a cancelled customer kept a fully working key forever: nothing
// in the portal told SN API the subscription had ended, and nothing revoked the
// key. The portal UI locked up, which looks like enforcement but is not — a
// customer with the key already in their code never visits the portal.
//
// IMPORTANT — THIS IS THE SECOND LAYER, NOT THE ONLY ONE.
// A webhook is best-effort: Stripe can deliver late, retry, or (if the endpoint
// is misconfigured) never deliver at all, and the key keeps working for that
// whole window. Only SN API can refuse a request in flight, so SN API must also
// check subscription status when authenticating a key. See README
// "Subscription enforcement" for the requirement.

const {
  listSnApiKeys,
  revokeSnApiKey,
} = require("./snApiProvisioning");

// Statuses the portal treats as a live subscription. Kept identical to
// getActiveStripeSubscription in stripeApis.js so the key gate and the portal's
// own idea of "active" can never disagree — if they drift, a customer either
// keeps working keys they shouldn't, or loses keys while still paying.
const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"];

function isLiveSubscriptionStatus(status) {
  return LIVE_SUBSCRIPTION_STATUSES.includes(status);
}

function isEndedSubscriptionStatus(status) {
  return Boolean(status) && !isLiveSubscriptionStatus(status);
}

function stripeCustomerId(subscription) {
  return typeof subscription?.customer === "string"
    ? subscription.customer
    : subscription?.customer?.id;
}

// Provisioning writes the Auth0 subject to customer metadata as `authUserId`
// (see updateStripeCustomerIdentity). The SN API key endpoints are keyed on
// that subject, so without it we cannot act — and must say so loudly rather
// than silently leaving a live key in place.
function auth0UserIdFromCustomer(customer) {
  return customer?.metadata?.authUserId || null;
}

// Revoke every key belonging to `auth0UserId`.
//
// Idempotent: re-running finds no keys and does nothing, so Stripe's webhook
// retries are safe. Individual failures are collected rather than thrown, so
// one bad key cannot leave the rest of a cancelled customer's keys live.
// SN API returns `{ keys: [...], max_active_keys }` (the shape the Keys page
// reads). Tolerate a bare array too rather than silently revoking nothing if
// that ever changes — an unnoticed no-op here means live keys on a dead
// subscription.
function extractKeyList(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.keys)) return response.keys;
  if (Array.isArray(response?.api_keys)) return response.api_keys;
  if (response && typeof response === "object") {
    console.error(
      "Unrecognised SN API key list shape; no keys revoked:",
      JSON.stringify(Object.keys(response))
    );
  }
  return [];
}

async function revokeAllKeysForUser(auth0UserId, { reason } = {}) {
  const authUser = { sub: auth0UserId };
  const keyList = extractKeyList(await listSnApiKeys(authUser));

  const revoked = [];
  const failed = [];

  for (const key of keyList) {
    const keyId = key?.api_key_id || key?.id;
    if (!keyId) continue;
    try {
      await revokeSnApiKey(authUser, keyId);
      revoked.push(keyId);
    } catch (error) {
      // 404 means it is already gone — that is the desired end state.
      if (error.status === 404) {
        revoked.push(keyId);
      } else {
        failed.push({ keyId, message: error.message });
      }
    }
  }

  if (revoked.length) {
    console.log(
      `Revoked ${revoked.length} API key(s) for ${auth0UserId}` +
        (reason ? ` (${reason})` : "")
    );
  }
  if (failed.length) {
    // Loud: these keys are still live and still billable against a dead
    // subscription. Needs a human or a retry.
    console.error(
      `FAILED to revoke ${failed.length} API key(s) for ${auth0UserId}:`,
      JSON.stringify(failed)
    );
  }

  return { revoked, failed };
}

// Handle a subscription that Stripe reports as no longer live.
//
// `deps` is injectable so this can be unit-tested without Stripe, and so app.js
// can pass in the already-imported Stripe helpers without a circular require.
async function handleSubscriptionEnded(subscription, deps) {
  const { getStripeCustomerById, listStripeSubscriptions } = deps;
  const status = subscription?.status;

  if (!isEndedSubscriptionStatus(status)) {
    return { skipped: "subscription_still_live", status };
  }

  const customerId = stripeCustomerId(subscription);
  if (!customerId) {
    console.error(
      "Subscription ended but carried no customer id; cannot revoke keys",
      subscription?.id
    );
    return { skipped: "no_customer_id" };
  }

  // A customer may hold more than one subscription (e.g. mid plan change, where
  // the old one is cancelled as the new one starts). Only revoke once nothing
  // live remains, otherwise a plan upgrade would kill a paying customer's keys.
  const subscriptions = await listStripeSubscriptions(customerId);
  const stillLive = (subscriptions || []).filter(
    (candidate) =>
      candidate.id !== subscription.id && isLiveSubscriptionStatus(candidate.status)
  );
  if (stillLive.length) {
    console.log(
      `Subscription ${subscription.id} ended (${status}) but customer ${customerId} ` +
        `still has ${stillLive.length} live subscription(s); keys retained`
    );
    return { skipped: "other_live_subscription" };
  }

  const customer = await getStripeCustomerById(customerId);
  const auth0UserId = auth0UserIdFromCustomer(customer);
  if (!auth0UserId) {
    // Cannot map to an SN API user, so the keys stay live. This is a real
    // exposure, not a benign no-op, so it must be shouted about.
    console.error(
      `Subscription ${subscription.id} ended (${status}) but Stripe customer ` +
        `${customerId} has no authUserId metadata. API KEYS COULD NOT BE ` +
        `REVOKED AND MAY STILL WORK — revoke manually.`
    );
    return { skipped: "no_auth0_user_id", customerId };
  }

  const result = await revokeAllKeysForUser(auth0UserId, {
    reason: `subscription ${subscription.id} ${status}`,
  });

  return { ...result, auth0UserId, customerId, status };
}

module.exports = {
  LIVE_SUBSCRIPTION_STATUSES,
  isLiveSubscriptionStatus,
  isEndedSubscriptionStatus,
  auth0UserIdFromCustomer,
  extractKeyList,
  revokeAllKeysForUser,
  handleSubscriptionEnded,
};
