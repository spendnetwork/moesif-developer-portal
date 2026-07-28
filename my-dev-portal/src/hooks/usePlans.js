import useSWR from "swr";

import { publicFetcher } from "../lib/portal-api";

// Plans come from the Moesif catalogue via the portal backend. Cached with SWR
// so navigating back to the plans page is instant (stale-while-revalidate).
export default function usePlans() {
  const { data, error, isLoading, isValidating } = useSWR(
    "/plans",
    publicFetcher
  );

  const plans = data
    ? (data.hits || []).filter((item) => item.status === "active")
    : null;

  return {
    plansError: error,
    plansLoading: isLoading,
    plansValidating: isValidating,
    plans,
  };
}
