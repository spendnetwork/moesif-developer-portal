import React from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { NavBarTab } from "./nav-bar-tab";
import preLoginMenu from "./pre-login-menu.json";
import postLoginMenu from "./post-login-menu.json";
import { Bell } from "lucide-react";
import { NavLink } from "react-router-dom";

function Auth0NavBarTabs() {
  const { isAuthenticated } = useAuth0();

  const menus = isAuthenticated ? postLoginMenu : preLoginMenu;

  return (
    <div className="nav-bar__tabs">
      {menus.map((item) => (
        <NavBarTab key={item.path} path={item.path} label={item.label} />
      ))}
      {isAuthenticated && <NavLink to="/notifications" className="nav-bar__tab" title="Notifications" aria-label="Notifications">
        <Bell size={20} aria-hidden="true" />
      </NavLink>}
    </div>
  );
}

export default Auth0NavBarTabs;
