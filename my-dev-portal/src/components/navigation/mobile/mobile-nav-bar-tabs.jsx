import React from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { MobileNavBarTab } from "./mobile-nav-bar-tab";

export const MobileNavBarTabs = ({ handleClick }) => {
  const { isAuthenticated } = useAuth0();

  return (
    <div className="mobile-nav-bar__tabs">
      {isAuthenticated && (
        <>
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
