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

function ChartCard({ title, url }) {
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
            Chart unavailable
          </div>
        )}
      </div>
    </div>
  );
}

export default function UsageView({ idToken, embedTemplateUrls = [] }) {
  const { usage, usageLoading } = useUsageSummary({ idToken });

  const loading = usageLoading && !usage;
  const currency = usage?.currency || "GBP";
  const credit = usage?.credit || null;
  const isPrepaidBasic = usage?.billingModel === "prepaid_credit";
  const hasCurrentEstimate =
    !isPrepaidBasic && Number.isFinite(credit?.projectedRemaining);
  const displayedRemaining = hasCurrentEstimate
    ? credit.projectedRemaining
    : credit?.remaining;
  const displayedUsed =
    hasCurrentEstimate && Number.isFinite(credit?.granted)
      ? Math.max(0, credit.granted - credit.projectedRemaining)
      : credit?.used;

  const usedPct =
    credit && credit.granted > 0
      ? Math.min(100, Math.round(((credit.used || 0) / credit.granted) * 100))
      : 0;
  const projectedPct =
    credit && credit.granted > 0
      ? Math.min(
          100,
          Math.round(
            ((credit.granted - credit.projectedRemaining) / credit.granted) * 100
          )
        )
      : 0;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ marginBottom: 28 }}>
        <div style={styles.eyebrow}>Usage</div>
        <h1 style={styles.h1}>API activity</h1>
        <p style={styles.lead}>
          What you have used this billing period, and how your credit is drawing
          down.
        </p>
      </div>

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
      ) : (
        <div>
          <div style={styles.twoCol}>
            <div style={styles.metricCard}>
              <div style={styles.metricLabel}>Usage this period</div>
              <div style={styles.metricValue}>
                {formatMoney(usage?.accrued || 0, currency)}
              </div>
              <div style={styles.metricSub}>
                {usage?.period?.start && usage?.period?.end
                  ? `${formatDate(usage.period.start)} – ${formatDate(
                      usage.period.end,
                      true
                    )}`
                  : "Current billing period"}
              </div>
            </div>

            {credit && (
              <div style={styles.metricCard}>
                <div style={styles.metricLabel}>
                  {hasCurrentEstimate
                    ? "Estimated credit remaining"
                    : "Credit remaining"}
                </div>
                <div style={styles.metricValue}>
                  {formatMoney(displayedRemaining, currency)}
                </div>
                <div style={{ ...styles.metricSub, marginBottom: 14 }}>
                  {formatMoney(displayedUsed, currency)} of{" "}
                  {formatMoney(credit.granted, currency)}{" "}
                  {hasCurrentEstimate ? "estimated used" : "used"}
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={usedPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  style={styles.bar}
                >
                  <div style={{ ...styles.barProjected, width: `${projectedPct}%` }} />
                  <div style={{ ...styles.barFill, width: `${usedPct}%` }} />
                </div>
                {hasCurrentEstimate && (
                  <div style={styles.projRow}>
                    <span
                      style={{
                        fontSize: 12.5,
                        fontStyle: "italic",
                        color: C.muted,
                      }}
                    >
                      Stripe posted balance:{" "}
                      {formatMoney(credit.remaining, currency)}
                    </span>
                    <span style={styles.legend}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: C.mint,
                        }}
                      />
                      estimated
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {usage?.lines && usage.lines.length > 0 && (
            <div style={{ ...styles.metricCard, marginTop: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 500, color: C.head, marginBottom: 6 }}>
                This period by metric
              </div>
              <p style={{ margin: "0 0 8px", fontSize: 13, color: C.muted }}>
                Each meter is priced at the unit rate for your plan.
              </p>
              {usage.lines.map((line, i) => (
                <div key={`${line.label}-${i}`} style={styles.meterRow}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 14, color: C.body }}>{line.label}</span>
                    {line.quantity != null && (
                      <span style={styles.mono}>
                        {line.quantity.toLocaleString()} units
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 15, color: C.head, fontVariantNumeric: "tabular-nums" }}>
                    {formatMoney(line.amount, currency)}
                  </span>
                </div>
              ))}
              <div style={styles.totalRow}>
                <span style={{ fontSize: 14, fontWeight: 500, color: C.head }}>
                  Total this period
                </span>
                <span style={{ fontSize: 15, fontWeight: 500, color: C.head, fontVariantNumeric: "tabular-nums" }}>
                  {formatMoney(usage?.accrued || 0, currency)}
                </span>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
            <ChartCard title="Recent API activity" url={embedTemplateUrls[0]} />
            <ChartCard title="Usage over time" url={embedTemplateUrls[1]} />
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  eyebrow: {
    fontSize: 12,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: C.muted,
    marginBottom: 10,
  },
  h1: {
    margin: "0 0 8px",
    fontSize: 32,
    lineHeight: 1.15,
    fontWeight: 500,
    letterSpacing: "-0.02em",
    color: C.head,
  },
  lead: { margin: 0, fontSize: 15, color: C.muted },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  metricCard: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 24,
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  metricLabel: { fontSize: 13, color: C.muted, marginBottom: 14 },
  metricValue: {
    fontSize: 38,
    lineHeight: 1,
    fontWeight: 500,
    letterSpacing: "-0.03em",
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
  barProjected: { position: "absolute", inset: 0, background: C.mint },
  barFill: {
    position: "absolute",
    inset: 0,
    background: C.green,
    borderRadius: "999px 0 0 999px",
  },
  projRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 12,
  },
  legend: {
    display: "flex",
    alignItems: "center",
    gap: 6,
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
    borderRadius: 12,
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
};
