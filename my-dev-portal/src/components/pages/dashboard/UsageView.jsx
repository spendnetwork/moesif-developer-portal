import React from "react";

import useUsageSummary from "../../../hooks/useUsageSummary";

const C = {
  green: "#034737",
  mint: "#A9FF9B",
  head: "#23383A",
  body: "#23302C",
  muted: "#647873",
  line: "#DDE5E0",
  lineSoft: "#EEF2EF",
  page: "#F5F7F4",
  track: "#EDF1EC",
};

function formatMoney(minorUnits, currency) {
  const value = (Number(minorUnits) || 0) / 100;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: (currency || "GBP").toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUsageMoney(minorUnits, currency) {
  return Number.isFinite(minorUnits) ? formatMoney(minorUnits, currency) : "--";
}

function formatDate(unixSeconds, withYear = false) {
  if (!unixSeconds) return "";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(unixSeconds * 1000));
}

function Skeleton({ w, h, style }) {
  return (
    <div
      className="sk"
      style={{ width: w, height: h, borderRadius: 6, ...style }}
    />
  );
}

function ChartCard({ title, url, loading }) {
  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHead}>
        <div style={{ fontSize: 15, fontWeight: 500, color: C.head }}>{title}</div>
        <span style={styles.pill}>Last 30 days</span>
      </div>
      <div style={{ padding: 16 }}>
        {url ? (
          <iframe
            title={title}
            src={url}
            style={{
              display: "block",
              width: "100%",
              aspectRatio: "16 / 9",
              border: 0,
              borderRadius: 8,
              background: "#FFFFFF",
            }}
          />
        ) : (
          <div style={{ padding: "48px 0", textAlign: "center", color: C.muted, fontSize: 13 }}>
            {loading ? "Loading chart..." : "Chart unavailable"}
          </div>
        )}
      </div>
    </div>
  );
}

export default function UsageView({
  idToken,
  embedTemplateUrls = [],
  embedError = null,
  embedLoading = false,
}) {
  const { usage, usageLoading, usageError } = useUsageSummary({ idToken });

  const loading = usageLoading && !usage;
  const currency = usage?.currency || "GBP";
  const credit = usage?.credit || null;
  const hasCalculatedRemaining = Number.isFinite(credit?.projectedRemaining);
  const displayedRemaining = hasCalculatedRemaining
    ? credit.projectedRemaining
    : credit?.remaining;
  const displayedUsed =
    hasCalculatedRemaining && Number.isFinite(credit?.granted)
      ? Math.max(0, credit.granted - credit.projectedRemaining)
      : credit?.used;

  const usedPct =
    credit && credit.granted > 0
      ? Math.min(100, Math.round(((displayedUsed || 0) / credit.granted) * 100))
      : 0;
  const remainingPct =
    credit && credit.granted > 0
      ? Math.min(100, Math.max(0, Math.round(((displayedRemaining || 0) / credit.granted) * 100)))
      : 0;
  const analytics = usage?.analytics;
  const analyticsWarning = usageError
    ? "Current usage could not be refreshed. Last confirmed values are shown where available."
    : ["partial", "unavailable"].includes(analytics?.status)
        ? "Part of the usage service is unavailable. Last confirmed values are shown where available."
        : analytics?.stale
          ? "Usage is still refreshing. Last confirmed values are shown."
          : null;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ marginBottom: 28 }}>
        <div style={styles.eyebrow}>Usage</div>
        <h1 style={styles.h1}>API activity</h1>
        <p style={styles.lead}>
          Settled API usage and available credit across your organisation.
        </p>
      </div>

      {analyticsWarning && (
        <div role="status" style={styles.warning}>
          <strong style={{ color: C.head }}>Usage update delayed.</strong>{" "}
          {analyticsWarning}
        </div>
      )}

      {loading ? (
        <div>
          <div style={styles.twoCol}>
            <div style={styles.metricCard}>
              <Skeleton w={120} h={12} style={{ marginBottom: 18 }} />
              <Skeleton w={180} h={34} style={{ marginBottom: 14 }} />
              <Skeleton w={220} h={12} />
            </div>
            <div style={styles.metricCard}>
              <Skeleton w={120} h={12} style={{ marginBottom: 18 }} />
              <Skeleton w={180} h={34} style={{ marginBottom: 14 }} />
              <Skeleton w="100%" h={10} style={{ borderRadius: 999 }} />
            </div>
          </div>
          <div style={{ ...styles.metricCard, marginTop: 16 }}>
            <Skeleton w={200} h={12} style={{ marginBottom: 22 }} />
            <Skeleton w="100%" h={14} style={{ marginBottom: 16 }} />
            <Skeleton w="100%" h={14} style={{ marginBottom: 16 }} />
            <Skeleton w="60%" h={14} />
          </div>
        </div>
      ) : usage ? (
        <div>
          <div style={styles.twoCol}>
            <div style={styles.metricCard}>
              <div style={styles.metricLabel}>{usage.debitOwner === "api" ? "Settled usage" : "Usage this period"}</div>
              <div style={styles.metricValue}>
                {formatUsageMoney(usage?.accrued, currency)}
              </div>
              <div style={styles.metricSub}>
                {usage?.period?.start && usage?.period?.end
                  ? `${formatDate(usage.period.start)} – ${formatDate(
                      usage.period.end,
                      true
                    )}`
                  : usage.debitOwner === "api" ? "Recorded API usage" : "Current billing period"}
              </div>
            </div>

            {credit && (
              <div style={styles.metricCard}>
                <div style={styles.metricLabel}>{usage.planKey === "development" ? "Development allowance remaining" : "Credit remaining"}</div>
                <div style={styles.metricValue}>
                  {formatUsageMoney(displayedRemaining, currency)}
                </div>
                <div style={{ ...styles.metricSub, marginBottom: 14 }}>
                  {formatUsageMoney(displayedUsed, currency)} of{" "}
                  {formatUsageMoney(credit.granted, currency)} used
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={usedPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  style={styles.bar}
                >
                  <div style={{ ...styles.barFill, width: `${usedPct}%` }} />
                </div>
                <div style={styles.progressMeta}>
                  <span>{formatMoney(displayedUsed, currency)} used</span>
                  <span>{remainingPct}% remaining</span>
                </div>
                {credit.expired > 0 && (
                  <p style={styles.metricSub}>{formatMoney(credit.expired, currency)} expired</p>
                )}
                {usage.balances && usage.planKey !== "development" && (
                  <dl style={{ margin: "14px 0 0", display: "grid", gridTemplateColumns: "1fr auto", gap: 8, fontSize: 13 }}>
                    <dt>Development credit</dt>
                    <dd style={{ margin: 0 }}>{formatMoney(usage.balances.development?.eligible_gbp_pence || 0, currency)}</dd>
                    <dt>Paid credit</dt>
                    <dd style={{ margin: 0 }}>{formatMoney(usage.balances.commercial?.eligible_gbp_pence || 0, currency)}</dd>
                  </dl>
                )}
                {Number.isFinite(credit.spendable) && credit.spendable < credit.remaining && (
                  <p style={styles.metricSub}>{formatMoney(credit.spendable, currency)} currently spendable</p>
                )}
              </div>
            )}
          </div>

          {usage?.lines && usage.lines.length > 0 && (
            <div style={{ ...styles.metricCard, marginTop: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 500, color: C.head, marginBottom: 6 }}>
                Usage by metric
              </div>
              <p style={{ margin: "0 0 8px", fontSize: 13, color: C.muted }}>
                Current rates for your plan. Historical costs use the rates at the time of each request.
              </p>
              {usage.lines.map((line, i) => (
                <div key={`${line.label}-${i}`} style={styles.meterRow}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 14, color: C.body }}>{line.label}</span>
                    {line.quantity != null && (
                      <span style={styles.mono}>
                        {line.quantity.toLocaleString()} units
                        {line.included === false ? " · Not included in your plan" : Number.isFinite(line.rate)
                          ? ` at ${formatMoney(line.rate, currency)} each`
                          : ""}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 15, color: C.head, fontVariantNumeric: "tabular-nums" }}>
                    {formatUsageMoney(line.amount, currency)}
                  </span>
                </div>
              ))}
              <div style={styles.totalRow}>
                <span style={{ fontSize: 14, fontWeight: 500, color: C.head }}>
                  Total settled usage
                </span>
                <span style={{ fontSize: 15, fontWeight: 500, color: C.head, fontVariantNumeric: "tabular-nums" }}>
                    {formatUsageMoney(usage?.accrued, currency)}
                </span>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
            {embedError && (
              <div role="status" style={styles.warning}>
                <strong style={{ color: C.head }}>Charts are unavailable.</strong>{" "}
                Usage totals will continue updating while the embedded Moesif
                workspaces reconnect.
              </div>
            )}
            <ChartCard title="Recent API activity" url={embedTemplateUrls[0]} loading={embedLoading} />
            <ChartCard title="Usage over time" url={embedTemplateUrls[1]} loading={embedLoading} />
          </div>
          {analytics?.updatedAt && (
            <div style={styles.updatedAt}>
              Usage checked {new Date(analytics.updatedAt).toLocaleTimeString()}
            </div>
          )}
        </div>
      ) : (
        <div style={styles.metricCard}>
          <div style={{ fontSize: 15, fontWeight: 500, color: C.head }}>
            Usage data is temporarily unavailable
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: C.muted }}>
            Your portal remains available. This page will retry automatically.
          </p>
        </div>
      )}
    </div>
  );
}

const styles = {
  eyebrow: {
    fontSize: 12,
    letterSpacing: 0,
    textTransform: "uppercase",
    color: C.muted,
    marginBottom: 10,
  },
  h1: {
    margin: "0 0 8px",
    fontSize: 32,
    lineHeight: 1.15,
    fontWeight: 500,
    letterSpacing: 0,
    color: C.head,
  },
  lead: { margin: 0, fontSize: 15, color: C.muted },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
    gap: 16,
  },
  metricCard: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    padding: 20,
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  metricLabel: { fontSize: 13, color: C.muted, marginBottom: 14 },
  metricValue: {
    fontSize: 34,
    lineHeight: 1,
    fontWeight: 500,
    letterSpacing: 0,
    color: C.head,
    fontVariantNumeric: "tabular-nums",
  },
  metricSub: { fontSize: 13, color: C.muted, marginTop: 12 },
  bar: {
    position: "relative",
    height: 10,
    borderRadius: 999,
    background: C.track,
    overflow: "hidden",
  },
  barFill: {
    position: "absolute",
    inset: 0,
    background: C.green,
    borderRadius: "999px 0 0 999px",
  },
  progressMeta: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 10,
    fontSize: 12,
    color: C.muted,
  },
  meterRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 24,
    padding: "15px 0",
    borderTop: `1px solid ${C.lineSoft}`,
  },
  mono: {
    fontSize: 12.5,
    color: C.muted,
    fontFamily: "'Fira Code', monospace",
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "16px 0 0",
    borderTop: `1px solid ${C.line}`,
    marginTop: 4,
  },
  chartCard: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    overflow: "hidden",
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  chartHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 24px",
    borderBottom: `1px solid ${C.lineSoft}`,
  },
  pill: {
    fontSize: 12,
    color: C.muted,
    background: C.page,
    border: `1px solid ${C.line}`,
    padding: "4px 10px",
    borderRadius: 999,
  },
  warning: {
    marginBottom: 16,
    padding: "12px 14px",
    border: "1px solid #E8C66A",
    borderRadius: 8,
    background: "#FFF8E5",
    color: C.body,
    fontSize: 13,
    lineHeight: 1.5,
  },
  updatedAt: {
    marginTop: 10,
    textAlign: "right",
    color: C.muted,
    fontSize: 12,
  },
};
