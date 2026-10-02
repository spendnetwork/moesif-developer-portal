import React from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { LoginButton } from "../../buttons/login-button";
import { SignupButton } from "../../buttons/signup-button";
import { NavLink } from "react-router-dom";
import { Bell } from "lucide-react";
import { ProfileMenu } from "./profile-menu";

function Auth0NavBarButtons() {
  const { isAuthenticated } = useAuth0();

  return (
    <div className="nav-bar__buttons">
      {!isAuthenticated && (
        <>
          <SignupButton />
          <LoginButton />
        </>
      )}
      {isAuthenticated && (
        <>
          <NavLink to="/notifications" className={({ isActive }) => "nav-bar__icon-link" + (isActive ? " nav-bar__icon-link--active" : "")}
            title="Notifications" aria-label="Notifications">
            <Bell size={19} aria-hidden="true" />
          </NavLink>
          <ProfileMenu />
        </>
      )}
    </div>
  );
}

export default Auth0NavBarButtons;
