// Run against test/preview.mjs. No real account, payment or analytics requests.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");
const output = process.env.PORTAL_QA_OUTPUT;
if (!output) throw new Error("Set PORTAL_QA_OUTPUT");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
const base = process.env.PORTAL_QA_URL || "http://127.0.0.1:4178";

async function pageFor(width, tier = null) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  const purchases = [];
  const requests = [];
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (url.pathname === "/qa-api/portal-context") return route.fulfill({ json: {
      current_plan_key: tier, has_activated_paid_plan: Boolean(tier), wallet_enabled: Boolean(tier),
    } });
    if (url.pathname === "/qa-api/wallet/purchases") {
      if (request.method() === "GET") return route.fulfill({ json: { purchases } });
      const body = request.postDataJSON();
      requests.push(body);
      const receipt = { request_id: body.requestId, purchase_kind: body.purchaseKind,
        payment_provider: body.paymentMethod === "invoice" || (!body.paymentMethod && body.amountGbp >= 5000) ? "invoice" : "stripe",
        amount_gbp_pence: Math.round(body.amountGbp * 100), status: "awaiting_payment" };
      if (!purchases.some(item => item.request_id === receipt.request_id)) purchases.push(receipt);
      if (receipt.payment_provider === "stripe") {
        // Simulate an uncertain checkout response; test retry without navigating to Stripe.
        return route.fulfill({ status: 503, json: { message: "Checkout is temporarily unavailable. Resume this purchase." } });
      }
      return route.fulfill({ json: receipt });
    }
    return route.continue();
  });
  return { page, purchases, requests };
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(await page.locator("main button, main h1, main h2").evaluateAll(elements => elements
    .filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
    .map(el => el.textContent)), []);
}
try {
  for (const width of [1440, 1024, 768, 390, 320]) {
    const { page, purchases } = await pageFor(width);
    await page.goto(base + "/plans?fixture=unprovisioned");
    const growthButton = page.getByRole("button", { name: "Pay £5,000 by card", exact: true });
    await growthButton.waitFor();
    assert.equal(await page.getByRole("button", { name: "Pay £12,000 by card", exact: true }).count(), 1);
    assert.equal(await page.getByRole("link", { name: "Request an invoice instead" }).count(), 2);
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await page.locator(".plan-option h2").allTextContents(), ["Basic", "Growth", "Enterprise"]);
    assert.equal(await page.getByRole("heading", { name: "Testing the API?" }).count(), 0);
    assert.equal(await page.getByText("Highlight differences", { exact: true }).count(), 0);
    const boxes = await page.locator(".plan-option").evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON()));
    if (width > 860) assert.equal(new Set(boxes.map(box => box.height)).size, 1);
    await noOverflow(page);
    await page.screenshot({ path: path.join(output, "wallet-plans-" + width + ".png"), fullPage: true });
    // The self-service invoice-request form is now only reachable through
    // Basic -- exercise it there (a large top-up still routes to invoice).
    await page.getByRole("button", { name: "Buy credit", exact: true }).click();
    await page.getByRole("heading", { name: "Buy API credit" }).waitFor();
    await page.getByLabel("Credit amount (GBP)").fill("5000");
    await noOverflow(page);
    await page.screenshot({ path: path.join(output, "wallet-invoice-" + width + ".png"), fullPage: true });
    await page.getByRole("button", { name: "Request invoice", exact: true }).click();
    await page.getByRole("heading", { name: "Invoice requested" }).waitFor();
    assert.equal(purchases.length, 1);
    await page.reload();
    await page.getByRole("heading", { name: "Invoice requested" }).waitFor();
    assert.equal(purchases.length, 1);
    await page.close();
  }
  for (const tier of ["basic", "growth", "enterprise"]) {
    const { page } = await pageFor(390, tier);
    await page.goto(base + "/plans?fixture=wallet-" + tier);
    await page.getByText("Current pricing", { exact: true }).waitFor();
    if (tier === "enterprise") {
      assert.equal(await page.getByRole("button", { name: "Available after Enterprise ends" }).isDisabled(), true);
      await page.goto(base + "/credit?package=growth");
      await page.getByRole("heading", { name: "Your Enterprise pricing is still active" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Request invoice" }).count(), 0);
    } else {
      // The active plan's button shows its status; its actions sit underneath.
      assert.equal(await page.getByRole("status").filter({ hasText: "Current plan" }).count(), 1);
      if (tier === "basic") await page.getByRole("link", { name: "Buy more credit", exact: true }).click();
      else await page.getByRole("button", { name: "Buy credit", exact: true }).click();
      await page.getByRole("heading", { name: "Buy API credit" }).waitFor();
      assert.equal(await page.getByLabel("Credit amount (GBP)").inputValue(), "50");
    }
    await noOverflow(page);
    await page.close();
  }
  for (const kind of ["growth", "enterprise"]) {
    for (const width of [1280, 390, 320]) {
      const { page, requests, purchases } = await pageFor(width);
      await page.goto(base + `/credit?package=${kind}&fixture=unprovisioned`);
      await page.getByRole("button", { name: "Continue to card payment", exact: true }).waitFor();
      assert.equal(await page.getByRole("radio", { name: "Card through Stripe", exact: true }).isChecked(), true);
      assert.equal(await page.getByLabel("Credit amount (GBP)").inputValue(), kind === "growth" ? "5000" : "12000");
      assert.equal(await page.getByLabel("Credit amount (GBP)").getAttribute("readonly"), "");
      await noOverflow(page);
      await page.screenshot({ path: path.join(output, `wallet-${kind}-card-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Continue to card payment", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "temporarily unavailable" }).waitFor();
      const original = requests[0];
      assert.equal(original.paymentMethod, "card");
      assert.equal(await page.getByRole("radio", { name: "Invoice from our team", exact: true }).isDisabled(), true);
      await page.reload();
      await page.getByRole("button", { name: "Resume this purchase", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "temporarily unavailable" }).waitFor();
      assert.deepEqual(requests[1], original);
      assert.equal(purchases.length, 1);
      await page.close();

      const invoice = await pageFor(width);
      await invoice.page.goto(base + `/credit?package=${kind}&payment=invoice&fixture=unprovisioned`);
      await invoice.page.getByRole("button", { name: "Request invoice", exact: true }).click();
      await invoice.page.getByRole("heading", { name: "Invoice requested" }).waitFor();
      assert.equal(invoice.requests[0].paymentMethod, "invoice");
      await noOverflow(invoice.page);
      await invoice.page.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log("Wallet UI passed: card-first packages, invoice alternative, saved checkout recovery, responsive pricing, tier guards and development banner.");
} finally { await browser.close(); }
