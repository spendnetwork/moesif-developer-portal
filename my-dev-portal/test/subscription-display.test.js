import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

let server, SubDisplay;
before(async () => {
  server = await createServer({ configFile: false, plugins: [react(), {
    name: "node-lodash-resolution",
    enforce: "pre",
    resolveId(id) {
      if (id === "lodash/isNil") return { id: "lodash/isNil.js", external: true };
    },
  }],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: { port: 0 } },
  });
  SubDisplay = (await server.ssrLoadModule("/src/components/pages/subscription/SubDisplay.jsx")).default;
});
after(async () => { await server?.close(); });

const price = { name: "API calls", currency: "GBP", price_in_decimal: 0.26, pricing_model: "per_unit" };
const sub = { plan_key: "basic", subscription_id: "billing_test", status: "active", billing_model: "prepaid_credit",
  items: [{ plan_id: "plan_test", price_id: "price_test", price }],
};
function render(plans, subscription = sub) {
  return renderToStaticMarkup(React.createElement(SubDisplay, { sub: subscription, plans, onManage() {} }));
}

test("Billing renders embedded rates and Add credit before its catalogue arrives", () => {
  for (const plans of [null, undefined, [], {}]) {
    const html = render(plans);
    assert.match(html, /£0\.26 \/ unit/);
    assert.match(html, /Add credit/);
    assert.doesNotMatch(html, /disabled=""/);
  }
});

test("legacy subscriptions without a plan key render safely during catalogue loading", () => {
  const legacy = { ...sub, plan_key: undefined, items: [{ plan_id: "plan_test", price_id: "price_test" }] };
  const pending = render(null, legacy);
  assert.match(pending, /Your subscription/);
  assert.match(pending, /Unavailable/);
  const loaded = render([{ id: "plan_test", name: "Legacy Basic", prices: [{ ...price, id: "price_test" }] }], legacy);
  assert.match(loaded, /Legacy Basic/);
  assert.match(loaded, /£0\.26 \/ unit/);
});
