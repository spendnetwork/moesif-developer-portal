import { useAuth0 } from "@auth0/auth0-react";
import React from "react";

export const LogoutButton = ({ className = "button__logout", children, ...props }) => {
  const { logout } = useAuth0();

  const handleLogout = async () => {
    window.moesif?.track("clicked-logout", {
      provider: "Auth0",
    });
    logout({
      logoutParams: {
        returnTo: window.location.origin,
      },
    });
    window.moesif?.reset();
  };

  return (
    <button type="button" {...props} className={className} onClick={handleLogout}>
      {children || "Log out"}
    </button>
  );
};
