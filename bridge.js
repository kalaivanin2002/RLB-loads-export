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
  });
})();
