import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

export default function RouteScrollReset() {
  const { pathname, search, hash } = useLocation();
  useLayoutEffect(() => {
    if (!hash) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname, search, hash]);
  return null;
}
