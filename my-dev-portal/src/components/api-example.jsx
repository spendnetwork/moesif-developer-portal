import React, { useState } from "react";

export const API_DOCS_URL =
  "https://docs.openopps.com/s/1e0ae5a0-98cd-4814-9a10-08fef3ce3c4b/doc/api-v30-documentation-v2-summary-records-P5dS1Xsr1g";

const ENDPOINT = "https://api.spendnetwork.cloud/api/v3/notices_summary/read_summary_records";

// The same request in each language openopps.com/api offers.
const REQUESTS = {
  cURL: `curl -X POST \\
  ${ENDPOINT} \\
  -H "X-API-Key: $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"search_term__is": "Cisco switches", "limit": 10}'`,
  Python: `import requests

response = requests.post(
    "${ENDPOINT}",
    headers={"X-API-Key": API_KEY},
    json={"search_term__is": "Cisco switches", "limit": 10},
)
print(response.json()["result_count"])`,
  JavaScript: `const response = await fetch(
  "${ENDPOINT}",
  {
    method: "POST",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ search_term__is: "Cisco switches", limit: 10 }),
  },
);
const { result_count, results } = await response.json();`,
};

// The shape of what comes back, trimmed. Field names are the API's own.
const RESPONSE = `{
  "result_count": 10000,
  "results": [
    {
      "tender_title": "Cisco Switch",
      "buyer_name": "Saskatchewan Crop Insurance Corporation",
      "buyer_address_country_name": "Canada",
      "closing_date": "2026-07-10",
      "source": "td_saskatchewan_gov_ca"
    },
    …
  ]
}`;

const TOKEN = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\b(?:curl|import|const|await|print|requests|fetch)\b|\b\d+\b|…)/g;

// A small highlighter: strings, keys (a string followed by a colon), numbers
// and a few keywords. Enough to read, nothing to maintain.
function highlight(source) {
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    const [token] = match;
    if (match.index > last) parts.push(source.slice(last, match.index));
    const isString = /^["'`]/.test(token);
    const isKey = isString && /^\s*:/.test(source.slice(match.index + token.length));
    const kind = token === "…" ? "t-muted" : isKey ? "t-key" : isString ? "t-str" : /^\d/.test(token) ? "t-num" : "t-cmd";
    parts.push(<span key={match.index} className={kind}>{token}</span>);
    last = match.index + token.length;
  }
  parts.push(source.slice(last));
  return parts;
}

export function ApiExample({ showResponse = true, label = "Example API request and response" }) {
  const [language, setLanguage] = useState("cURL");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(REQUESTS[language]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <figure className="pp-code" aria-label={label}>
      <div className="pp-code__bar">
        <div className="pp-code__tabs" role="tablist" aria-label="Request language">
          {Object.keys(REQUESTS).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={language === name}
              className="pp-code__tab" onClick={() => { setLanguage(name); setCopied(false); }}>
              {name}
            </button>
          ))}
        </div>
        <button type="button" className="pp-code__copy" onClick={copy} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="pp-code__block" role="tabpanel"><code>{highlight(REQUESTS[language])}</code></pre>
      {showResponse && (
        <>
          <div className="pp-code__divider"><span>Response</span><span className="pp-code__status">200 OK</span></div>
          <pre className="pp-code__block pp-code__block--response"><code>{highlight(RESPONSE)}</code></pre>
        </>
      )}
    </figure>
  );
}
