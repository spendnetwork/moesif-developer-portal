import React from "react";
import { PageLoader } from "./page-loader";
import { withAuthenticationRequired } from "@auth0/auth0-react";

export const AuthenticationGuard = ({ component, options = {} }) => {
  const Component = withAuthenticationRequired(component, {
    ...options,
    onRedirecting: () => (
      <div className="page-layout">
        <PageLoader />
      </div>
    ),
  });

  return <Component />;
};
