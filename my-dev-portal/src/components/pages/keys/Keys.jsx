import React, { useCallback, useEffect, useState } from "react";
import Modal from "react-modal";
import SVG from "react-inlinesvg";
import copy from "copy-to-clipboard";

import { PageLayout } from "../../page-layout";
import { PageLoader } from "../../page-loader";
import apiKeyIcon from "../../../images/icons/api-key.svg";
import copyIcon from "../../../images/icons/copy.svg";
import successIcon from "../../../images/icons/success.svg";
import useAuthCombined from "../../../hooks/useAuthCombined";

const modalStyles = {
  content: {
    top: "50%",
    left: "50%",
    right: "auto",
    bottom: "auto",
    width: "min(56rem, calc(100vw - 3.2rem))",
    maxHeight: "calc(100vh - 4rem)",
    padding: 0,
    overflow: "auto",
    transform: "translate(-50%, -50%)",
  },
  overlay: { backgroundColor: "rgba(15, 30, 25, 0.5)", zIndex: 20 },
};

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatRelativeDate(value) {
  if (!value) return "Not used yet";
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));
  if (days === 0) return "Today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

async function apiRequest(path, idToken, options = {}) {
  const response = await fetch(
    `${import.meta.env.REACT_APP_DEV_PORTAL_API_SERVER}${path}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        ...options.headers,
      },
    }
  );
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(body?.message || "API key request failed");
  }
  return body;
}

function RotationNotice({ apiKey }) {
  if (apiKey.rotation_status === "current") return null;
  const recommended = apiKey.rotation_status === "recommended";
  return (
    <div className={`key-age-notice key-age-notice--${apiKey.rotation_status}`}>
      <strong>{recommended ? "Rotation recommended" : "Rotation reminder"}</strong>
      <span>
        {recommended
          ? `This key is ${apiKey.age_days} days old. Rotate it now to maintain good security hygiene.`
          : `This key is ${apiKey.age_days} days old. Plan to rotate it before it reaches 90 days.`}
      </span>
    </div>
  );
}

function Keys() {
  const { isLoading: authLoading, idToken } = useAuthCombined();
  const [keys, setKeys] = useState([]);
  const [maxKeys, setMaxKeys] = useState(2);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modal, setModal] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [revealedKey, setRevealedKey] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [actionMenuId, setActionMenuId] = useState(null);

  Modal.setAppElement("#root");

  const loadKeys = useCallback(async () => {
    if (!idToken) return;
    setLoading(true);
    setError("");
    try {
      const result = await apiRequest("/api-keys", idToken);
      setKeys(result.keys || []);
      setMaxKeys(result.max_active_keys || 2);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [idToken]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  function openCreateModal() {
    setName("");
    setDescription("");
    setError("");
    setModal("create");
  }

  function closeModal() {
    if (busy) return;
    setModal(null);
    setSelectedKey(null);
    setRevealedKey("");
    setIsCopied(false);
  }

  async function createKey(event) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest("/api-keys", idToken, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
        }),
      });
      setRevealedKey(result.api_key);
      setModal("reveal");
      await loadKeys();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function rotateKey() {
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest(
        `/api-keys/${selectedKey.id}/rotate`,
        idToken,
        { method: "POST" }
      );
      setRevealedKey(result.api_key);
      setModal("reveal");
      await loadKeys();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey() {
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api-keys/${selectedKey.id}`, idToken, {
        method: "DELETE",
      });
      setBusy(false);
      setModal(null);
      setSelectedKey(null);
      await loadKeys();
    } catch (requestError) {
      setError(requestError.message);
      setBusy(false);
    }
  }

  function openAction(action, apiKey) {
    setActionMenuId(null);
    setSelectedKey(apiKey);
    setError("");
    setModal(action);
  }

  function copyRevealedKey() {
    if (copy(revealedKey)) {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 3000);
    }
  }

  if (authLoading || loading) return <PageLoader />;

  const atLimit = keys.length >= maxKeys;

  return (
    <PageLayout>
      <section className="keys-page">
        <header className="keys-header">
          <div>
            <p className="page-eyebrow">Access</p>
            <h1>API keys <span>({keys.length})</span></h1>
            <p>Use API keys to make programmatic calls to Open Opportunities. You can have a maximum of two active keys at a time.</p>
          </div>
          <button
            className="button button--primary keys-create-button"
            onClick={openCreateModal}
            disabled={atLimit}
          >
            Create API key
          </button>
        </header>

        <div className="keys-summary">
          <span>{keys.length} of {maxKeys} active keys</span>
          {atLimit && <span>Revoke a key before creating another.</span>}
        </div>

        {error && <div className="keys-error" role="alert">{error}</div>}

        {keys.length === 0 ? (
          <div className="keys-empty">
            <SVG src={apiKeyIcon} />
            <h2>No API keys</h2>
            <p>Create a key to authenticate requests to the API.</p>
            <button className="button button--primary" onClick={openCreateModal}>
              Create API key
            </button>
          </div>
        ) : (
          <div className="keys-list">
            {keys.map((apiKey) => (
              <article className="key-card" key={apiKey.id}>
                <div className="key-card-main">
                  <div className="key-card-content">
                    <div className="key-card-heading">
                      <h2>{apiKey.name}</h2>
                      <div className="key-actions-menu">
                        <button
                          className="button button--outline-secondary key-actions-trigger"
                          onClick={() => setActionMenuId(actionMenuId === apiKey.id ? null : apiKey.id)}
                          aria-expanded={actionMenuId === apiKey.id}
                          aria-haspopup="menu"
                        >
                          Actions <span aria-hidden="true">?</span>
                        </button>
                        {actionMenuId === apiKey.id && (
                          <div className="key-actions-popover" role="menu">
                            <button role="menuitem" onClick={() => openAction("rotate", apiKey)}>Rotate key</button>
                            <button role="menuitem" className="key-actions-danger" onClick={() => openAction("revoke", apiKey)}>Revoke key</button>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="key-details-grid">
                      <dl>
                        <div><dt>Description</dt><dd>{apiKey.description || "No description"}</dd></div>
                        <div><dt>Last used</dt><dd>{formatRelativeDate(apiKey.last_used_at)}</dd></div>
                      </dl>
                      <dl>
                        <div><dt>Status</dt><dd><span className="key-active-indicator" aria-hidden="true">?</span> Active</dd></div>
                        <div><dt>Created</dt><dd>{formatDate(apiKey.created_at)}</dd></div>
                      </dl>
                    </div>
                  </div>
                </div>
                <RotationNotice apiKey={apiKey} />
              </article>
            ))}
          </div>
        )}
      </section>

      <Modal isOpen={Boolean(modal)} onRequestClose={closeModal} style={modalStyles} contentLabel="API key management">
        {modal === "create" && (
          <form onSubmit={createKey} className="key-modal">
            <div className="key-modal-header"><h2>Create API key</h2><p>The secret is shown once after creation.</p></div>
            <div className="key-modal-body">
              {error && <div className="keys-error" role="alert">{error}</div>}
              <label htmlFor="key-name">Name</label>
              <input id="key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="Production integration" />
              <label htmlFor="key-description">Description <span>(optional)</span></label>
              <textarea id="key-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={4} placeholder="Used by the production data pipeline" />
            </div>
            <div className="key-modal-actions"><button type="button" className="button button--outline-secondary" onClick={closeModal}>Cancel</button><button className="button button--primary" disabled={busy || !name.trim()}>{busy ? "Creating..." : "Create key"}</button></div>
          </form>
        )}

        {modal === "reveal" && (
          <div className="key-modal">
            <div className="key-modal-header"><h2>API key created</h2><p>Store this key securely. You will not be able to view it again.</p></div>
            <div className="key-modal-body">
              <label>Your API key</label>
              <div className="api-key-container"><span className="api-key-presentation"><code className="api-key">{revealedKey}</code></span><button className="copy-button" onClick={copyRevealedKey} title="Copy API key" aria-label="Copy API key"><SVG className="icon" src={isCopied ? successIcon : copyIcon} /></button></div>
            </div>
            <div className="key-modal-actions"><button className="button button--primary" onClick={closeModal}>Done</button></div>
          </div>
        )}

        {modal === "rotate" && (
          <div className="key-modal">
            <div className="key-modal-header"><h2>Rotate {selectedKey?.name}?</h2><p>The current key will stop working immediately.</p></div>
            <div className="key-modal-body">{error && <div className="keys-error" role="alert">{error}</div>}<p>Update every service using this credential as soon as the replacement is created.</p></div>
            <div className="key-modal-actions"><button className="button button--outline-secondary" onClick={closeModal}>Cancel</button><button className="button button--primary" onClick={rotateKey} disabled={busy}>{busy ? "Rotating..." : "Rotate key"}</button></div>
          </div>
        )}

        {modal === "revoke" && (
          <div className="key-modal">
            <div className="key-modal-header"><h2>Revoke {selectedKey?.name}?</h2><p>Requests using this key will fail immediately.</p></div>
            <div className="key-modal-body">{error && <div className="keys-error" role="alert">{error}</div>}<p>This action cannot be undone.</p></div>
            <div className="key-modal-actions"><button className="button button--outline-secondary" onClick={closeModal}>Cancel</button><button className="button key-revoke-button" onClick={revokeKey} disabled={busy}>{busy ? "Revoking..." : "Revoke key"}</button></div>
          </div>
        )}
      </Modal>
    </PageLayout>
  );
}

export default Keys;
