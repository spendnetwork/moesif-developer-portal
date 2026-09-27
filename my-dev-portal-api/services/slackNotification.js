"use strict";

const escape = value => String(value ?? "Not available").slice(0, 500)
  .replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));

function adminAction(organizationId, env) {
  if (!env.ADMIN_PORTAL_BASE_URL) return null;
  let base;
  try { base = new URL(env.ADMIN_PORTAL_BASE_URL); } catch { throw new Error("InvalidAdminPortalUrl"); }
  const local = env.NODE_ENV !== "production" && base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname);
  if ((!local && base.protocol !== "https:") || base.username || base.password || base.search || base.hash) {
    throw new Error("InvalidAdminPortalUrl");
  }
  const hasCustomer = /^\d+$/.test(String(organizationId)) && Number(organizationId) > 0;
  const path = hasCustomer ? `/customers/${organizationId}` : "/customers/invitations";
  return { type: "actions", elements: [{ type: "button", style: "primary",
    text: { type: "plain_text", text: hasCustomer ? "View customer in Admin Portal" : "View invitations in Admin Portal" },
    url: `${base.href.replace(/\/$/, "")}${path}` }] };
}

function slackNotification({ title, severity = "Information", fields, notes = [], organizationId }, env = process.env) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: title.slice(0, 150) } },
    { type: "context", elements: [{ type: "plain_text", text: `Severity: ${severity}` }] },
  ];
  // Slack permits at most ten fields in each section.
  for (let start = 0; start < fields.length; start += 10) {
    blocks.push({ type: "section", fields: fields.slice(start, start + 10).map(([label, value]) => ({
      type: "mrkdwn", verbatim: true, text: `*${label}:*\n${escape(value)}`,
    })) });
  }
  for (const note of notes.filter(Boolean)) {
    blocks.push({ type: "context", elements: [{ type: "plain_text", text: String(note).slice(0, 2000) }] });
  }
  const action = adminAction(organizationId, env);
  if (action) blocks.push(action);
  return { text: `${escape(title)} (${escape(severity)}) - ${fields.slice(0, 2).map(([label, value]) => `${label}: ${escape(value)}`).join("; ")}`,
    link_names: false, parse: "none", blocks };
}

module.exports = { slackNotification, adminAction };
