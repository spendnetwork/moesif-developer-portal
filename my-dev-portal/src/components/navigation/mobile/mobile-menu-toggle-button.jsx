import React from "react";
import menuIcon from "../../../images/icons/menu.svg";
import closeIcon from "../../../images/icons/cross.svg";

export const MobileMenuToggleButton = ({ icon, handleClick }) => {
  return (
    <button
      type="button"
      className="mobile-nav-bar__toggle"
      id="mobile-menu-toggle-button"
      aria-label={icon === "close" ? "Close menu" : "Open menu"}
      aria-expanded={icon === "close"}
      aria-controls="mobile-navigation-menu"
      onClick={handleClick}
    >
      <img src={icon === "close" ? closeIcon : menuIcon} alt="" width="24" height="24" />
    </button>
  );
};
