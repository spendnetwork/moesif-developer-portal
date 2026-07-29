import useSWR from "swr";

import { authedFetcher } from "../lib/portal-api";

// Current-period spend + credit balance for the usage dashboard, from Stripe
// via the portal backend. Cached with SWR.
export default function useUsageSummary({ idToken }) {
  const key = idToken ? ["/usage-summary", idToken] : null;
  const { data, error, isLoading } = useSWR(key, authedFetcher, {
    refreshInterval: 60000,
    dedupingInterval: 10000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  return {
    usage: data ?? null,
    usageLoading: key ? isLoading : false,
    usageError: error,
  };
}
