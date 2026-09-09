import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "react-modal";
import copy from "copy-to-clipboard";
import useSWR from "swr";

import { PageLayout } from "../../page-layout";
import { PageLoader } from "../../page-loader";
import useAuthCombined from "../../../hooks/useAuthCombined";
import { apiRequest, authedFetcher } from "../../../lib/portal-api";

const C = {
  green: "#034737",
  mint: "#A9FF9B",
  head: "#23383A",
  body: "#23302C",
  muted: "#647873",
  line: "#DDE5E0",
  lineSoft: "#EEF2EF",
  page: "#F5F7F4",
  danger: "#8B2C21",
};

const modalStyles = {
  content: {
    top: "50%",
    left: "50%",
    right: "auto",
    bottom: "auto",
    width: "min(30rem, calc(100vw - 3.2rem))",
    maxHeight: "calc(100vh - 4rem)",
    padding: 0,
    border: "none",
    borderRadius: 14,
    overflow: "hidden",
    transform: "translate(-50%, -50%)",
    boxShadow: "0 20px 60px rgba(15,30,25,0.28)",
  },
  overlay: { backgroundColor: "rgba(15, 30, 25, 0.5)", zIndex: 20 },
};

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatRelativeDate(value) {
  if (!value) return "Not used yet";
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 86400000)
  );
  if (days === 0) return "Today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function statusPill(rotationStatus) {
  if (rotationStatus === "recommended") {
    return { label: "90+ days", color: "#725300", background: "#FFF1B8", border: "#EFDE96" };
  }
  if (rotationStatus === "warning") {
    return { label: "60+ days", color: "#725300", background: "#FFF1B8", border: "#EFDE96" };
  }
  return { label: "Active", color: "#17633C", background: "#E3F5E9", border: "#C4E7D2" };
}

function KeyCard({ apiKey, onRotate, onRevoke, onCopyPrefix, copiedId }) {
  const pill = statusPill(apiKey.rotation_status);
  const showWarning = apiKey.rotation_status !== "current";
  const prefix = apiKey.key_prefix
    ? `${apiKey.key_prefix.slice(0, 18)}…`
    : `Key ID ${apiKey.id}`;

  return (
    <div style={styles.card}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
        <div style={styles.keyIcon}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="1.5">
            <circle cx="8.5" cy="15.5" r="3.5" />
            <path d="M11 13L19 5M16.5 7.5l2 2M14.5 9.5l2 2" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 500, color: C.head }}>
              {apiKey.name}
            </span>
            <span
              style={{
                fontSize: 11.5,
                color: pill.color,
                background: pill.background,
                border: `1px solid ${pill.border}`,
                padding: "3px 9px",
                borderRadius: 999,
              }}
            >
              {pill.label}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
            <span style={styles.prefixChip}>{prefix}</span>
            <button
              type="button"
              onClick={() => onCopyPrefix(apiKey)}
              className="btn-chip"
              style={styles.copyBtn}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="9" y="9" width="11" height="11" rx="2.5" />
                <path d="M15 6.5A2.5 2.5 0 0 0 12.5 4H6.5A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15" />
              </svg>
              {copiedId === apiKey.id ? "Copied" : "Copy prefix"}
            </button>
          </div>

          {showWarning && (
            <div style={styles.warnBanner}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#725300" strokeWidth="1.6" style={{ flex: "none" }}>
                <path d="M12 4.5l8 14H4l8-14Z" />
                <path d="M12 10v3.5" />
                <circle cx="12" cy="16.2" r="0.7" fill="#725300" stroke="none" />
              </svg>
              <span style={{ fontSize: 13, color: "#725300" }}>
                This key is {apiKey.age_days} days old. Rotating regularly keeps
                your integration safe.
              </span>
            </div>
          )}

          <div style={styles.metaGrid}>
            <div style={styles.metaItem}>
              <span style={styles.metaLabel}>Description</span>
              <span style={styles.metaValue}>{apiKey.description || "—"}</span>
            </div>
            <div style={styles.metaItem}>
              <span style={styles.metaLabel}>Last used</span>
              <span style={styles.metaValue}>{formatRelativeDate(apiKey.last_used_at)}</span>
            </div>
            <div style={styles.metaItem}>
              <span style={styles.metaLabel}>Status</span>
              <span style={styles.metaValue}>Active</span>
            </div>
            <div style={styles.metaItem}>
              <span style={styles.metaLabel}>Created</span>
              <span style={styles.metaValue}>{formatDate(apiKey.created_at)}</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: "none" }}>
          <button
            type="button"
            onClick={() => onRotate(apiKey)}
            disabled={!onRotate}
            className={showWarning ? "btn-solid" : "btn-outline"}
            style={showWarning ? styles.rotateStrong : styles.rotateOutline}
          >
            Rotate
          </button>
          <button
            type="button"
            onClick={() => onRevoke(apiKey)}
            className="btn-danger-outline"
            style={styles.revokeBtn}
          >
            Revoke
          </button>
        </div>
      </div>
    </div>
  );
}

function Keys() {
  const { isLoading: authLoading, idToken } = useAuthCombined();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modal, setModal] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [revealedKey, setRevealedKey] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  Modal.setAppElement("#root");

  const keysKey = idToken ? ["/api-keys", idToken] : null;
  const {
    data: keysData,
    error: keysError,
    mutate: mutateKeys,
  } = useSWR(keysKey, authedFetcher);

  const keys = keysData?.keys || [];
  const maxKeys = keysData?.max_active_keys || 2;
  const notProvisioned = keysError?.status === 404;
  const listError =
    keysError && keysError.status !== 404 ? keysError.message : "";

  async function loadKeys() {
    await mutateKeys();
  }

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
    setSelectedKey(apiKey);
    setError("");
    setModal(action);
  }

  function copyPrefix(apiKey) {
    const value = apiKey.key_prefix || `Key ID ${apiKey.id}`;
    if (copy(value)) {
      setCopiedId(apiKey.id);
      setTimeout(() => setCopiedId(null), 2500);
    }
  }

  function copyRevealedKey() {
    if (copy(revealedKey)) {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 3000);
    }
  }

  const keysReady = !keysKey || keysData !== undefined || keysError;
  if (authLoading || !keysReady) {
    return (
      <PageLayout>
        <PageLoader />
      </PageLayout>
    );
  }

  const hasActiveSubscription = keysData?.has_active_subscription === true;
  const locked = notProvisioned || !hasActiveSubscription;
  const hardError = keysError && !notProvisioned;
  const atLimit = keys.length >= maxKeys;

  return (
    <PageLayout>
      <div style={styles.header}>
        <div>
          <div style={styles.eyebrow}>Access</div>
          <h1 style={styles.h1}>
            API keys{!hardError ? ` (${keys.length})` : ""}
          </h1>
          <p style={{ margin: 0, fontSize: 15, color: C.muted }}>
            Keys authenticate every request. Maximum two active keys.
          </p>
        </div>
        {!locked && !hardError && (
          <button
            type="button"
            onClick={openCreateModal}
            disabled={atLimit}
            className="btn-solid"
            style={{
              ...styles.primaryBtn,
              opacity: atLimit ? 0.5 : 1,
              cursor: atLimit ? "default" : "pointer",
            }}
          >
            Create API key
          </button>
        )}
      </div>

      {hardError && (
        <div style={styles.errorCard} role="alert">
          <div style={{ fontSize: 16, fontWeight: 500, color: C.head, marginBottom: 8 }}>
            We could not confirm your API access
          </div>
          <p style={{ margin: "0 0 16px", fontSize: 14, color: C.muted }}>
            {listError || "Please try again shortly."}
          </p>
          <button type="button" onClick={() => mutateKeys()} className="btn-solid" style={styles.primaryBtn}>
            Try again
          </button>
        </div>
      )}

      {!hardError && locked && (
        <div style={styles.lockedCard}>
          <div style={styles.lockedIcon}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.5">
              <rect x="5" y="11" width="14" height="9" rx="2.5" />
              <path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11" />
            </svg>
          </div>
          <div style={{ fontSize: 19, fontWeight: 500, color: C.head, marginBottom: 8 }}>
            Arrange API access
          </div>
          <p style={styles.lockedBody}>
            Contact <a href="mailto:welcome@openopps.com">welcome@openopps.com</a>{" "}
            for credit to build and test your integration, or discuss a Growth or
            Enterprise commitment, or choose Basic prepaid from £100.
            Existing keys and usage remain available.
          </p>
          <button type="button" onClick={() => navigate("/plans")} className="btn-solid" style={styles.primaryBtn}>
            View plans
          </button>
        </div>
      )}

      {!hardError && (!locked || keys.length > 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {error && (
            <div style={styles.inlineError} role="alert">{error}</div>
          )}
          {keys.length === 0 ? (
            <div style={styles.lockedCard}>
              <div style={styles.lockedIcon}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="1.5">
                  <circle cx="8.5" cy="15.5" r="3.5" />
                  <path d="M11 13L19 5M16.5 7.5l2 2M14.5 9.5l2 2" />
                </svg>
              </div>
              <div style={{ fontSize: 19, fontWeight: 500, color: C.head, marginBottom: 8 }}>
                No API keys
              </div>
              <p style={styles.lockedBody}>
                Create a key to authenticate requests to the API.
              </p>
              <button type="button" onClick={openCreateModal} className="btn-solid" style={styles.primaryBtn}>
                Create API key
              </button>
            </div>
          ) : (
            <>
              {keys.map((apiKey) => (
                <KeyCard
                  key={apiKey.id}
                  apiKey={apiKey}
                  onRotate={locked ? undefined : (k) => openAction("rotate", k)}
                  onRevoke={(k) => openAction("revoke", k)}
                  onCopyPrefix={copyPrefix}
                  copiedId={copiedId}
                />
              ))}
              {atLimit && (
                <p style={{ margin: "4px 0 0", fontSize: 12.5, color: C.muted }}>
                  You have reached the maximum of two active keys. Revoke one to
                  create another.
                </p>
              )}
            </>
          )}
        </div>
      )}

      <Modal
        isOpen={Boolean(modal)}
        onRequestClose={closeModal}
        style={modalStyles}
        contentLabel="API key management"
      >
        {modal === "create" && (
          <form onSubmit={createKey}>
            <div style={styles.modalHead}>
              <div style={styles.modalTitle}>Create API key</div>
              <p style={styles.modalSub}>The secret is shown once after creation.</p>
            </div>
            <div style={styles.modalBody}>
              {error && <div style={styles.inlineError} role="alert">{error}</div>}
              <div style={styles.field}>
                <label htmlFor="key-name" style={styles.label}>Name</label>
                <input
                  id="key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                  placeholder="Production integration"
                  style={styles.input}
                />
              </div>
              <div style={styles.field}>
                <label htmlFor="key-description" style={styles.label}>
                  Description <span style={{ color: C.muted }}>(optional)</span>
                </label>
                <textarea
                  id="key-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder="Used by the production data pipeline"
                  style={{ ...styles.input, resize: "vertical", fontFamily: "inherit" }}
                />
              </div>
            </div>
            <div style={styles.modalActions}>
              <button type="button" onClick={closeModal} className="btn-outline" style={styles.outlineBtn}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="btn-solid"
                style={{ ...styles.primaryBtn, opacity: busy || !name.trim() ? 0.55 : 1 }}
              >
                {busy ? "Creating…" : "Create key"}
              </button>
            </div>
          </form>
        )}

        {modal === "reveal" && (
          <div>
            <div style={styles.modalHead}>
              <div style={styles.modalTitle}>API key created</div>
              <p style={styles.modalSub}>
                Store this key securely. You will not be able to view it again.
              </p>
            </div>
            <div style={styles.modalBody}>
              <label style={styles.label}>Your API key</label>
              <div style={styles.revealRow}>
                <code style={styles.revealCode}>{revealedKey}</code>
                <button type="button" onClick={copyRevealedKey} className="btn-chip" style={styles.copyBtn}>
                  {isCopied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div style={styles.modalActions}>
              <button type="button" onClick={closeModal} className="btn-solid" style={styles.primaryBtn}>
                Done
              </button>
            </div>
          </div>
        )}

        {modal === "rotate" && (
          <div>
            <div style={styles.modalHead}>
              <div style={styles.modalTitle}>Rotate {selectedKey?.name}?</div>
              <p style={styles.modalSub}>The current key will stop working immediately.</p>
            </div>
            <div style={styles.modalBody}>
              {error && <div style={styles.inlineError} role="alert">{error}</div>}
              <p style={{ margin: 0, fontSize: 14, color: C.body, lineHeight: 1.55 }}>
                Update every service using this credential as soon as the
                replacement is created.
              </p>
            </div>
            <div style={styles.modalActions}>
              <button type="button" onClick={closeModal} className="btn-outline" style={styles.outlineBtn}>
                Cancel
              </button>
              <button
                type="button"
                onClick={rotateKey}
                disabled={busy}
                className="btn-solid"
                style={{ ...styles.primaryBtn, opacity: busy ? 0.55 : 1 }}
              >
                {busy ? "Rotating…" : "Rotate key"}
              </button>
            </div>
          </div>
        )}

        {modal === "revoke" && (
          <div>
            <div style={styles.modalHead}>
              <div style={styles.modalTitle}>Revoke {selectedKey?.name}?</div>
              <p style={styles.modalSub}>Requests using this key will fail immediately.</p>
            </div>
            <div style={styles.modalBody}>
              {error && <div style={styles.inlineError} role="alert">{error}</div>}
              <p style={{ margin: 0, fontSize: 14, color: C.body, lineHeight: 1.55 }}>
                This action cannot be undone.
              </p>
            </div>
            <div style={styles.modalActions}>
              <button type="button" onClick={closeModal} className="btn-outline" style={styles.outlineBtn}>
                Cancel
              </button>
              <button
                type="button"
                onClick={revokeKey}
                disabled={busy}
                className="btn-danger-solid"
                style={{ ...styles.dangerBtn, opacity: busy ? 0.55 : 1 }}
              >
                {busy ? "Revoking…" : "Revoke key"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </PageLayout>
  );
}

const styles = {
  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 24,
    marginBottom: 28,
  },
  eyebrow: {
    fontSize: 12,
    letterSpacing: 0,
    textTransform: "uppercase",
    color: C.muted,
    marginBottom: 10,
  },
  h1: {
    margin: "0 0 8px",
    fontSize: 32,
    lineHeight: 1.15,
    fontWeight: 500,
    letterSpacing: 0,
    color: C.head,
  },
  card: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: "22px 24px",
    boxShadow: "0 1px 2px rgba(35,56,58,0.04)",
  },
  keyIcon: {
    width: 44,
    height: 44,
    flex: "none",
    borderRadius: 10,
    background: C.mint,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  prefixChip: {
    fontFamily: "'Fira Code', monospace",
    fontSize: 13,
    color: C.body,
    background: C.page,
    border: `1px solid ${C.line}`,
    padding: "6px 10px",
    borderRadius: 8,
  },
  copyBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flex: "none",
    whiteSpace: "nowrap",
    fontSize: 12.5,
    padding: "6px 10px",
    borderRadius: 8,
    cursor: "pointer",
  },
  warnBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#FFF9E0",
    border: "1px solid #EFDE96",
    borderRadius: 8,
    padding: "11px 14px",
    marginBottom: 18,
  },
  metaGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
    gap: 20,
    paddingTop: 18,
    borderTop: `1px solid ${C.lineSoft}`,
  },
  metaItem: { display: "flex", flexDirection: "column", gap: 5 },
  metaLabel: {
    fontSize: 11,
    letterSpacing: 0,
    textTransform: "uppercase",
    color: C.muted,
  },
  metaValue: { fontSize: 13.5, color: C.body },
  rotateOutline: {
    fontSize: 13,
    fontWeight: 500,
    padding: "9px 14px",
    borderRadius: 8,
    cursor: "pointer",
  },
  rotateStrong: {
    fontSize: 13,
    fontWeight: 500,
    padding: "9px 14px",
    borderRadius: 8,
    cursor: "pointer",
  },
  revokeBtn: {
    fontSize: 13,
    fontWeight: 500,
    padding: "9px 14px",
    borderRadius: 8,
    cursor: "pointer",
  },
  primaryBtn: {
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 18px",
    borderRadius: 8,
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  outlineBtn: {
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 18px",
    borderRadius: 8,
    cursor: "pointer",
  },
  dangerBtn: {
    fontSize: 14,
    fontWeight: 500,
    padding: "11px 18px",
    borderRadius: 8,
    cursor: "pointer",
  },
  lockedCard: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: "72px 24px",
    textAlign: "center",
  },
  lockedIcon: {
    width: 52,
    height: 52,
    borderRadius: 999,
    background: "#F1F4F1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 20px",
  },
  lockedBody: {
    margin: "0 auto 22px",
    fontSize: 14,
    lineHeight: 1.6,
    color: C.muted,
    maxWidth: 380,
  },
  errorCard: {
    background: "#FFFFFF",
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: 24,
  },
  inlineError: {
    background: "#FDE8E5",
    border: "1px solid #F5CFC9",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 13.5,
    color: C.danger,
  },
  modalHead: {
    padding: "22px 24px 0",
  },
  modalTitle: { fontSize: 18, fontWeight: 500, color: C.head },
  modalSub: { margin: "6px 0 0", fontSize: 13.5, color: C.muted, lineHeight: 1.5 },
  modalBody: {
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    padding: "0 24px 24px",
  },
  field: { display: "flex", flexDirection: "column", gap: 7 },
  label: { fontSize: 13, color: C.head },
  input: {
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    color: C.body,
    background: "#FFFFFF",
  },
  revealRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: C.page,
    border: `1px solid ${C.line}`,
    borderRadius: 8,
    padding: "10px 12px",
  },
  revealCode: {
    flex: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
    fontFamily: "'Fira Code', monospace",
    fontSize: 13,
    color: C.body,
  },
};

export default Keys;
