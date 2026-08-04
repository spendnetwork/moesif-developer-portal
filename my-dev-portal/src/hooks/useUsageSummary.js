import useSWR from "swr";

import { authedFetcher } from "../lib/portal-api";

// Current-period spend + credit balance for the usage dashboard, from Stripe
// via the portal backend. Cached with SWR.
export default function useUsageSummary({ idToken }) {
  const key = idToken ? ["/usage-summary", idToken] : null;
  // Moesif usage is cached independently from the slower Stripe ledger reads,
  // so this can poll frequently without multiplying Stripe API traffic.
  const { data, error, isLoading } = useSWR(key, authedFetcher, {
    refreshInterval: 15000,
    dedupingInterval: 5000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  return {
    usage: data ?? null,
    usageLoading: key ? isLoading : false,
    usageError: error,
  };
}
