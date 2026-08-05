const test = require("node:test");
const assert = require("node:assert/strict");

process.env.STRIPE_API_KEY ||= "sk_test_plan_change_unit_tests";

const {
  addUtcYears,
  annualCommitmentBoundary,
} = require("../services/stripeApis");

test("downgrade boundary comes from the annual commitment item", () => {
  const annualEnd = 1810000000;
  const monthlyEnd = 1781000000;
  const boundary = annualCommitmentBoundary({
    items: {
      data: [
        {
          current_period_end: monthlyEnd,
          price: {
            recurring: { interval: "month", usage_type: "metered" },
            metadata: { billing_category: "usage" },
          },
        },
        {
          current_period_end: annualEnd,
          price: {
            recurring: { interval: "year", usage_type: "licensed" },
            metadata: { billing_category: "commitment" },
          },
        },
      ],
    },
  });

  assert.equal(boundary, annualEnd);
});

test("downgrade fails closed without exactly one annual commitment", () => {
  assert.throws(
    () => annualCommitmentBoundary({ items: { data: [] } }),
    (error) => error.code === "commitment_boundary_unavailable"
  );
});

test("annual schedule phases preserve the UTC calendar date", () => {
  const leapDay = Date.UTC(2028, 1, 29, 12, 0, 0) / 1000;
  const nextYear = new Date(addUtcYears(leapDay) * 1000);
  assert.equal(nextYear.toISOString(), "2029-03-01T12:00:00.000Z");
});
