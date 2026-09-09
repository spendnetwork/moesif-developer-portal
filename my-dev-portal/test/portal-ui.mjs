import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const output = process.env.PORTAL_QA_OUTPUT;
if (!output) throw new Error("Set PORTAL_QA_OUTPUT to a screenshot directory");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const width of [1365, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
    });
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const bannerBelowHeader = async () => {
      const header = await page.locator(width <= 640 ? ".mobile-nav-bar__container" : ".nav-bar__container").boundingBox();
      const banner = await page.getByRole("alert").first().boundingBox();
      assert.ok(header && banner && banner.y >= header.y + header.height, `Banner must be below the header at ${width}px`);
    };
    await page.goto("http://127.0.0.1:4178/plans?fixture=development-exhausted");
    await page.getByRole("heading", { name: "Open Opportunities API plans", exact: true }).waitFor();
    assert.equal(await page.getByText("Development allowance exhausted", { exact: true }).count(), 1);
    await bannerBelowHeader();
    await noOverflow();
    await page.screenshot({ path: path.join(output, `plans-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Choose Basic", exact: true }).click();
    await page.getByRole("button", { name: "Continue to checkout", exact: true }).click();
    await page.getByRole("heading", { name: "Start Basic", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => scrollY), 0);
    await bannerBelowHeader();
    await page.getByLabel("Credit amount").fill("99.99");
    assert.equal(await page.getByLabel("Credit amount").evaluate(el => el.validity.rangeUnderflow), true);
    await noOverflow();
    await page.screenshot({ path: path.join(output, `checkout-${width}.png`), fullPage: true });
    if (width < 640) {
      const toggle = page.getByRole("button", { name: "Open menu", exact: true });
      assert.equal(await toggle.locator("img").evaluate(el => el.complete && el.naturalWidth > 0), true);
      await toggle.click();
      await page.getByRole("button", { name: "Close menu", exact: true }).click();
    }
    await page.goto("http://127.0.0.1:4178/keys?fixture=development-exhausted");
    await page.getByText("Integration key", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create API key", exact: true }).isEnabled(), true);
    await noOverflow();
    await page.screenshot({ path: path.join(output, `keys-${width}.png`), fullPage: true });
    await page.goto("http://127.0.0.1:4178/dashboard?fixture=development-exhausted");
    await page.getByText("Development allowance remaining", { exact: true }).waitFor({ timeout: 5000 });
    const fixtureSummary = await page.evaluate(async () => {
      const response = await fetch("/qa-api/usage-summary", { headers: { Authorization: "Bearer development-exhausted" } });
      return response.json();
    });
    assert.equal(fixtureSummary.credit.granted, 10010);
    for (const line of fixtureSummary.lines) assert.equal(line.amount, line.quantity * line.rate);
    assert.equal(fixtureSummary.accrued, fixtureSummary.lines.reduce((sum, line) => sum + line.amount, 0));
    await bannerBelowHeader();
    assert.equal(await page.getByText("Attachments", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Attachment downloads", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Loading chart...", { exact: true }).count(), 2);
    await noOverflow();
    await page.screenshot({ path: path.join(output, `usage-${width}.png`), fullPage: true });
    await page.goto("http://127.0.0.1:4178/plans?fixture=basic-exhausted");
    await page.getByText("Prepaid credit exhausted", { exact: true }).waitFor();
    await bannerBelowHeader();
    const addCredit = page.getByRole("link", { name: "Add credit from £100", exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('a')].some(a => a.textContent === 'Add credit from £100' && a.href.includes('basic_credit_top_up')));
    await addCredit.click();
    await page.getByRole("heading", { name: "Add API credit", exact: true }).waitFor();
    assert.ok(page.url().includes("purchase_type=basic_credit_top_up"));
    await page.goto("http://127.0.0.1:4178/plans?fixture=unprovisioned");
    await page.getByRole("heading", { name: "Open Opportunities API plans", exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.goto("http://127.0.0.1:4178/dashboard?fixture=development-paused");
    await page.getByText("Development allowance remaining", { exact: true }).waitFor();
    await page.getByText("API access paused", { exact: true }).waitFor();
    await bannerBelowHeader();
    assert.equal(await page.getByText("£96.20", { exact: true }).count(), 1);
    await noOverflow();
    await page.screenshot({ path: path.join(output, `paused-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: plans, minimum, route scroll, menu, exhausted keys/usage, slow charts, Basic top-up, banner clearance, unprovisioned, paused balance`);
    await page.close();
  }
} finally {
  await browser.close();
}
