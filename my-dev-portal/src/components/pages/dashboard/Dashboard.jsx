import { PageLayout } from "../../page-layout";
import { Navigate, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import useSWR from "swr";
import { PageLoader } from "../../page-loader";
import MoesifEmbeddedTemplate from "../../moesif/moesif-embedded-template";
import NoticeBox from "../../notice-box";
import SVG from "react-inlinesvg";
import dashIcon from "../../../images/icons/bar-chart.svg";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { welcomeStorageKey } from "../../../common/constants";
import fetchEmbedChartUrls from "./fetchEmbedChartUrls";
import UsageSummary from "./UsageSummary";

const isNotProvisionedError = (error) =>
  error?.status === 400 || error?.status === 404;

const Dashboard = (props) => {
  const { user, isLoading, idToken, userEmail } = useAuthCombined();
  const navigate = useNavigate();

  const email = user?.email || userEmail;
  const authUserId = user?.user_id || user?.id || user?.sub;

  useEffect(() => {
    window?.moesif?.track("viewed-dashboard");
  }, []);

  // Embedded chart URLs are short-lived signed tokens, so cache them for the
  // session and avoid refetching on window focus.
  const embedKey = idToken && email ? ["embed-charts", authUserId, email, idToken] : null;
  const {
    data: embedTemplateUrls,
    error,
  } = useSWR(
    embedKey,
    () => fetchEmbedChartUrls({ authUserId, idToken, email }),
    { revalidateOnFocus: false, dedupingInterval: 60000 }
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
      <div className="page-heading">
        <p className="page-eyebrow">Usage</p>
        <h1>API activity</h1>
        <p>
          Track requests, records returned, attachment activity, and billing
          usage for your Open Opportunities API access.
        </p>
      </div>
      {!error && <UsageSummary idToken={idToken} />}
      {!error && (
        <MoesifEmbeddedTemplate embedTemplateUrls={embedTemplateUrls || []} />
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
