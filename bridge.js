// Runs in the ISOLATED world. Receives messages from hook.js (page world):
// - CSRF token for the loadboard POST requests
// - entitiesV2 API responses for trip syncing
(function () {
  "use strict";
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d) return;

    // Handle CSRF token
    if (d.source === "RLB_CSRF" && d.token) {
      try {
        chrome.storage.local.set({
          csrfToken: d.token,
          csrfHeaderName: d.name || "anti-csrftoken-a2z",
          csrfCapturedAt: Date.now(),
        });
      } catch (e) {
        /* extension context invalidated on reload — ignore */
      }
    }

    // Handle entities response
    if (d.source === "RLB_ENTITIES" && d.entities) {
      try {
        chrome.storage.local.set({
          capturedEntitiesResponse: d.entities,
          capturedEntitiesAt: Date.now(),
        });
      } catch (e) {
        /* extension context invalidated on reload — ignore */
      }
    }

    // Buffer the latest loadboard search. bridge.js listens from document_start,
    // so it captures the board's initial search even before loadboard.js has
    // booted (document_idle). loadboard.js replays this buffer on boot, so the
    // first page of results still gets scored — no extra network call.
    if (d.source === "RLB_SEARCH" && Array.isArray(d.loads)) {
      try {
        chrome.storage.local.set({ lastSearchLoads: d.loads, lastSearchAt: Date.now() });
      } catch (e) {
        /* extension context invalidated on reload — ignore */
      }
    }
  });
})();
