import React from "react";
import { SessionLoader } from "./session-loader";
import { withAuthenticationRequired } from "@auth0/auth0-react";

export const AuthenticationGuard = ({ component, options = {} }) => {
  const Component = withAuthenticationRequired(component, {
    ...options,
    onRedirecting: () => <SessionLoader />,
  });

  return <Component />;
};
