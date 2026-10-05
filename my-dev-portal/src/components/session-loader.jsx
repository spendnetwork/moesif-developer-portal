import React from "react";
import logo from "../images/assets/open-opportunities-logo.png";
import "../styles/components/session-loader.css";

export function SessionLoader() {
  return <main className="session-loader" aria-busy="true" aria-label="Opening Developer Portal">
    <div className="session-loader__content">
      <img src={logo} alt="Open Opportunities" className="session-loader__logo" />
      <div className="session-loader__indicator" role="status" aria-label="Loading your account">
        <span className="session-loader__spinner" aria-hidden="true" />
      </div>
    </div>
  </main>;
}
