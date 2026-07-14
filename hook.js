// Runs in the page's MAIN world at document_start. Watches outgoing requests
// and captures Amazon's anti-CSRF token header from the load board's own
// traffic (it auto-refreshes, so a valid token flows shortly after load).
// The token is session-reusable, so we can attach it to our own search POST.
(function () {
  "use strict";
  if (window.__RLB_CSRF_HOOK__) return;
  window.__RLB_CSRF_HOOK__ = true;
  console.log("[RLB hook] installed (MAIN world) — watching fetch + XHR for loadboard/search");

  function isCsrfName(name) {
    if (!name) return false;
    const n = String(name).toLowerCase();
    return n === "anti-csrftoken-a2z" || n.indexOf("csrf") !== -1;
  }

  function report(name, value) {
    if (!name || !value) return;
    window.postMessage({ source: "RLB_CSRF", name: String(name), token: String(value) }, "*");
  }

  // Surface intercepted-request failures to the ISOLATED world (bridge.js),
  // which persists them via chrome.storage — this MAIN-world script has no
  // extension API access, and console output here is lost once DevTools closes
  // or the page reloads.
  function reportError(tag, detail) {
    try {
      window.postMessage({ source: "RLB_ERROR", tag: String(tag), detail: detail || null }, "*");
    } catch (e) {
      /* ignore */
    }
  }

  // Slim a loadboard/search response down to the fields the planner needs, then
  // post it to the ISOLATED world (the raw response is ~600KB — never ship it whole).
  function slimSearch(data) {
    var wos = data && data.workOpportunities;
    if (!Array.isArray(wos)) return [];
    return wos.map(function (w) {
      var sl = w.startLocation || {};
      var el = w.endLocation || {};
      return {
        id: w.id,
        firstPickupTime: w.firstPickupTime || null,
        lastDeliveryTime: w.lastDeliveryTime || null,
        workOpportunityType: w.workOpportunityType || null,
        startLocation: { city: sl.city, latitude: sl.latitude, longitude: sl.longitude, label: sl.label, stopCode: sl.stopCode },
        endLocation: { city: el.city, latitude: el.latitude, longitude: el.longitude, domicile: el.domicile },
        payout: w.payout ? { value: w.payout.value, unit: w.payout.unit } : null,
        totalDistance: w.totalDistance ? { value: w.totalDistance.value } : null,
        deadhead: w.deadhead ? { value: w.deadhead.value } : null,
        loads: (w.loads || []).slice(0, 1).map(function (l) { return { equipmentType: l && l.equipmentType }; }),
      };
    });
  }
  function postSearch(data) {
    try {
      var loads = slimSearch(data);
      if (!loads.length) {
        console.log("[RLB hook] response had 0 workOpportunities — not a search result, ignored");
        return; // not a loads response — ignore
      }
      console.log("[RLB hook] posting RLB_SEARCH:", loads.length, "loads");
      window.postMessage({ source: "RLB_SEARCH", loads: loads }, "*");
    } catch (e) {
      console.debug("[RLB hook] postSearch error:", e);
    }
  }
  // Only the main search endpoint feeds the highlighter. We deliberately exclude
  // /loadboard/recommendations/get — those are a different, smaller load set that
  // would otherwise overwrite the visible search results.
  function isSearchUrl(url) {
    return !!url && url.indexOf("/loadboard/search") !== -1;
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
      // Requests the extension itself issues in this world (background's
      // executeScript helpers) carry this marker. Pass them through untouched:
      // scanning them would capture OUR OWN token header and write it back to
      // storage — re-poisoning the cache with a bad token right after
      // background cleared it (the reason a failed token could never heal).
      try {
        var mh = init && init.headers;
        if (mh && typeof mh === "object" && !Array.isArray(mh) &&
            !(typeof Headers !== "undefined" && mh instanceof Headers) &&
            mh["x-rlb-internal"]) {
          delete mh["x-rlb-internal"]; // never send the marker to the server
          return origFetch.apply(this, arguments);
        }
      } catch (e) {
        /* ignore */
      }
      try {
        if (init && init.headers) scanHeaders(init.headers);
        if (input && typeof input === "object" && input.headers) scanHeaders(input.headers);
      } catch (e) {
        /* ignore */
      }

      const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
      const isEntitiesCall = url && url.includes("/api/tours/entitiesV2");
      const isSearchCall = isSearchUrl(url);
      if (isSearchCall) console.log("[RLB hook] fetch search intercepted:", url);

      const promise = origFetch.apply(this, arguments);

      // Intercept entitiesV2 (trips) and loadboard/search (loads) responses.
      // Cloning + reading the clone async loses a race: the Relay SPA cancels the
      // underlying stream (AbortError) before our deferred clone read finishes.
      // So instead WE read the original body first (sole reader — nothing can
      // abort it out from under us), then hand the app a FRESH Response rebuilt
      // from the same bytes.
      if (isEntitiesCall || isSearchCall) {
        var tag = isSearchCall ? "search" : "entities";
        return promise.then(function (response) {
          if (!response.ok) {
            reportError("fetch:" + tag, { url: url, status: response.status, statusText: response.statusText });
          }
          return response.text().then(function (text) {
            try {
              var data = JSON.parse(text);
              if (isEntitiesCall) window.postMessage({ source: "RLB_ENTITIES", entities: data }, "*");
              else postSearch(data);
            } catch (e) {
              console.log("[RLB hook] " + tag + " body not usable (len " + (text ? text.length : 0) + ")");
              if (!response.ok) {
                reportError("fetch:" + tag + ":parse", { url: url, status: response.status, body: (text || "").slice(0, 300) });
              }
            }
            // Rebuild an equivalent Response so the page's own code still works.
            try {
              return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
            } catch (e) {
              return new Response(text);
            }
          }).catch(function (err) {
            console.log("[RLB hook] " + tag + " original read failed:", err && err.name);
            reportError("fetch:" + tag + ":readFailed", { url: url, name: err && err.name, message: err && err.message });
            return response; // couldn't read — give the page back the original
          });
        });
      }

      return promise; // hand the page its ORIGINAL, untouched promise
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

    // Also intercept XMLHttpRequest for entitiesV2 API
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function(method, url) {
      const isEntitiesCall = typeof url === "string" && url.includes("/api/tours/entitiesV2");
      const isSearchCall = isSearchUrl(typeof url === "string" ? url : "");
      if (isSearchCall) console.log("[RLB hook] xhr search intercepted:", url);
      if (isEntitiesCall || isSearchCall) {
        // Use addEventListener so the page reassigning onreadystatechange can't
        // clobber our handler (the reason interception was silently failing).
        this.addEventListener("load", function () {
          if (this.status < 200 || this.status >= 300) {
            reportError("xhr:" + (isEntitiesCall ? "entities" : "search"), {
              url: url,
              status: this.status,
              body: (this.responseText || "").slice(0, 300),
            });
            return;
          }
          try {
            if (this.responseText) {
              const data = JSON.parse(this.responseText);
              if (isEntitiesCall) window.postMessage({ source: "RLB_ENTITIES", entities: data }, "*");
              else postSearch(data);
            }
          } catch (e) {
            reportError("xhr:" + (isEntitiesCall ? "entities" : "search") + ":parse", {
              url: url,
              message: e && e.message,
            });
          }
        });
        this.addEventListener("error", function () {
          reportError("xhr:" + (isEntitiesCall ? "entities" : "search") + ":networkError", { url: url });
        });
      }
      return origOpen.apply(this, arguments);
    };
  }
})();
