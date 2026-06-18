// Runs in the page's MAIN world at document_start. Watches outgoing requests
// and captures Amazon's anti-CSRF token header from the load board's own
// traffic (it auto-refreshes, so a valid token flows shortly after load).
// The token is session-reusable, so we can attach it to our own search POST.
(function () {
  "use strict";
  if (window.__RLB_CSRF_HOOK__) return;
  window.__RLB_CSRF_HOOK__ = true;

  function isCsrfName(name) {
    if (!name) return false;
    const n = String(name).toLowerCase();
    return n === "anti-csrftoken-a2z" || n.indexOf("csrf") !== -1;
  }

  function report(name, value) {
    if (!name || !value) return;
    window.postMessage({ source: "RLB_CSRF", name: String(name), token: String(value) }, "*");
  }

  function scanHeaders(headers) {
    if (!headers) return;
    try {
      if (typeof Headers !== "undefined" && headers instanceof Headers) {
        headers.forEach(function (v, k) {
          if (isCsrfName(k)) report(k, v);
        });
      } else if (Array.isArray(headers)) {
        headers.forEach(function (pair) {
          if (pair && isCsrfName(pair[0])) report(pair[0], pair[1]);
        });
      } else if (typeof headers === "object") {
        Object.keys(headers).forEach(function (k) {
          if (isCsrfName(k)) report(k, headers[k]);
        });
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ── fetch ──────────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try {
        if (init && init.headers) scanHeaders(init.headers);
        if (input && typeof input === "object" && input.headers) scanHeaders(input.headers);
      } catch (e) {
        /* ignore */
      }
      const promise = origFetch.apply(this, arguments);

      // Intercept entitiesV2 API responses
      try {
        const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
        if (url && url.includes("/api/tours/entitiesV2")) {
          promise.then(function(response) {
            if (response && response.ok) {
              response.clone().json().then(function(data) {
                window.postMessage({
                  source: "RLB_ENTITIES",
                  entities: data
                }, "*");
              }).catch(function() {});
            }
            return response;
          }).catch(function() {
            return promise;
          });
        }
      } catch (e) {
        /* ignore */
      }

      return promise;
    };
  }

  // ── XMLHttpRequest ───────────────────────────────────────────────────────────
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origSet = XHR.prototype.setRequestHeader;
    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (isCsrfName(name)) report(name, value);
      } catch (e) {
        /* ignore */
      }
      return origSet.apply(this, arguments);
    };
  }
})();
