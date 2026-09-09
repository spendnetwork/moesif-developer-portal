import useSWR from "swr";

import { authedFetcher } from "../lib/portal-api";

// API-owned prepaid balances come from the local settled ledger.
export default function useUsageSummary({ idToken }) {
  const key = idToken ? ["/usage-summary", idToken] : null;
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
