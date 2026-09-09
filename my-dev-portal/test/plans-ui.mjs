// Run against test/preview.mjs. All account and billing responses are isolated fixtures.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const output = process.env.PORTAL_QA_OUTPUT;
if (!output) throw new Error("Set PORTAL_QA_OUTPUT to a screenshot directory");
await mkdir(output, { recursive: true });
const base = "http://127.0.0.1:4178";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];

async function scenario(width, currentPlan = null, initialChange = null, basicAvailable = true, paidHistory = false) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  let change = initialChange;
  const mutations = [];
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith("/qa-api/")) return route.continue();
    const endpoint = url.pathname.slice("/qa-api".length);
    if (request.method() !== "GET") {
      mutations.push({ endpoint, method: request.method(), search: url.search });
      if (endpoint === "/create-stripe-checkout-session") {
        change = { change_type: "downgrade", from_plan_key: currentPlan, to_plan_key: "basic", effective_at: "2027-09-01T00:00:00Z", status: "scheduled" };
        return route.fulfill({ json: { scheduled: true } });
      }
      if (endpoint === "/plan-change" && request.method() === "DELETE") {
        change = null;
        return route.fulfill({ json: {} });
      }
      throw new Error(`Unexpected billing mutation: ${endpoint}`);
    }
    const responses = {
      "/plans": { hits: (basicAvailable ? ["basic", "growth", "enterprise"] : ["growth", "enterprise"]).map(key => ({ id: `prod_${key}`, name: key, status: "active", metadata: { plan_key: key } })) },
      "/subscriptions": currentPlan ? [{ plan_key: currentPlan, status: "active", id: `fixture_${currentPlan}` }] : [],
      "/plan-change": change,
      "/portal-context": { current_plan_key: currentPlan, billing_status: currentPlan ? "active" : null, has_activated_paid_plan: paidHistory },
      "/usage-summary": { hasSubscription: false },
    };
    return endpoint in responses ? route.fulfill({ json: responses[endpoint] }) : route.continue();
  });
  await page.goto(`${base}/plans?fixture=unprovisioned`);
  await page.getByRole("heading", { name: "Open Opportunities API plans", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, mutations };
}

async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const clipped = await page.evaluate(() => [...document.querySelectorAll(".plans-page button, .plans-page h1, .plans-page h2, .plans-dialog button")]
    .filter(el => el.getClientRects().length)
    .filter(el => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > innerWidth + 1)
    .map(el => el.textContent));
  assert.deepEqual(clipped, []);
}

try {
  for (const width of [1440, 1024, 900, 768, 720, 390, 320]) {
    const { page, mutations } = await scenario(width);
    const desktop = width > 860;
    assert.equal(await page.locator(".plan-comparison").count(), 0);
    const headings = await page.locator(".plan-option h2").allTextContents();
    assert.deepEqual(headings, ["Basic", "Growth", "Enterprise"]);
    const rates = await page.locator(".plan-option__rates dd").allTextContents();
    assert.deepEqual(rates, ["£0.13", "£0.26", "Not included", "£0.65", "£0.10", "£0.20", "£0.35", "£0.50", "£0.07", "£0.14", "£0.25", "£0.35"]);
    const cardBoxes = await page.locator(".plan-option").evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON()));
    if (desktop) assert.equal(new Set(cardBoxes.map(box => box.height)).size, 1);
    else assert.ok(cardBoxes[1].top >= cardBoxes[0].bottom);
    assert.ok((await page.locator(".development-banner").boundingBox()).y >= cardBoxes[2].bottom);
    assert.equal(await page.getByText("Highlight differences", { exact: true }).count(), 0);
    assert.equal(await page.locator(".development-banner").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(241, 244, 242)");
    assert.equal(await page.getByRole("heading", { name: "Testing the API?" }).count(), 1);
    await noOverflow(page);
    await page.screenshot({ path: path.join(output, `cards-${width}.png`), fullPage: true });
    const cta = page.getByRole("button", { name: "Choose Basic", exact: true });
    const before = await cta.boundingBox();
    await cta.hover();
    assert.deepEqual(await cta.boundingBox(), before);
    await cta.click();
    await page.getByRole("dialog", { name: "Start Basic" }).waitFor();
    await noOverflow(page);
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[role="dialog"]'))), true);
    }
    await page.keyboard.press("Escape");
    assert.equal(await cta.evaluate(el => document.activeElement === el), true);
    await page.getByRole("button", { name: "Request access", exact: true }).click();
    const devDialog = page.getByRole("dialog", { name: "Talk to us about Development" });
    await devDialog.waitFor();
    assert.equal(await devDialog.getByRole("link", { name: "welcome@openopps.com" }).getAttribute("href"), "mailto:welcome@openopps.com");
    await noOverflow(page);
    await page.screenshot({ path: path.join(output, `development-dialog-${width}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    for (const [index, plan] of ["Growth", "Enterprise"].entries()) {
      await page.getByRole("button", { name: "Contact us", exact: true }).nth(index).click();
      await page.getByRole("dialog", { name: `Talk to us about ${plan}` }).waitFor();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await cta.click();
    await page.getByRole("button", { name: "Continue to checkout", exact: true }).click();
    await page.waitForURL("**/checkout?**");
    assert.equal(new URL(page.url()).searchParams.get("purchase_type"), "basic_activation");
    assert.equal(new URL(page.url()).searchParams.get("plan_id_to_purchase"), "prod_basic");
    assert.deepEqual(mutations, []);
    await page.close();
    console.log(`PASS ${width}px: cards, banner, rates, focus, contact dialogs, Basic checkout, no overflow`);
  }

  for (const width of [1440, 390, 320]) {
    const { page, mutations } = await scenario(width, "basic");
    assert.equal(await page.locator(".development-banner").count(), 0);
    await page.getByRole("button", { name: "Add credit", exact: true }).click();
    await page.waitForURL("**/checkout?**");
    assert.equal(new URL(page.url()).searchParams.get("purchase_type"), "basic_credit_top_up");
    assert.deepEqual(mutations, []);
    await page.close();

    for (const plan of ["growth", "enterprise"]) {
      const { page, mutations } = await scenario(width, plan);
      assert.equal(await page.locator(".development-banner").count(), 0);
      await noOverflow(page);
      assert.equal(await page.getByRole("button", { name: "Current plan", exact: true }).isDisabled(), true);
      await page.getByRole("button", { name: "Schedule Basic", exact: true }).click();
      await page.getByRole("dialog", { name: "Switch to Basic?" }).waitFor();
      await page.getByRole("button", { name: "Schedule downgrade", exact: true }).click();
      await page.getByText(/Downgrade to basic is scheduled/).waitFor();
      assert.equal(await page.getByRole("button", { name: "Schedule Basic", exact: true }).isDisabled(), true);
      assert.deepEqual(mutations.map(m => [m.endpoint, m.method]), [["/create-stripe-checkout-session", "POST"]]);
      await page.getByRole("button", { name: "Cancel change" }).click();
      await page.waitForFunction(() => !document.body.textContent.includes("Downgrade to basic is scheduled"));
      assert.equal(await page.getByRole("button", { name: "Schedule Basic", exact: true }).isEnabled(), true);
      await page.close();
    }
    const dev = await scenario(width, "development");
    assert.equal(await dev.page.locator(".development-banner").getByText("Development access · Current plan").count(), 1);
    assert.equal(await dev.page.getByRole("button", { name: "Choose Basic", exact: true }).isEnabled(), true);
    await dev.page.close();
    console.log(`PASS ${width}px: Basic top-up, paid current plans, schedule/cancel downgrade, existing Development`);
  }

  const missing = await scenario(1440, "basic", null, false);
  await missing.page.getByRole("button", { name: "Add credit", exact: true }).click();
  await missing.page.getByRole("alert").filter({ hasText: "Basic credit purchases are not available" }).waitFor();
  assert.deepEqual(missing.mutations, []);
  await missing.page.close();
  const previousSubscriber = await scenario(390, null, null, true, true);
  assert.equal(await previousSubscriber.page.locator(".development-banner").count(), 0);
  await previousSubscriber.page.close();
  assert.deepEqual(errors, []);
  console.log("PASS unavailable Basic catalog entry, no real billing mutations, no browser errors");
} finally {
  await browser.close();
}
