import { useAuth0 } from "@auth0/auth0-react";
import React from "react";

export const LoginButton = ({ isLink }) => {
  const { loginWithRedirect } = useAuth0();

  const handleLogin = async () => {
    window.moesif?.track("clicked-login", {
      provider: "Auth0",
    });
    await loginWithRedirect({
      appState: {
        returnTo: "/dashboard",
      },
      authorizationParams: {
        prompt: "login",
      },
      scope: "openid profile email offline_access",
    });
  };

  const className = isLink ? " button__link" : "button__login";

  return (
    <button className={className} onClick={handleLogin}>
      Log in
    </button>
  );
};
