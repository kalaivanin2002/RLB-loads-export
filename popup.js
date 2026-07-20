// ─── RLB settings popup ───────────────────────────────────────────────────────
// The popup now only holds the extension's CONNECTION setup: API URL and the
// Relay base URL. The Bearer token is no longer entered here — it's issued
// automatically per carrier via /api/v1/init and cached by background.js
// (see ensureToken). Planning rules, auto-refresh and scoring weights live in
// FleetYes → Settings → RLB Settings and are synced into this extension
// automatically per carrier (see syncRlbSettings in background.js).
(function () {
  // Global safety net for this popup document — catches anything that escapes
  // normal try/catch so it lands in the durable errorLog instead of only
  // showing up in the popup's own (easy-to-miss, closes-on-blur) DevTools.
  function persistPopupError(source, err) {
    const message = err && err.message ? err.message : String(err);
    console.error("[RLB popup]", source, message);
    try {
      chrome.storage.local.get(["errorLog"], (r) => {
        const ERROR_LOG_MAX = 200;
        const entry = { ts: Date.now(), source: source, message: message, stack: (err && err.stack) || null };
        const next = (r.errorLog || []).concat(entry).slice(-ERROR_LOG_MAX);
        chrome.storage.local.set({ errorLog: next });
      });
    } catch (e) {
      /* ignore */
    }
  }
  window.addEventListener("error", (event) => persistPopupError("popup/uncaught", event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => persistPopupError("popup/unhandledrejection", event.reason));

  // Only the connection keys the popup still edits. Server-owned keys (planning
  // rules, auto-refresh, scoring weights) are managed in FleetYes and are NOT
  // touched here — saving the popup leaves them exactly as the last sync set them.
  const DEFAULTS = {
    relayBase: "https://relay.amazon.co.uk",
    // ontrackUrl is no longer user-editable — kept as the built-in default so
    // OnTrack API calls always have a base (see cfg.ontrackUrl in background.js).
    ontrackUrl: "https://ontrack-api.agilecyber.com",
    // carrierCode is no longer stored here — it's read live from the Relay page
    // (#case-carrier-scac) by the content script.
    // token is no longer entered here either — background.js fetches and
    // caches it automatically per carrier via /api/v1/init (see ensureToken).
    // Local, popup-only setting — deliberately NOT synced from FleetYes.
    searchLocation: "",
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    searchLocation: $("searchLocation"),
    saveDev: $("saveDev"),
  };

  function loadSettings() {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      const cfg = Object.assign({}, DEFAULTS, r || {});
      els.searchLocation.value = cfg.searchLocation || "";
    });
  }

  function flashSaved() {
    const b = els.saveDev;
    if (!b) return;
    const orig = b.textContent;
    b.textContent = "Saved ✓";
    setTimeout(() => { b.textContent = orig; }, 1200);
  }

  function flashRequired() {
    els.searchLocation.classList.add("invalid");
    els.searchLocation.focus();
    els.searchLocation.addEventListener("input", () => els.searchLocation.classList.remove("invalid"), { once: true });
  }

  // Persist ONLY the connection keys, so a save can never clobber the
  // server-synced planning/scoring settings (or the auto-fetched token)
  // sitting alongside them in storage.
  function saveSettings() {
    const searchLocation = els.searchLocation.value.trim();
    if (!searchLocation) { flashRequired(); return; }
    const cfg = {
      searchLocation: searchLocation,
      // relayBase / ontrackUrl are no longer user-editable — kept as the
      // built-in defaults so API calls always have a base (see cfg.relayBase /
      // cfg.ontrackUrl in background.js).
      relayBase: DEFAULTS.relayBase,
      ontrackUrl: DEFAULTS.ontrackUrl,
    };
    chrome.storage.local.set(cfg, flashSaved);
  }

  els.saveDev.addEventListener("click", saveSettings);

  loadSettings();
})();
