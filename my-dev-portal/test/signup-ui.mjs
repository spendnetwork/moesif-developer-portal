// Isolated Auth0 stub: never sends authentication or billing requests.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = createRequire(import.meta.url)("playwright");
const output = process.env.PORTAL_QA_OUTPUT;
const server = await createServer({
  configFile: false,
  plugins: [{
    name: "signup-auth-fixture",
    enforce: "pre",
    resolveId(id) { if (id === "@auth0/auth0-react") return "\0signup-auth"; },
    load(id) {
      if (id !== "\0signup-auth") return;
      return `import { useState, useEffect } from 'react';
        const loginWithRedirect = async options => {
          window.authCalls.push(options);
          if (window.rejectAuth) throw new Error('private diagnostic');
          return new Promise(() => {});
        };
        export function useAuth0() {
          const [loading, setLoading] = useState(window.authLoading);
          useEffect(() => {
            const ready = () => setLoading(false);
            window.addEventListener('auth-ready', ready);
            return () => window.removeEventListener('auth-ready', ready);
          }, []);
          return { isLoading: loading, isAuthenticated: window.authenticated, loginWithRedirect };
        }`;
    },
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/main.jsx')) return;
      return `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { BrowserRouter, Routes, Route } from 'react-router-dom';
        import Signup from './components/pages/signup/Signup';
        import './main.css';
        import './styles/styles.scss';
        createRoot(document.getElementById('root')).render(<React.StrictMode>
          <BrowserRouter><Routes><Route path='/signup' element={<Signup />} />
          <Route path='/dashboard' element={<h1>Dashboard</h1>} /></Routes></BrowserRouter>
        </React.StrictMode>);`;
    },
  }, react()],
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const base = server.resolvedUrls.local[0];
  for (const scenario of ["loading", "authenticated", "failure"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue() : route.abort());
    await page.addInitScript(scenario => {
      window.authCalls = [];
      window.authLoading = scenario === "loading";
      window.authenticated = scenario === "authenticated";
      window.rejectAuth = scenario === "failure";
    }, scenario);
    await page.goto(base + "signup?returnTo=https://untrusted.example");
    if (scenario === "authenticated") {
      await page.getByRole("heading", { name: "Dashboard" }).waitFor();
      assert.equal(await page.evaluate(() => authCalls.length), 0);
    } else {
      await page.getByRole("heading", { name: "Create your account" }).waitFor();
      if (scenario === "loading") {
        assert.equal(await page.evaluate(() => authCalls.length), 0);
        await page.evaluate(() => window.dispatchEvent(new Event("auth-ready")));
      }
      await page.waitForFunction(() => authCalls.length === 1);
      const options = await page.evaluate(() => authCalls[0]);
      assert.equal(options.authorizationParams.screen_hint, "signup");
      assert.equal(options.appState.returnTo, "/welcome");
      if (scenario === "failure") {
        await page.getByRole("alert").waitFor();
        assert.equal((await page.locator("body").innerText()).includes("private diagnostic"), false);
        await page.getByRole("button", { name: "Try again" }).click();
        await page.getByRole("alert").waitFor();
        assert.equal(await page.evaluate(() => authCalls.length), 2);
      }
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 800 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await page.locator(".signup-entry__logo").evaluate(img => img.complete && img.naturalWidth > 0), true);
        if (output) {
          await mkdir(output, { recursive: true });
          await page.screenshot({ path: path.join(output, `signup-${scenario}-${width}.png`), fullPage: true });
        }
      }
      if (scenario === "failure") {
        await page.getByRole("button", { name: "Already have an account? Sign in" }).click();
        await page.getByRole("alert").waitFor();
        const calls = await page.evaluate(() => authCalls);
        assert.equal(calls.length, 3);
        assert.equal(calls[2].authorizationParams.screen_hint, undefined);
        assert.equal(calls[2].appState.returnTo, "/dashboard");
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Signup browser checks passed: loading, redirect, existing session, retry, sign-in, mobile.");
} finally {
  await browser?.close();
  await server.close();
}
