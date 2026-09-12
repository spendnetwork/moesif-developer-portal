// Run against test/preview.mjs; all key actions below are intercepted fixtures.
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
    let failPause = true;
    let pauseRequests = 0;
    let key = { id: 1, name: "Integration key", is_active: true, key_prefix: "openopps_api_ABCDEF", created_at: "2026-09-01T00:00:00Z", age_days: 11, rotation_status: "current" };
    const other = { ...key, id: 2, name: "Other integration" };
    await page.route("**/*", async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== new URL(base).origin) return route.abort();
      if (url.pathname === "/qa-api/api-keys") return route.fulfill({ json: { keys: [key, other], has_active_subscription: true, max_keys: 2, active_count: key.is_active ? 2 : 1 } });
      if (url.pathname === "/qa-api/api-keys/1/pause") {
        pauseRequests++;
        if (failPause) { failPause = false; return route.fulfill({ status: 503, json: { message: "Temporary failure. Retry this action." } }); }
        key = { ...key, is_active: false };
        return route.fulfill({ json: key });
      }
      if (url.pathname === "/qa-api/api-keys/1/resume") {
        key = { ...key, is_active: true };
        return route.fulfill({ json: key });
      }
      return route.continue();
    });
    await page.goto(`${base}/keys?fixture=wallet-basic`);
    await page.getByRole("heading", { name: "API keys (2)" }).waitFor();
    await page.getByRole("button", { name: "Pause", exact: true }).first().click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(pauseRequests, 0);
    await page.getByRole("button", { name: "Pause", exact: true }).first().click();
    await page.getByRole("button", { name: "Pause key", exact: true }).click();
    await page.getByRole("dialog").getByRole("alert").waitFor();
    assert.equal(key.is_active, true);
    await page.getByRole("button", { name: "Pause key", exact: true }).click();
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create API key", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Rotate", exact: true }).first().isDisabled(), true);
    await page.reload();
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (output) await page.screenshot({ path: path.join(output, `paused-keys-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByRole("button", { name: "Resume key", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).nth(1).waitFor();
    assert.equal(await page.getByRole("button", { name: "Rotate", exact: true }).first().isEnabled(), true);
    assert.equal(key.is_active, true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS: pause/resume, cancellation, failed action retry, reload, key limit and desktop/mobile layout.");
} finally { await browser.close(); }
