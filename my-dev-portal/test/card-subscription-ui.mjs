// Isolated preview: no Auth0, Stripe, Moesif or live API requests.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.PORTAL_QA_URL || "http://127.0.0.1:4178";
const output = process.env.PORTAL_QA_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin !== new URL(base).origin) return route.abort();
      return route.continue();
    });
    for (const [plan, amount] of [["growth", "5,000"], ["enterprise", "12,000"]]) {
      await page.goto(`${base}/credit?package=${plan}&fixture=wallet-basic`);
      const subscribe = page.getByRole("button", { name: "Continue to annual subscription", exact: true });
      await subscribe.waitFor();
      await page.getByText(`£${amount} automatically each year`, { exact: true }).waitFor();
      assert.equal(await subscribe.isEnabled(), true);
      await page.getByRole("radio", { name: "Invoice from our team", exact: true }).check();
      await page.getByRole("button", { name: "Request invoice", exact: true }).waitFor();
      assert.equal(await page.getByText(`£${amount} automatically each year`, { exact: true }).count(), 0);
      await page.getByRole("radio", { name: "Card through Stripe", exact: true }).check();
      await subscribe.waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (output) await page.screenshot({ path: path.join(output, `${plan}-${width}.png`), fullPage: true });
    }
    await page.goto(`${base}/credit?fixture=wallet-basic`);
    const topup = page.getByRole("button", { name: "Continue to card payment", exact: true });
    await topup.waitFor();
    assert.equal(await topup.isEnabled(), true);
    assert.equal(await page.getByText("Annual renewal", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Card subscription checkout: desktop/mobile terms, invoice alternative and Basic top-ups passed.");
} finally { await browser.close(); }
