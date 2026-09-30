const test = require("node:test");
const assert = require("node:assert/strict");
const { renderJob, accountSlack } = require("../services/customerNotificationDelivery");
const { renderEmail } = require("../services/notificationEmail");
const { installWalletRoutes } = require("../services/walletRoutes");

const job = { id: "purchase_cancelled:x", kind: "purchase_cancelled", company: "Acme", organization_id: 48,
  payload: { amount_gbp_pence: 500000, purchase_kind: "growth", cancelled_by: "owner@acme.com" } };

test("the customer is told their invoice request was cancelled and nothing else changed", () => {
  const rendered = renderEmail("purchase_cancelled", renderJob(job, "https://portal.example.com"));
  assert.match(rendered.subject + rendered.text, /Invoice request cancelled/);
  assert.match(rendered.text, /£5,000\.00/);
  assert.match(rendered.text, /no invoice will be issued/);
  assert.match(rendered.text, /https:\/\/portal\.example\.com\/plans/);
});

test("the team's Slack alert names the package, amount and who cancelled", () => {
  const text = JSON.stringify(accountSlack(job, "https://portal.example.com", {}));
  assert.match(text, /Invoice request cancelled by customer/);
  assert.match(text, /Growth/);
  assert.match(text, /£5,000\.00/);
  assert.match(text, /owner@acme\.com/);
});

test("the cancel route checks the request id and passes the caller's own identity", async () => {
  const routes = {};
  const app = { get() {}, post(path, ...handlers) { routes[path] = handlers.at(-1); } };
  const calls = [], invalidated = [];
  installWalletRoutes(app, { auth: (_q, _s, next) => next(), jsonParser: (_q, _s, next) => next(), serviceTokenMatches: () => false,
    invalidate: sub => invalidated.push(sub), deps: { cancelWalletPurchase: async (user, id) => { calls.push([user.sub, id]); return { status: "cancelled" }; } } });
  const handler = routes["/wallet/purchases/:id/cancel"];
  const response = () => { const res = { code: 200, body: null, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } }; return res; };
  const id = "3f0c1a5e-8f0e-4d8b-9a55-0d1d2a3b4c5d";
  const ok = response();
  await handler({ user: { sub: "auth0|owner" }, params: { id } }, ok);
  assert.deepEqual([ok.code, ok.body, calls, invalidated], [200, { status: "cancelled" }, [["auth0|owner", id]], ["auth0|owner"]]);
  const bad = response();
  await handler({ user: { sub: "auth0|owner" }, params: { id: "../admin" } }, bad);
  assert.equal(bad.code, 422);
  assert.equal(calls.length, 1);
});
