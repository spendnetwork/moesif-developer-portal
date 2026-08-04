import { PageLayout } from "../../page-layout";
import { Navigate, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import useSWR from "swr";
import { PageLoader } from "../../page-loader";
import NoticeBox from "../../notice-box";
import SVG from "react-inlinesvg";
import dashIcon from "../../../images/icons/bar-chart.svg";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { welcomeStorageKey } from "../../../common/constants";
import fetchEmbedChartUrls from "./fetchEmbedChartUrls";
import UsageView from "./UsageView";

const isNotProvisionedError = (error) =>
  error?.status === 400 || error?.status === 404;

const Dashboard = () => {
  const { user, isLoading, idToken } = useAuthCombined();
  const navigate = useNavigate();

  useEffect(() => {
    window?.moesif?.track("viewed-dashboard");
  }, []);

  // The token carries an absolute rolling time window. Refresh it periodically
  // so the embedded workspaces include requests made after the page loaded.
  const embedKey = idToken ? ["embed-charts", idToken] : null;
  const {
    data: embedTemplateUrls,
    error,
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

  if (isLoading || !idToken || (!error && !embedTemplateUrls)) {
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
      {!error && (
        <UsageView idToken={idToken} embedTemplateUrls={embedTemplateUrls || []} />
      )}
      {error && isNotProvisionedError(error) && (
        <div className="empty-state">
          <SVG src={dashIcon} aria-hidden="true" />
          <h2>Subscribe to unlock your dashboards</h2>
          <p>
            Usage analytics appear here once you have an active plan. Choose
            one to activate your API access.
          </p>
          <button
            className="button button--primary"
            onClick={() => navigate("/plans")}
          >
            View plans
          </button>
        </div>
      )}
      {error && !isNotProvisionedError(error) && (
        <NoticeBox
          iconSrc={dashIcon}
          title={error.message}
          description={
            <p>
              We could not load your usage dashboards yet. If you have just
              subscribed, try again shortly.
            </p>
          }
        />
      )}
    </PageLayout>
  );
};

export default Dashboard;
