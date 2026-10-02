import React from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { API_DOCS_URL } from "../api-example";

// What a visitor who isn't signed in can reach from the top bar.
export function PublicLinks({ linkClass, activeClass, onNavigate }) {
  const { pathname } = useLocation();
  // Already on the front page, the URL hash doesn't change on a second
  // click, so scroll to the FAQ directly.
  const toFaq = () => {
    onNavigate?.();
    if (pathname === "/") document.getElementById("faq")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <>
      <NavLink to="/plans" end onClick={onNavigate}
        className={({ isActive }) => `${linkClass}${isActive ? ` ${activeClass}` : ""}`}>
        Pricing
      </NavLink>
      <Link to={{ pathname: "/", hash: "#faq" }} className={linkClass} onClick={toFaq}>FAQs</Link>
      <a href={API_DOCS_URL} target="_blank" rel="noreferrer" className={linkClass} onClick={onNavigate}>Documentation</a>
    </>
  );
}
