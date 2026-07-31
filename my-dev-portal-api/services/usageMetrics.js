const METRIC_ORDER = [
  "api_call",
  "records_returned",
  "aggregate_call",
  "attachment",
];

const METRIC_LABELS = {
  api_call: "API calls",
  records_returned: "Records returned",
  aggregate_call: "Aggregate calls",
  attachment: "Attachments",
};

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metricKey(price) {
  const metadata = price?.metadata || {};
  const explicit =
    metadata.usage_metric ||
    metadata.billable_metric ||
    metadata.unit_name ||
    metadata.price_key;
  const source = String(explicit || price?.nickname || price?.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (source.includes("aggregate")) return "aggregate_call";
  if (source.includes("attachment")) return "attachment";
  if (source.includes("record") || source.includes("document")) {
    return "records_returned";
  }
  if (source.includes("api_call") || source.includes("api_calls")) {
    return "api_call";
  }
  return source;
}

function priceUnitAmountPence(price) {
  const minorUnits = finiteNumber(
    price?.unit_amount_decimal ?? price?.unit_amount
  );
  if (minorUnits != null) return minorUnits;
  const majorUnits = finiteNumber(price?.price_in_decimal);
  return majorUnits == null ? null : majorUnits * 100;
}

function metricOrder(left, right) {
  const leftIndex = METRIC_ORDER.indexOf(left.key);
  const rightIndex = METRIC_ORDER.indexOf(right.key);
  return (leftIndex < 0 ? METRIC_ORDER.length : leftIndex) -
    (rightIndex < 0 ? METRIC_ORDER.length : rightIndex);
}

module.exports = {
  METRIC_LABELS,
  METRIC_ORDER,
  finiteNumber,
  metricKey,
  metricOrder,
  priceUnitAmountPence,
};
