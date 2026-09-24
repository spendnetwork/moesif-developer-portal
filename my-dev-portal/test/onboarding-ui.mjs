// All account, document and acceptance responses are isolated fixtures.
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
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    let accepted = false, disconnected = false, posts = 0;
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const document = { version: "fixture-v1", title: "Terms of API Access", sha256: "a".repeat(64),
      text: "TEST FIXTURE ONLY. Not approved legal terms.\n\n" + Array.from({ length: 18 }, (_, i) => `${i + 1}. Example section\nFixture content for testing scroll, explicit acceptance, interruptions and accessibility. This is not a legal agreement.\n`).join("\n") };
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(base).origin) return route.abort();
      if (url.pathname === "/qa-api/onboarding/accept") {
        posts++;
        const body = route.request().postDataJSON();
        if (body.version !== document.version) return route.fulfill({ status: 409, json: { code: "terms_version_changed" } });
        assert.deepEqual(body, { version: document.version, sha256: document.sha256, agreed: true });
        if (disconnected) return route.abort("internetdisconnected");
        accepted = true;
        // Simulate successful commit with its response lost in transit.
        return route.abort("connectionreset");
      }
      if (url.pathname === "/qa-api/onboarding") {
        if (disconnected) return route.abort("internetdisconnected");
        return route.fulfill({ json: { enabled: true, required: !accepted, version: document.version, document, accepted_at: accepted ? "2026-09-24T12:00:00Z" : null } });
      }
      return route.continue();
    });
    await page.goto(`${base}/keys?fixture=wallet-basic`);
    await page.getByRole("heading", { name: "Welcome to the Open Opportunities API" }).waitFor();
    const checkbox = page.getByRole("checkbox");
    const button = page.getByRole("button", { name: "Accept and continue" });
    assert.equal(await checkbox.isDisabled(), true);
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.getByText("Integration key", { exact: true }).count(), 0);
    await page.reload();
    await page.getByRole("heading", { name: "Welcome to the Open Opportunities API" }).waitFor();
    await page.getByRole("region", { name: "Terms document" }).evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll")); });
    await checkbox.check();
    if (output) await page.screenshot({ path: path.join(output, `onboarding-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    disconnected = true;
    await button.click();
    await page.getByRole("alert").waitFor();
    assert.equal(accepted, false);
    assert.equal(await checkbox.isChecked(), true);
    disconnected = false;
    await button.click();
    await page.getByText("Integration key", { exact: true }).waitFor();
    assert.equal(posts, 2);
    await page.reload();
    await page.getByText("Integration key", { exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox").count(), 0);
    accepted = false;
    await page.reload();
    await page.getByRole("region", { name: "Terms document" }).evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll")); });
    await page.getByRole("checkbox").check();
    document.version = "fixture-v2";
    document.sha256 = "b".repeat(64);
    await page.getByRole("button", { name: "Accept and continue" }).click();
    await page.getByText("Version fixture-v2", { exact: true }).waitFor();
    assert.equal(accepted, false);
    assert.equal(await page.getByRole("checkbox").isChecked(), false);
    assert.equal(await page.getByRole("button", { name: "Accept and continue" }).isDisabled(), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Onboarding desktop/mobile: scroll, explicit agreement, reload, offline retry and lost response recovery passed.");
} finally { await browser.close(); }
