import test from "node:test";
import assert from "node:assert/strict";
import { captureInvitation, pendingInvitation, clearInvitation, skipInvitationAnalytics } from "../src/lib/invitation-session.js";

test("invitation tokens stay out of browser analytics", () => {
  for (const uri of ["https://api.example.com/invitations/accept", "/invitations/preview", "/admin/invitations", "/invitation-notifications"]) {
    assert.equal(skipInvitationAnalytics({ request: { uri } }), true);
  }
  assert.equal(skipInvitationAnalytics({ request: { uri: "/usage-summary" } }), false);
});

test("signup captures its fragment before analytics, retains it for redirect, and rejects malformed storage", () => {
  const store = new Map();
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.sessionStorage;
  const token = "203777ef-24b6-4e49-b0e9-1c7a2c40210f." + "a".repeat(43);
  let replaced;
  globalThis.window = { location: { pathname: "/signup", search: "", hash: `#invitation=${token}` }, history: { replaceState: (...args) => { replaced = args[2]; } } };
  globalThis.sessionStorage = { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  try {
    captureInvitation();
    assert.equal(replaced, "/signup");
    assert.equal(pendingInvitation(), token);
    clearInvitation();
    assert.equal(pendingInvitation(), null);
    store.set("openopps.pending-invitation.v1", JSON.stringify({ token, savedAt: Date.now() - 8 * 86400000 }));
    assert.equal(pendingInvitation(), null);
    store.set("openopps.pending-invitation.v1", JSON.stringify({ token }));
    assert.equal(pendingInvitation(), null);
    globalThis.sessionStorage.setItem = () => { throw new Error("Storage unavailable"); };
    captureInvitation();
    assert.equal(window.__invitationCaptureFailed, true);
  } finally { globalThis.window = originalWindow; globalThis.sessionStorage = originalStorage; }
});
