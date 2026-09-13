import "../styles/components/purchase-result.css";

function CheckIcon() {
  return (
    <svg viewBox="0 0 52 52" width="34" height="34" aria-hidden="true">
      <circle className="purchase-result__check-circle" cx="26" cy="26" r="23" fill="none" />
      <path className="purchase-result__check-mark" fill="none" d="M14.5 27l7 7 16-16" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

const ICONS = { success: CheckIcon, pending: ClockIcon };

// Shared "something just happened with money" panel: an animated status
// icon, heading, optional receipt, and action buttons in a narrow card.
// `titleTag` lets the caller keep exactly one <h1> per page.
export default function PurchaseResult({ status, titleTag: Title = "h2", title, description, amountPence, currency = "£", reference, children }) {
  const Icon = ICONS[status];
  return (
    <div className="purchase-result">
      <div className="purchase-result__card" aria-live="polite">
        {Icon && (
          <div key={status} className={`purchase-result__icon purchase-result__icon--${status}`}>
            <Icon />
          </div>
        )}
        <Title className="purchase-result__title">{title}</Title>
        {description && <p className="purchase-result__subtext">{description}</p>}
        {amountPence != null && (
          <div className="purchase-result__receipt">
            <div className="purchase-result__receipt-amount">{currency}{(amountPence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 })}</div>
            {reference && <div className="purchase-result__receipt-reference">Reference <span>{reference}</span></div>}
          </div>
        )}
        {children && <div className="purchase-result__actions">{children}</div>}
      </div>
    </div>
  );
}
