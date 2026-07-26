import useSWR from "swr";

import { authedFetcher } from "../lib/portal-api";

// Subscriptions are fetched from the portal backend (which reads Moesif).
// Cached with SWR keyed by email + token so revisiting is instant and a
// checkout can refresh it via mutate.
export default function useSubscriptions({ user, idToken }) {
  const key =
    user?.email && idToken
      ? [`/subscriptions?email=${encodeURIComponent(user.email)}`, idToken]
      : null;

  const { data, error, isLoading, mutate } = useSWR(key, authedFetcher);

  return {
    subscriptions: data ?? null,
    // "finished" once we have data or an error, matching the old semantics.
    finishedLoading: key ? !isLoading : false,
    subscriptionsError: error,
    refreshSubscriptions: mutate,
  };
}
