import { PageLayout } from "../../page-layout";
import { Navigate } from "react-router-dom";
import { useEffect } from "react";
import useSWR from "swr";
import { PageLoader } from "../../page-loader";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { welcomeStorageKey } from "../../../common/constants";
import fetchEmbedChartUrls from "./fetchEmbedChartUrls";
import UsageView from "./UsageView";

const Dashboard = () => {
  const { user, isLoading, idToken } = useAuthCombined();

  useEffect(() => {
    window?.moesif?.track("viewed-dashboard");
  }, []);

  // The token carries an absolute rolling time window. Refresh it periodically
  // so the embedded workspaces include requests made after the page loaded.
  const embedKey = idToken ? ["embed-charts", idToken] : null;
  const {
    data: embedTemplateUrls,
    error,
    isLoading: embedLoading,
  } = useSWR(
    embedKey,
    () => fetchEmbedChartUrls({ idToken }),
    {
      refreshInterval: 60000,
      revalidateOnFocus: true,
      dedupingInterval: 30000,
      keepPreviousData: true,
    }
  );

  if (isLoading || !idToken) {
    return (
      <PageLayout>
        <PageLoader />
      </PageLayout>
    );
  }

  if (user?.sub && !localStorage.getItem(welcomeStorageKey(user.sub))) {
    return <Navigate replace to="/welcome" />;
  }

  return (
    <PageLayout>
      <UsageView
        idToken={idToken}
        embedTemplateUrls={embedTemplateUrls || []}
        embedError={error}
        embedLoading={embedLoading}
      />
    </PageLayout>
  );
};

export default Dashboard;
