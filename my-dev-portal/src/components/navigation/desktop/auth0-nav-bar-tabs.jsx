import React from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { NavBarTab } from "./nav-bar-tab";
import postLoginMenu from "./post-login-menu.json";
import { PublicLinks } from "../public-links";

function Auth0NavBarTabs() {
  const { isAuthenticated } = useAuth0();

  return (
    <div className="nav-bar__tabs">
      {isAuthenticated
        ? postLoginMenu.map((item) => <NavBarTab key={item.path} path={item.path} label={item.label} />)
        : <PublicLinks linkClass="nav-bar__tab" activeClass="nav-bar__tab--active" />}
    </div>
  );
}

export default Auth0NavBarTabs;
