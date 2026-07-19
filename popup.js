// ─── RLB settings popup ───────────────────────────────────────────────────────
// The popup now only holds the extension's CONNECTION setup: API URL, token,
// carrier code and the Relay base URL. Planning rules, auto-refresh and scoring
// weights live in FleetYes → Settings → RLB Settings and are synced into this
// extension automatically per carrier (see syncRlbSettings in background.js).
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
    ontrackUrl: "https://ontrack-api.agilecyber.com/api/v1/rlb-locations",
    token: "",
    // carrierCode is no longer stored here — it's read live from the Relay page
    // (#case-carrier-scac) by the content script.
    // Local, popup-only setting — deliberately NOT synced from FleetYes.
    searchLocation: "",
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    toggleDev: $("toggleDev"),
    devSettings: $("devSettings"),
    searchLocation: $("searchLocation"),
    ontrackUrl: $("ontrackUrl"),
    token: $("token"),
    saveDev: $("saveDev"),
  };

  function loadSettings() {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      const cfg = Object.assign({}, DEFAULTS, r || {});
      els.searchLocation.value = cfg.searchLocation || "";
      els.ontrackUrl.value = cfg.ontrackUrl;
      els.token.value = cfg.token;
    });
  }

  els.toggleDev.addEventListener("click", () => {
    const open = els.devSettings.classList.toggle("hidden") === false;
    els.toggleDev.textContent = open ? "Developer settings ▴" : "Developer settings ▾";
  });

  function flashSaved() {
    const b = els.saveDev;
    if (!b) return;
    const orig = b.textContent;
    b.textContent = "Saved ✓";
    setTimeout(() => { b.textContent = orig; }, 1200);
  }

  // Persist ONLY the connection keys, so a save can never clobber the
  // server-synced planning/scoring settings sitting alongside them in storage.
  function saveSettings() {
    const cfg = {
      searchLocation: els.searchLocation.value.trim(),
      // relayBase is no longer user-editable — kept as the built-in default so the
      // Relay API calls always have a base (see cfg.relayBase in background.js).
      relayBase: DEFAULTS.relayBase,
      ontrackUrl: els.ontrackUrl.value.trim() || DEFAULTS.ontrackUrl,
      token: els.token.value.trim(),
    };
    chrome.storage.local.set(cfg, flashSaved);
  }

  els.saveDev.addEventListener("click", saveSettings);

  loadSettings();
})();
