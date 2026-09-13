// Run against test/preview.mjs. All billing responses are fixtures.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.PORTAL_QA_URL || "http://127.0.0.1:4178";
const output = process.env.PORTAL_QA_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const subscription = {
  subscription_id: "prepaid_billing_qa", plan_key: "basic", status: "active",
  billing_model: "prepaid_credit", debit_owner: "api", wallet_enabled: true,
  items: [{ plan_id: "plan_qa", price_id: "price_qa", price: {
    name: "API calls", currency: "GBP", price_in_decimal: 0.26, pricing_model: "per_unit",
  } }],
};
const catalogue = { hits: [{ id: "plan_qa", name: "Basic", status: "active", prices: [
  { id: "price_qa", name: "API calls", currency: "GBP", price_in_decimal: 0.26, pricing_model: "per_unit" },
] }] };
try {
  for (const scenario of ["navigation-delayed", "navigation-failed", "direct-delayed", "catalogue-first", "legacy-delayed", "mobile-delayed"]) {
    const page = await browser.newPage({ viewport: { width: scenario === "mobile-delayed" ? 390 : 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let releaseCatalogue;
    const catalogueGate = new Promise(resolve => { releaseCatalogue = resolve; });
    let catalogueSeen;
    const catalogueRequested = new Promise(resolve => { catalogueSeen = resolve; });
    let releaseSubscriptions;
    const subscriptionGate = new Promise(resolve => { releaseSubscriptions = resolve; });
    const legacy = scenario === "legacy-delayed";
    const supplied = structuredClone(subscription);
    if (legacy) delete supplied.items[0].price;
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (url.pathname === "/qa-api/plans") {
        catalogueSeen();
        if (scenario === "navigation-failed") return route.fulfill({ status: 503, json: { message: "Catalogue unavailable" } });
        if (scenario !== "catalogue-first") await catalogueGate;
        return route.fulfill({ json: catalogue });
      }
      if (url.pathname === "/qa-api/subscriptions") {
        if (scenario === "catalogue-first") await subscriptionGate;
        return route.fulfill({ json: [supplied] });
      }
      return route.continue();
    });
    try {
      if (scenario === "direct-delayed") await page.goto(`${base}/subscription?fixture=wallet-basic`);
      else {
        await page.goto(`${base}/plans?fixture=wallet-basic`);
        await page.getByRole("heading", { name: "Open Opportunities API plans" }).waitFor();
        if (scenario === "mobile-delayed") {
          // Exercise the SPA route on narrow screens without depending on the menu state.
          await page.evaluate(() => { history.pushState({}, "", "/subscription"); dispatchEvent(new PopStateEvent("popstate")); });
        } else await page.getByRole("link", { name: "Billing", exact: true }).click();
      }
      await catalogueRequested;
      if (scenario === "catalogue-first") releaseSubscriptions();
      await page.getByRole("heading", { name: "Plan and credit", exact: true }).waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: "Add credit", exact: true }).waitFor();
      if (!legacy) await page.getByText("£0.26 / unit", { exact: true }).waitFor();
      assert.deepEqual(errors, [], `${scenario}: no render exceptions`);
      if (output) await page.screenshot({ path: path.join(output, `billing-${scenario}.png`), fullPage: true });
      releaseCatalogue();
      await page.getByText("£0.26 / unit", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.getByRole("button", { name: "Add credit", exact: true }).click();
      await page.waitForURL("**/credit");
      assert.deepEqual(errors, [], `${scenario}: navigation remains usable`);
      console.log(`PASS: ${scenario}`);
    } catch (error) {
      console.error(scenario, errors);
      throw error;
    } finally {
      releaseCatalogue(); releaseSubscriptions(); await page.close();
    }
  }
} finally { await browser.close(); }
