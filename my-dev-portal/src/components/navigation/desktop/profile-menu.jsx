import React, { useEffect, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Link, useLocation } from "react-router-dom";
import { Bell, BookOpen, ChevronDown, LogOut, Settings } from "lucide-react";
import { LogoutButton } from "../../buttons/logout-button";
import { API_DOCS_URL } from "../../api-example";

function initials(user) {
  const source = (user?.name && user.name !== user.email ? user.name : user?.email || "").trim();
  if (!source) return "?";
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  return ((words[0]?.[0] || "") + (words.length > 1 ? words[1][0] : "")).toUpperCase() || "?";
}

// The signed-in person's chip in the top right, with their account links.
export function ProfileMenu() {
  const { user } = useAuth0();
  // Settings lives only in this menu, so the chip shows when you are there.
  const onSettings = useLocation().pathname.startsWith("/settings");
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const button = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => {
      if (event.key === "Escape") { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const name = user?.name && user.name !== user.email ? user.name : null;
  const close = () => setOpen(false);

  return (
    <div className="profile-menu" ref={root}>
      <button ref={button} type="button" className={`profile-menu__button${onSettings ? " profile-menu__button--active" : ""}`} aria-haspopup="menu"
        aria-expanded={open} aria-label="Account menu" onClick={() => setOpen((value) => !value)}>
        <span className="profile-menu__avatar" aria-hidden="true">{initials(user)}</span>
        <ChevronDown size={15} aria-hidden="true" className="profile-menu__chevron" />
      </button>
      {open && (
        <div className="profile-menu__panel" role="menu" aria-label="Account">
          <div className="profile-menu__who">
            <span className="profile-menu__avatar profile-menu__avatar--large" aria-hidden="true">{initials(user)}</span>
            <div>
              {name && <strong>{name}</strong>}
              <span>{user?.email}</span>
            </div>
          </div>
          <Link role="menuitem" className="profile-menu__item" to="/settings" onClick={close}>
            <Settings size={16} aria-hidden="true" />Settings
          </Link>
          <Link role="menuitem" className="profile-menu__item" to="/notifications" onClick={close}>
            <Bell size={16} aria-hidden="true" />Notifications
          </Link>
          <a role="menuitem" className="profile-menu__item" href={API_DOCS_URL} target="_blank" rel="noreferrer" onClick={close}>
            <BookOpen size={16} aria-hidden="true" />API documentation
          </a>
          <div className="profile-menu__divider" role="separator" />
          <LogoutButton role="menuitem" className="profile-menu__item profile-menu__item--logout">
            <LogOut size={16} aria-hidden="true" />Log out
          </LogoutButton>
        </div>
      )}
    </div>
  );
}

