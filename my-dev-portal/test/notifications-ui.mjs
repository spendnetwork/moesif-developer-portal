// Isolated UI checks. No real login, email, Slack or customer data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = createRequire(import.meta.url)("playwright");
const server = await createServer({ configFile: false,
  define: { "import.meta.env.REACT_APP_DEV_PORTAL_API_SERVER": JSON.stringify("/api") },
  plugins: [{ name: "notification-fixture", enforce: "pre",
    resolveId(id) { if (id === "@auth0/auth0-react") return "\0notification-auth"; },
    load(id) { if (id === "\0notification-auth") return `export const useAuth0 = () => ({isLoading:false,isAuthenticated:true,user:{name:'Test Admin',email:'test@example.com'},logout:()=>{},loginWithRedirect:()=>{}});`; },
    transform(code, id) {
      const file = id.replaceAll("\\", "/");
      if (file.endsWith("/src/hooks/useAuthCombined.js")) return `export default () => ({idToken:'test-token'});`;
      if (file.endsWith("/src/main.jsx")) return `import React from 'react';import {createRoot} from 'react-dom/client';
        import {BrowserRouter} from 'react-router-dom';import Notifications from './components/pages/notifications/Notifications';
        import './main.css';import './styles/styles.scss';
        createRoot(document.getElementById('root')).render(<BrowserRouter><Notifications/></BrowserRouter>);`;
    },
  }, react()], server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const output = process.env.NOTIFICATION_UI_OUTPUT || path.resolve("../../sn-api/.codex-tmp/notifications-ui");
  await mkdir(output, { recursive: true });
  for (const width of [1280, 820, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    let mode = "normal", read = false;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/notifications") {
        if (mode === "error") return route.fulfill({ status: 503, json: { message: "Unavailable" } });
        return route.fulfill({ json: mode === "empty" ? [] : [
          { id: "payment_confirmed:1", heading: "Payment confirmed: GBP 5,000 added to Example Company", message: "GBP 5,000 credit was confirmed. Growth pricing is active until 26 September 2027. Review your current balance in Billing.", created_at: "2026-09-26T10:00:00Z", read_at: read ? "2026-09-26T11:00:00Z" : null },
          { id: "credit:2", heading: "Your API credit is running low", message: "Your company has GBP 1,000 purchased credit remaining. Check Billing to review your balance.", created_at: "2026-09-25T10:00:00Z", read_at: "2026-09-25T11:00:00Z" },
        ] });
      }
      if (url.pathname.endsWith("/read") && url.pathname.startsWith("/api/notifications/")) {
        assert.equal(route.request().method(), "POST"); read = true; return route.fulfill({ json: { ok: true } });
      }
      if (url.hostname !== "127.0.0.1") return route.abort();
      return route.continue();
    });
    await page.goto(server.resolvedUrls.local[0] + "notifications");
    await page.getByRole("heading", { name: "Payment confirmed: GBP 5,000 added to Example Company" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `notifications-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: /^Mark as read:/ }).click();
    await page.getByRole("button", { name: /^Mark as read:/ }).waitFor({ state: "detached" });
    mode = "error";
    await page.getByRole("button", { name: "Refresh notifications" }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("heading", { name: /Payment confirmed/ }).count(), 1);
    mode = "empty";
    await page.getByRole("button", { name: "Refresh notifications" }).click();
    await page.getByRole("heading", { name: "You are up to date" }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`PASS notifications UI: desktop/tablet/mobile, read action, retained data on refresh failure, empty state; screenshots in ${output}`);
} finally { await browser?.close(); await server.close(); }
