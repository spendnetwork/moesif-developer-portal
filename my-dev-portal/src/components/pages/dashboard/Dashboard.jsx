import { PageLayout } from "../../page-layout";
import { useEffect, useState } from "react";
import { PageLoader } from "../../page-loader";
import MoesifEmbeddedTemplate from "../../moesif/moesif-embedded-template";
import NoticeBox from "../../notice-box";
import dashIcon from "../../../images/icons/bar-chart.svg";
import useAuthCombined from "../../../hooks/useAuthCombined";
import fetchEmbedChartUrls from "./fetchEmbedChartUrls";

const Dashboard = (props) => {
  const { user, isLoading, idToken, userEmail } = useAuthCombined();

  const [error, setError] = useState();
  const [embedTemplateUrls, setEmbedTemplateUrls] = useState(null);

  const email = user?.email || userEmail;

  useEffect(() => {
    window?.moesif?.track('viewed-dashboard');

    if (idToken) {
      fetchEmbedChartUrls({
        authUserId: user?.user_id || user?.id || user?.sub,
        idToken,
        email,
      })
        .then((embedInfos) => {
          setEmbedTemplateUrls(embedInfos);
        })
        .catch((err) => {
          console.error("failed to load embed dash", err);
          setError(err);
        });
    }
  }, [idToken, user, email]);

  if (isLoading || !idToken || (!error && !embedTemplateUrls)) {
    return <PageLoader />;
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
      {!error && (
        <MoesifEmbeddedTemplate embedTemplateUrls={embedTemplateUrls || []} />
      )}
      {error && (
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
