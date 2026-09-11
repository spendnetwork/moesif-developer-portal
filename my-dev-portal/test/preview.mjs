// Isolated preview only: no real auth, Stripe, Moesif or SN API requests.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { localUsageSummary, localSubscription } = require("../../my-dev-portal-api/services/localUsageSummary.js");
const root = fileURLToPath(new URL("..", import.meta.url));
const rates = { api_call_quantity: 26, records_returned: 13, aggregate_call_quantity: 46, attachment_list_quantity: 65, attachment_download_quantity: 65 };
const empty = { granted_gbp_pence: 0, remaining_gbp_pence: 0, spendable_gbp_pence: 0, expired_gbp_pence: 0, inactive_gbp_pence: 0 };
const plans = ["basic", "growth", "enterprise"].map(key => ({ id: `prod_${key}`, name: key, status: "active", metadata: { plan_key: key } }));

export function fixture(fixtureName) {
  const walletTier = fixtureName.startsWith("wallet-") ? fixtureName.slice(7) : null;
  const plan = walletTier || (fixtureName === "unprovisioned" ? null : fixtureName.startsWith("basic") ? "basic" : "development");
  const exhausted = fixtureName.includes("exhausted");
  const paused = fixtureName.includes("paused");
  const balance = { ...empty, granted_gbp_pence: 10010, remaining_gbp_pence: exhausted ? 0 : 9620, eligible_gbp_pence: exhausted ? 0 : 9620, spendable_gbp_pence: exhausted || paused ? 0 : 9620 };
  return { prepaid_enabled: true, plan_key: plan, subscription_id: plan ? `prepaid_${plan}` : null, debit_owner: plan ? "api" : null, currency: "GBP",
    wallet_enabled: Boolean(walletTier), has_activated_paid_plan: Boolean(walletTier),
    pricing_ends_at: walletTier && walletTier !== "basic" ? "2027-09-01T00:00:00Z" : null,
    paid_credit_expires_at: walletTier ? "2027-09-07T00:00:00Z" : null,
    balances: { development: plan === "development" ? balance : empty, commercial: plan === "basic" ? balance : empty, legacy: empty },
    historical_balances: { development: empty, commercial: empty, legacy: empty },
    usage: { cost_gbp_pence: exhausted ? 10010 : 390, from: "2026-09-01T00:00:00Z", to: "2026-09-07T12:00:00Z", measurements: { api_call_quantity: exhausted ? 100 : 10, records_returned: exhausted ? 570 : 10, aggregate_call_quantity: 0, attachment_list_quantity: 0, attachment_download_quantity: 0 }, cost_by_metric_gbp_pence: { api_call_quantity: exhausted ? 2600 : 260, records_returned: exhausted ? 7410 : 130, aggregate_call_quantity: 0, attachment_list_quantity: 0, attachment_download_quantity: 0 } },
    rate_card: rates, access_block_reason: !plan ? "billing_context_changed" : paused ? "access_paused" : exhausted ? "insufficient_credit" : null, as_of: "2026-09-07T12:00:00Z" };
}

const server = await createServer({
  configFile: false, root, plugins: [react(), {
    name: "isolated-portal-fixtures", enforce: "pre",
    transform(_code, id) {
      if (id.replaceAll("\\", "/").endsWith("/src/hooks/useAuthCombined.js")) return `
        const selected = new URLSearchParams(location.search).get('fixture');
        if (selected) sessionStorage.setItem('portal-fixture', selected);
        const fixture = sessionStorage.getItem('portal-fixture') || 'development-exhausted';
        localStorage.setItem('oo-portal-welcomed-auth0|fixture', 'true');
        export default function useAuthCombined() { return { isLoading: false, isAuthenticated: true, idToken: fixture, user: {sub:'auth0|fixture', email:'developer@example.test'}, userEmail:'developer@example.test' }; }
      `;
    },
    configureServer(vite) {
      vite.middlewares.use('/qa-api', (req, res) => {
        const name = String(req.headers.authorization || '').replace('Bearer ', '') || 'development-exhausted';
        const snapshot = fixture(name);
        const path = req.url.split('?')[0];
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') { res.statusCode = 403; return res.end(JSON.stringify({ message: 'Payments and mutations disabled in local preview' })); }
        const result = {
          '/plans': { hits: plans }, '/plan-change': null,
          '/portal-context': { current_plan_key: snapshot.plan_key, current_subscription_id: snapshot.subscription_id, billing_status: snapshot.plan_key ? 'active' : null, debit_owner: snapshot.debit_owner, access_paused: name.includes('paused'), access_block_reason: snapshot.access_block_reason, wallet_enabled: snapshot.wallet_enabled, has_activated_paid_plan: snapshot.has_activated_paid_plan },
          '/wallet/purchases': { purchases: [] },
          '/subscriptions': snapshot.plan_key ? [localSubscription(snapshot)] : [], '/usage-summary': localUsageSummary(snapshot) || { hasSubscription: false },
          '/api-keys': { has_active_subscription: true, current_plan_key: snapshot.plan_key, active_count: 1, max_active_keys: 2,
            keys: [{ id: 1, name: 'Integration key', key_prefix: 'fixture_key_prefix', description: 'Development integration', created_at: '2026-09-01T00:00:00Z', age_days: 6, rotation_status: 'current' }] },
        };
        if (path === '/embed-charts') return setTimeout(() => { res.statusCode = 503; res.end(JSON.stringify({ message: 'Fixture chart unavailable' })); }, 12000);
        if (!(path in result)) { res.statusCode = 404; return res.end('{}'); }
        res.end(JSON.stringify(result[path]));
      });
    },
  }],
  resolve: { alias: { '@auth0/auth0-react': fileURLToPath(new URL('./auth0-fixture.jsx', import.meta.url)) } },
  define: { 'import.meta.env.REACT_APP_DEV_PORTAL_API_SERVER': JSON.stringify('/qa-api'), 'import.meta.env.REACT_APP_MOESIF_PUBLISHABLE_APPLICATION_ID': 'undefined' },
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
});
await server.listen();
server.printUrls();
