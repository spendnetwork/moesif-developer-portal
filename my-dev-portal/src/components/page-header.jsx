import React from "react";

// One heading for every portal page: a green eyebrow, a bold title, an
// optional description and an optional set of actions on the right.
export function PageHeader({ eyebrow, title, description, actions, titleId }) {
  return (
    <header className="pp-header">
      <div className="pp-header__text">
        {eyebrow && <p className="pp-eyebrow">{eyebrow}</p>}
        <h1 className="pp-title" id={titleId}>{title}</h1>
        {description && <p className="pp-lead">{description}</p>}
      </div>
      {actions && <div className="pp-header__actions">{actions}</div>}
    </header>
  );
}
