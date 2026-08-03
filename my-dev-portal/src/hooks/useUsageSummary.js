import useSWR from "swr";

import { authedFetcher } from "../lib/portal-api";

// Current-period spend + credit balance for the usage dashboard, from Stripe
// via the portal backend. Cached with SWR.
export default function useUsageSummary({ idToken }) {
  const key = idToken ? ["/usage-summary", idToken] : null;
  // The backend serves a stale-while-revalidate cache, so the numbers only
  // change roughly every few minutes. Poll on that cadence and refresh when the
  // user returns to the tab, rather than hammering the endpoint every minute.
  const { data, error, isLoading } = useSWR(key, authedFetcher, {
    refreshInterval: 180000,
    dedupingInterval: 30000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  return {
    usage: data ?? null,
    usageLoading: key ? isLoading : false,
    usageError: error,
  };
}
