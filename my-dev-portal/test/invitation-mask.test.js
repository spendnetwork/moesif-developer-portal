import test from "node:test";
import assert from "node:assert/strict";
import { maskInvitationHeader } from "../src/lib/invitation-session.js";

test("Moesif events never carry the invitation token header", () => {
  const event = { request: { uri: "https://portal.example/portal-context", headers: { "X-Pending-Invitation": "secret", Accept: "application/json" } } };
  assert.equal(maskInvitationHeader(event), event);
  assert.deepEqual(event.request.headers, { Accept: "application/json" });
  const lower = { request: { headers: { "x-pending-invitation": "secret" } } };
  assert.deepEqual(maskInvitationHeader(lower).request.headers, {});
  assert.deepEqual(maskInvitationHeader({ response: {} }), { response: {} });
});
