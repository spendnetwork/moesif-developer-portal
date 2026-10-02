import React from "react";
import { Link } from "react-router-dom";
import { API_DOCS_URL } from "./api-example";

export const PageFooter = () => {
  const year = new Date().getFullYear();

  return (
    <footer className="page-footer">
      <div className="page-footer__inner">
        <div className="page-footer__brand">
          Open Opportunities <span className="page-footer__product">Developer Portal</span>
        </div>
        <nav className="page-footer__links" aria-label="Footer">
          <a href={API_DOCS_URL} target="_blank" rel="noreferrer">API documentation</a>
          <Link to="/plans">Plans and pricing</Link>
          <a href="https://openopps.com/" target="_blank" rel="noreferrer">openopps.com</a>
          <a href="mailto:welcome@openopps.com">Contact us</a>
        </nav>
        <span className="page-footer__copy">
          &copy; {year} Spend Network. All rights reserved.
        </span>
      </div>
    </footer>
  );
};
