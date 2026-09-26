"use strict";
// Run from the backend directory with its normal service credentials.
require("dotenv").config();
const { invitationRequest: request } = require("../services/snApiProvisioning");
const base = "/api/v3/developer-portal/notification-deliveries";

async function main(args) {
  const [command, identity, requestId, actor] = args;
  if (command === "health" && args.length === 1) return request(`${base}/health`, { method: "GET" });
  if (command === "failed" && args.length === 1) return request(`${base}/failed`, { method: "GET" });
  if (command === "retry" && args.length === 4 && /^[0-9a-f-]{36}$/i.test(requestId) && actor && !/[\r\n]/.test(actor)) {
    return request(`${base}/${encodeURIComponent(identity)}/retry`, { method: "POST", body: { request_id: requestId, actor } });
  }
  throw Object.assign(new Error("Usage: node scripts/notification-operations.js health | failed | retry <notification-id> <request-uuid> <staff-email>"), { usage: true });
}

if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(error.usage ? error.message : "Notification operation failed. Check service configuration and backend logs; reuse the request UUID when retrying.");
  process.exitCode = 1;
});
module.exports = { main };
