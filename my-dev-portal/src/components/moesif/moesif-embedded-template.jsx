import React from "react";

// Titles for the embedded Moesif workspaces, in the order the backend returns
// them (live event log first, then the time-series dashboard).
const CHART_META = [
  {
    eyebrow: "Live",
    title: "Recent API activity",
    description:
      "The most recent requests made with your API keys, updated in real time.",
  },
  {
    eyebrow: "Trends",
    title: "Usage over time",
    description:
      "Requests, records returned, and billing usage across the last 30 days.",
  },
];

export default function MoesifEmbeddedTemplate(props) {
  const { embedTemplateUrls } = props;

  if (!embedTemplateUrls || embedTemplateUrls.length === 0) {
    return null;
  }

  return (
    <div className="usage-charts">
      {embedTemplateUrls.map((url, index) => {
        const meta = CHART_META[index] || {
          eyebrow: "Usage",
          title: `Usage dashboard ${index + 1}`,
          description: "",
        };

        return (
          <section className="usage-chart-card" key={url}>
            <header className="usage-chart-card__header">
              <div>
                <p className="page-eyebrow">{meta.eyebrow}</p>
                <h2>{meta.title}</h2>
                {meta.description && (
                  <p className="usage-chart-card__desc">{meta.description}</p>
                )}
              </div>
              <span className="usage-chart-card__range">Last 30 days</span>
            </header>
            <div className="usage-chart-card__frame">
              <iframe
                title={meta.title}
                id={url}
                src={url}
                name="preview-frame"
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}
