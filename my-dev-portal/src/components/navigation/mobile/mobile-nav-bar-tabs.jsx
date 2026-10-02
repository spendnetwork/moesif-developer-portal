import React from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { MobileNavBarTab } from "./mobile-nav-bar-tab";
import { PublicLinks } from "../public-links";

export const MobileNavBarTabs = ({ handleClick }) => {
  const { isAuthenticated } = useAuth0();

  return (
    <div className="mobile-nav-bar__tabs">
      {!isAuthenticated && (
        <PublicLinks linkClass="mobile-nav-bar__tab" activeClass="mobile-nav-bar__tab--active" onNavigate={handleClick} />
      )}
      {isAuthenticated && (
        <>
          <MobileNavBarTab path="/notifications" label="Notifications" handleClick={handleClick} />
          <MobileNavBarTab path="/plans" label="Plans" handleClick={handleClick} />
          <MobileNavBarTab path="/subscription" label="Billing" handleClick={handleClick} />
          <MobileNavBarTab
            path="/settings"
            label="Settings"
            handleClick={handleClick}
          />
          <MobileNavBarTab
            path="/dashboard"
            label="Usage"
            handleClick={handleClick}
          />
          <MobileNavBarTab
            path="/keys"
            label="Keys"
            handleClick={handleClick}
          />
        </>
      )}
    </div>
  );
};
