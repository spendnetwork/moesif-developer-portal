import PropTypes from "prop-types";
import { NavBar } from "./navigation/desktop/nav-bar";
import { MobileNavBar } from "./navigation/mobile/mobile-nav-bar";

export const PageLayout = ({ hideNavTabs, children, isHome }) => {
  return (
    <div className={`page-layout ${isHome ? 'page-layout--home' : ''}`}>
      <NavBar hideNavTabs={hideNavTabs} />
      <MobileNavBar hideNavTabs={hideNavTabs} />
      <div className="page-layout__content">{children}</div>
    </div>
  );
};

PageLayout.propTypes = {
  hideNavTabs: PropTypes.bool,
  children: PropTypes.node,
  isHome: PropTypes.bool,
};
