import React from "react";

export const PageFooter = () => {
  return (
    <footer className="page-footer">
      <div className="page-footer-grid">
        <div className="page-footer-grid__info">
          <div className="page-footer-info__message">
            <a
              className="btn"
              href="https://openopps.com/api/"
              target="_blank"
            >
              Open Opportunities API
            </a>
          </div>
          <div className="page-footer-info__button">
            <a className="button button__link" href="https://openopps.com/pricing/" target="_blank">
              Pricing
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};
