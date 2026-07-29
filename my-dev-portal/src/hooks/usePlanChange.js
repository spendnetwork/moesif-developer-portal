import useSWR from "swr";

import { authedFetcher } from "../lib/portal-api";

export default function usePlanChange({ idToken }) {
  const key = idToken ? ["/plan-change", idToken] : null;
  const { data, error, isLoading, mutate } = useSWR(key, authedFetcher, {
    refreshInterval: 60000,
    revalidateOnFocus: true,
  });
  return {
    planChange: data ?? null,
    planChangeError: error,
    planChangeLoading: key ? isLoading : false,
    refreshPlanChange: mutate,
  };
}
