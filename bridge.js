// Runs in the ISOLATED world. Receives the CSRF token that hook.js captures in
// the page and persists it to extension storage, where the background worker
// reads it to attach to the loadboard/search POST.
(function () {
  "use strict";
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== "RLB_CSRF" || !d.token) return;
    try {
      chrome.storage.local.set({
        csrfToken: d.token,
        csrfHeaderName: d.name || "anti-csrftoken-a2z",
        csrfCapturedAt: Date.now(),
      });
    } catch (e) {
      /* extension context invalidated on reload — ignore */
    }
  });
})();
