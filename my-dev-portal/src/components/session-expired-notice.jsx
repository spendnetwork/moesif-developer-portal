import React from "react";
import { useSearchParams } from "react-router-dom";

import {
  SESSION_EXPIRED_PARAM,
  SESSION_EXPIRED_VALUE,
} from "../lib/session-expiry";

// Shown on the home page after a session-expiry logout, so the user
// understands why they are signed out instead of guessing at a failed page.
export default function SessionExpiredNotice() {
  const [searchParams, setSearchParams] = useSearchParams();

  if (searchParams.get(SESSION_EXPIRED_PARAM) !== SESSION_EXPIRED_VALUE) {
    return null;
  }

  const dismiss = () => {
    const next = new URLSearchParams(searchParams);
    next.delete(SESSION_EXPIRED_PARAM);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="session-notice" role="status">
      <div className="session-notice__text">
        <strong>Your session has expired</strong>
        <span>Please log in again to get back to your account.</span>
      </div>
      <button
        type="button"
        className="session-notice__dismiss"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
