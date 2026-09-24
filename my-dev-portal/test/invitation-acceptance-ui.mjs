// Isolated browser regression: no real authentication, emails or credit grants.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = createRequire(import.meta.url)("playwright");
const token = "203777ef-24b6-4e49-b0e9-1c7a2c40210f." + "a".repeat(43);
const server = await createServer({
  configFile: false,
  plugins: [{
    name: "invitation-fixture", enforce: "pre",
    resolveId(id) { if (id === "@auth0/auth0-react") return "\0invitation-auth"; },
    load(id) {
      if (id === "\0invitation-auth") return `
        const getIdTokenClaims = async () => ({__raw:'test-token'});
        const loginWithRedirect = async options => {window.authCalls.push(options);};
        export const useAuth0 = () => ({isLoading:false,isAuthenticated:window.authenticated,getIdTokenClaims,loginWithRedirect});`;
    },
    transform(code, id) {
      const file = id.replaceAll("\\", "/");
      if (file.endsWith("/src/hooks/useAuthCombined.js")) return `export default () => ({idToken:'test-token'});`;
      if (!file.endsWith("/src/main.jsx")) return;
      return `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {BrowserRouter,Routes,Route} from 'react-router-dom';
        import Signup from './components/pages/signup/Signup';
        import AcceptInvitation from './components/pages/signup/AcceptInvitation';
        import InvitationNotice from './components/invitation-notice';
        import {captureInvitation} from './lib/invitation-session';
        captureInvitation();
        createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><Routes>
          <Route path='/signup' element={<Signup/>}/>
          <Route path='/invitation' element={<AcceptInvitation/>}/>
          <Route path='/dashboard' element={<><h1>Dashboard</h1><InvitationNotice/></>}/>
        </Routes></BrowserRouter></React.StrictMode>);`;
    },
  }, react()],
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const base = server.resolvedUrls.local[0];
  for (const scenario of ["signup", "accepted", "retry", "wrong-email", "unverified", "unconfirmed"]) {
    const page = await browser.newPage();
    const errors = [];
    let attempts = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ scenario, token }) => {
      window.authCalls = [];
      window.authenticated = scenario !== "signup";
      sessionStorage.setItem("openopps.pending-invitation.v1", JSON.stringify({ token, savedAt: Date.now() }));
    }, { scenario, token });
    await page.route("**/*", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/invitations/accept")) {
        attempts++;
        assert.equal(route.request().postDataJSON().token, token);
        if (scenario === "wrong-email" || scenario === "unverified" || (scenario === "retry" && attempts === 1)) {
          return route.fulfill({ status: scenario === "retry" ? 503 : 403, json: {
            message: scenario === "wrong-email" ? "Sign in with the email address that received this invitation." :
              scenario === "unverified" ? "Verify your email address, then sign in again to accept the invitation." : "Please try again.",
          } });
        }
        return route.fulfill({ json: scenario === "unconfirmed" ? { id: "test", status: "pending" } :
          { id: "test", status: "accepted", credit_receipt: { expires_at: "2027-01-01T00:00:00Z" } } });
      }
      if (path.endsWith("/invitation-notifications")) return route.fulfill({ json: { items: [
        { id: "test", amount_gbp_pence: 50000, credit_receipt: { expires_at: "2027-01-01T00:00:00Z" } },
      ] } });
      if (new URL(route.request().url()).hostname !== "127.0.0.1") return route.abort();
      return route.continue();
    });
    await page.goto(base + "signup#invitation=" + token);
    if (scenario === "signup") {
      await page.waitForFunction(() => window.authCalls.length === 1);
      const options = await page.evaluate(() => window.authCalls[0]);
      assert.equal(options.authorizationParams.screen_hint, "signup");
      assert.equal(options.appState.returnTo, "/invitation");
      assert.equal(attempts, 0);
      assert.equal(new URL(page.url()).hash, "");
    } else {
      if (scenario !== "accepted") {
        await page.getByRole("alert").waitFor();
        assert.equal(attempts, 1);
        assert.ok(await page.evaluate(() => sessionStorage.getItem("openopps.pending-invitation.v1")));
      }
      if (scenario === "retry") await page.getByRole("button", { name: "Try again", exact: true }).click();
      if (["accepted", "retry"].includes(scenario)) {
        await page.getByRole("heading", { name: "Dashboard" }).waitFor();
        await page.getByRole("status").filter({ hasText: "£500.00 development credit granted" }).waitFor();
        assert.equal(attempts, scenario === "retry" ? 2 : 1);
        assert.equal(await page.evaluate(() => sessionStorage.getItem("openopps.pending-invitation.v1")), null);
      } else {
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 800 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Invitation browser checks passed: signup, automatic acceptance, notification, safe retry, identity errors, unconfirmed response.");
} finally {
  await browser?.close();
  await server.close();
}
