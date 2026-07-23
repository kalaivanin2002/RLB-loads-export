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

  // The popup is now INFO-ONLY. Every setting is sourced automatically:
  //   • token        → /api/v1/init per carrier (ensureToken in background.js)
  //   • carrier code → read live from the Relay page (#case-carrier-scac)
  //   • searchLocation + planning rules + scoring + auto-refresh → rlb-settings API
  //   • ontrackUrl / relayBase → built-in defaults in background.js's getConfig
  // So there is nothing to load, edit, or save here.
})();
