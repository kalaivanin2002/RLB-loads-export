// Runs in the ISOLATED world on Amazon Relay pages. On the Load Board search
// page it highlights the result rows that match your available drivers:
//   • intercepts the page's own /loadboard/search response (via hook.js),
//   • asks the background worker to score those loads against driver availability,
//   • paints each matching .load-card (colour + badge + hover tooltip),
//   • re-applies across pagination / auto-refresh, and switches auto-refresh off.
(function () {
  "use strict";
  if (window.__RLB_LOADBOARD__) return;
  window.__RLB_LOADBOARD__ = true;

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var latest = {}; // loadId -> { bestScore, driverCount, suitableDrivers, payout, pickup, dropoff, workType, ratePerMile, tripMiles }
  var lastLoads = null; // last slim loads seen from the page (for re-scoring after a driver refresh)
  var driverCount = 0;
  var driverAt = null;
  var lastDriverError = null; // set by refreshDriversAsync on failure, shown in the "No drivers found" card
  var tip = null;
  var observer = null;
  var scheduled = false;

  var esc = function (s) {
    return s == null ? "" : String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  // Persist into the same durable errorLog that background.js/bridge.js write
  // to, so failures in this content script (e.g. the "Find my best loads"
  // button, or a failed refresh-availability round-trip) are diagnosable later
  // instead of only visible in this page's own DevTools console.
  function logError(tag, err, context) {
    var message = err && err.message ? err.message : String(err);
    console.error("[RLB loadboard] " + tag + ":", message, context || "");
    try {
      chrome.storage.local.get(["errorLog"], function (r) {
        var ERROR_LOG_MAX = 200;
        var entry = { ts: Date.now(), source: "loadboard/" + tag, message: message, stack: (err && err.stack) || null, context: context || null };
        var next = (r.errorLog || []).concat(entry).slice(-ERROR_LOG_MAX);
        chrome.storage.local.set({ errorLog: next });
      });
    } catch (e) {
      /* extension context invalidated on reload — ignore */
    }
  }
  var n1 = function (v) { return v == null || isNaN(v) ? "—" : Math.round(v * 10) / 10; };
  var onLoadboard = function () { return location.pathname.indexOf("/loadboard") !== -1; };

  // ── styles ──────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("rlb-style")) return;
    var css = [
      // Highlighting is CSS-only (data-attribute + ::after) so we never insert
      // child nodes into Relay's React-managed DOM (which crashes the app).
      "[data-rlb-match]{outline:2px solid #f59e0b!important;outline-offset:-2px;background:rgba(245,158,11,.06)!important;position:relative!important;}",
      "[data-rlb-match='strong']{outline-color:#16a34a!important;background:rgba(22,163,74,.08)!important;}",
      "[data-rlb-badge]::after{content:attr(data-rlb-badge);position:absolute;top:6px;left:6px;z-index:5;background:#f59e0b;color:#fff;font:600 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;padding:3px 6px;border-radius:5px;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.25);}",
      "[data-rlb-match='strong'][data-rlb-badge]::after{background:#16a34a;}",
      "#rlb-tip{position:fixed;z-index:2147483647;max-width:340px;background:#0f172a;color:#e2e8f0;font:12px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;border-radius:8px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none;display:none;}",
      "#rlb-tip .h{font-weight:700;margin-bottom:6px;color:#fff;}",
      "#rlb-tip table{width:100%;border-collapse:collapse;}",
      "#rlb-tip td{padding:2px 6px 2px 0;white-space:nowrap;}",
      "#rlb-tip tr.b td{color:#4ade80;font-weight:600;}",
      // Hero launcher button (top-right, near the search).
      "#rlb-launch,#rlb-launch *{box-sizing:border-box;}",
      "#rlb-launch{position:fixed;top:72px;right:22px;z-index:2147483000;display:inline-flex;align-items:center;gap:9px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;border:none;border-radius:999px;padding:12px 20px;font:700 14px/1 -apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;box-shadow:0 8px 22px rgba(37,99,235,.42);transition:transform .1s ease,box-shadow .2s ease;}",
      "#rlb-launch:hover{transform:translateY(-1px);box-shadow:0 10px 28px rgba(37,99,235,.52);}",
      "#rlb-launch:disabled{cursor:default;}",
      "#rlb-launch .bolt{font-size:16px;}",
      "#rlb-launch.busy .bolt{animation:rlbpulse 1s ease-in-out infinite;}",
      "@keyframes rlbpulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.45;transform:scale(1.28);}}",
      // Progress / result card.
      "#rlb-card,#rlb-card *{box-sizing:border-box;}",
      "#rlb-card{position:fixed;top:122px;right:22px;width:340px;max-width:92vw;z-index:2147483000;background:#fff;border:1px solid #e5e9f0;border-radius:14px;box-shadow:0 14px 44px rgba(15,23,42,.24);font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;overflow:hidden;display:none;}",
      "#rlb-card.show{display:block;}",
      "#rlb-card .head{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:#0f172a;color:#fff;}",
      "#rlb-card .head b{font-size:14px;}",
      "#rlb-card .head button{background:transparent;border:none;color:#cbd5e1;font-size:18px;line-height:1;cursor:pointer;}",
      "#rlb-card .body{padding:16px;}",
      "#rlb-card .step{display:flex;align-items:center;gap:10px;padding:5px 0;color:#94a3b8;}",
      "#rlb-card .step.active{color:#1e293b;font-weight:600;}",
      "#rlb-card .step.done{color:#16a34a;}",
      "#rlb-card .step .ic{width:16px;text-align:center;flex:none;}",
      "#rlb-card .spin{display:inline-block;width:13px;height:13px;border:2px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:rlbspin .7s linear infinite;vertical-align:middle;}",
      "@keyframes rlbspin{to{transform:rotate(360deg);}}",
      "#rlb-card .result{text-align:center;padding:8px 0 2px;}",
      "#rlb-card .result .n{font-size:36px;font-weight:800;color:#16a34a;line-height:1;}",
      "#rlb-card .result.zero .n{color:#94a3b8;}",
      "#rlb-card .result .lbl{color:#64748b;margin-top:5px;}",
      "#rlb-card .result .rnd{color:#94a3b8;font-size:12px;margin-top:2px;}",
      "#rlb-card .actions{display:flex;flex-direction:column;gap:8px;margin-top:15px;}",
      "#rlb-card .actions button{width:100%;border:none;border-radius:9px;padding:11px 12px;font:700 13px/1 inherit;cursor:pointer;}",
      "#rlb-card .actions .primary{background:#2563eb;color:#fff;}",
      "#rlb-card .actions .ghost{background:#f1f5f9;color:#334155;}",
      "#rlb-card .actions button:disabled{opacity:.5;cursor:default;}",
      "#rlb-card .note{color:#94a3b8;font-size:12px;margin-top:12px;}",
      "#rlb-card .note.stale{color:#b45309;}",
      "#rlb-card .adv{margin-top:12px;border-top:1px solid #eef2f6;padding-top:9px;}",
      "#rlb-card .adv summary{cursor:pointer;color:#94a3b8;font-size:12px;list-style:none;outline:none;}",
      "#rlb-card .adv summary::-webkit-details-marker{display:none;}",
      "#rlb-card .adv .tools{display:flex;flex-direction:column;gap:6px;margin-top:8px;}",
      "#rlb-card .adv .tools button{width:100%;background:#f1f5f9;color:#334155;border:none;border-radius:8px;padding:9px;font:600 12px/1 inherit;cursor:pointer;}",
      // Flash outline used when stepping through matched loads (data-attr = React-safe).
      "[data-rlb-flash]{outline:3px solid #16a34a!important;outline-offset:-3px;}",
      // Drivers verification overlay (spot-check computed drop-offs vs Relay).
      "#rlb-drivers{position:fixed;top:60px;left:16px;z-index:2147483200;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.28);font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;width:560px;max-width:92vw;max-height:70vh;display:flex;flex-direction:column;overflow:hidden;}",
      "#rlb-drivers .t{background:#0f172a;color:#fff;font-weight:700;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;cursor:move;}",
      "#rlb-drivers .t button{background:transparent;color:#fff;border:none;font-size:16px;cursor:pointer;line-height:1;}",
      "#rlb-drivers .body{overflow:auto;padding:0;}",
      "#rlb-drivers table{width:100%;border-collapse:collapse;}",
      "#rlb-drivers th,#rlb-drivers td{padding:6px 10px;text-align:left;border-bottom:1px solid #f1f5f9;white-space:nowrap;}",
      "#rlb-drivers th{position:sticky;top:0;background:#f8fafc;font-weight:600;color:#475569;z-index:1;}",
      "#rlb-drivers tr.warn td{background:#fef2f2;color:#b91c1c;}",
      "#rlb-drivers .sub{color:#94a3b8;font-size:11px;}",
    ].join("");
    var st = document.createElement("style");
    st.id = "rlb-style";
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // ── hero launcher + progress/result card ────────────────────────────────────────
  function ensurePanel() {
    if (!onLoadboard()) return;
    if (document.getElementById("rlb-launch")) return;

    var btn = document.createElement("button");
    btn.id = "rlb-launch";
    btn.type = "button";
    btn.innerHTML = '<span class="bolt">⚡</span><span class="lbl">Find my best loads</span>';
    document.body.appendChild(btn);
    btn.addEventListener("click", function () {
      try {
        runAutopilot();
      } catch (e) {
        console.log("[RLB] launch error:", e);
        logError("launchClick", e);
        try { showCard(); cardError("Couldn't start", (e && e.message) ? e.message : String(e)); } catch (e2) {}
        setLaunchBusy(false);
        autofillBusy = false;
      }
    });

    var card = document.createElement("div");
    card.id = "rlb-card";
    card.innerHTML =
      '<div class="head"><b>⚡ Best loads</b><button id="rlb-card-x" type="button" title="Close">×</button></div>' +
      '<div class="body"><div id="rlb-card-content"></div></div>';
    document.body.appendChild(card);
    card.querySelector("#rlb-card-x").addEventListener("click", hideCard);

    positionLauncher();
    window.addEventListener("scroll", positionLauncher, true);
    window.addEventListener("resize", positionLauncher);
  }

  // Anchor the floating launcher to the search panel's top-right so it reads as
  // part of the search area (we can't inject INTO the React panel without crashing
  // it, so we position a fixed button over it and keep it aligned on scroll/resize).
  function positionLauncher() {
    var b = document.getElementById("rlb-launch");
    if (!b) return;
    var anchor = document.querySelector(".search__panel") ||
      document.getElementById("rlb-origin-city-filter");
    if (!anchor) return; // not on the search view — leave at CSS default (top-right)
    var r = anchor.getBoundingClientRect();
    if (!r.width) return;
    var top = r.top - b.offsetHeight - 8;      // just above the search inputs
    if (top < 8) top = r.top + 6;              // if no room above, sit at the top edge
    b.style.top = Math.max(8, top) + "px";
    b.style.right = Math.max(12, window.innerWidth - r.right) + "px";
  }

  function showCard() { var c = document.getElementById("rlb-card"); if (c) c.classList.add("show"); }
  function hideCard() { var c = document.getElementById("rlb-card"); if (c) c.classList.remove("show"); }
  function setCard(html) { var el = document.getElementById("rlb-card-content"); if (el) el.innerHTML = html; }
  function setLaunchBusy(on) {
    var b = document.getElementById("rlb-launch");
    if (!b) return;
    b.classList.toggle("busy", !!on);
    b.disabled = !!on;
    var lbl = b.querySelector(".lbl");
    if (lbl) lbl.textContent = on ? "Working…" : "Find my best loads";
  }

  // Live step list shown while the autopilot runs.
  function renderSteps(steps) {
    var html = steps.map(function (s) {
      var ic = s.state === "done" ? "✓" : (s.state === "active" ? '<span class="spin"></span>' : "○");
      return '<div class="step ' + s.state + '"><span class="ic">' + ic + "</span><span>" + esc(s.label) + "</span></div>";
    }).join("");
    setCard(html);
  }

  // The debug tools (kept, just tucked away) — rendered inside the result card.
  function advancedHtml() {
    return (
      '<details class="adv"><summary>Advanced / debug ▾</summary><div class="tools">' +
      '<button id="rlb-t-refresh" type="button">Refresh drivers</button>' +
      '<button id="rlb-t-view" type="button">View drivers</button>' +
      "</div></details>"
    );
  }
  function wireAdvanced() {
    var r = document.getElementById("rlb-t-refresh");
    var v = document.getElementById("rlb-t-view");
    if (r) r.addEventListener("click", function () { runAutopilot(true); }); // force fresh fetch + re-run
    if (v) v.addEventListener("click", showDrivers);
  }
  function setPanel(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function updatePanel() {
    setPanel("rlb-drv", String(driverCount || 0));
    if (!driverCount) setPanel("rlb-msg", "Click Refresh drivers to load availability.");
  }

  // ── driver availability ───────────────────────────────────────────────────────
  function loadDriverCount() {
    try {
      chrome.storage.local.get(["plannerAvailability", "plannerAvailabilityAt"], function (r) {
        driverCount = (r.plannerAvailability || []).length;
        driverAt = r.plannerAvailabilityAt || null;
        updatePanel();
      });
    } catch (e) { /* context invalidated */ }
  }

  // Format an ISO time as UK local (what Relay shows), e.g. "Wed 1 Jul 16:00".
  function dtUK(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    try {
      return d.toLocaleString("en-GB", {
        weekday: "short", day: "numeric", month: "short",
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
      });
    } catch (e) { return d.toISOString(); }
  }

  // ── Drivers verification overlay ───────────────────────────────────────────────
  // Lists each driver's computed free time + free city so you can spot-check a few
  // against Relay's Tours → In-Transit before trusting the auto-search. Drivers we
  // can't place (no drop-off coordinates) are flagged in red — those are the ones
  // that would be skipped when searching.
  function showDrivers() {
    var existing = document.getElementById("rlb-drivers");
    if (existing) { existing.parentNode.removeChild(existing); return; } // toggle off
    try {
      chrome.storage.local.get(["plannerAvailability", "plannerAvailabilityAt"], function (r) {
        var list = (r.plannerAvailability || []).slice();
        var box = document.createElement("div");
        box.id = "rlb-drivers";
        if (!list.length) {
          box.innerHTML =
            '<div class="t"><span>Drivers</span><button id="rlb-drv-x" type="button">×</button></div>' +
            '<div class="body" style="padding:14px;">No drivers loaded yet — click <b>Refresh drivers</b> first.</div>';
        } else {
          // Sort by soonest free, then build the table.
          list.sort(function (a, b) { return Date.parse(a.freeAtEffective || 0) - Date.parse(b.freeAtEffective || 0); });
          var rows = list.map(function (a) {
            var fl = a.freeLocation || {};
            var hasCoords = fl.latitude != null && fl.longitude != null && fl.city;
            var name = a.driver && a.driver.name ? a.driver.name : "(unknown)";
            var freeCity = fl.city ? esc(fl.city) : "—";
            var coordNote = hasCoords ? "" : ' <span class="sub">(no location — will be skipped)</span>';
            var whenFree = a.alreadyFree ? "now" : dtUK(a.freeAtEffective);
            var lastEnd = a.lastTripEndTime ? dtUK(a.lastTripEndTime) : "—";
            return (
              '<tr class="' + (hasCoords ? "" : "warn") + '">' +
              "<td>" + esc(name) + "</td>" +
              "<td>" + esc(whenFree) + '<div class="sub">trip ends ' + esc(lastEnd) + "</div></td>" +
              "<td>" + freeCity + coordNote + "</td>" +
              "<td>" + esc(a.nextTripStart ? dtUK(a.nextTripStart) : "—") + "</td>" +
              "</tr>"
            );
          }).join("");
          var warnN = list.filter(function (a) {
            var fl = a.freeLocation || {};
            return !(fl.latitude != null && fl.longitude != null && fl.city);
          }).length;
          box.innerHTML =
            '<div class="t"><span>Drivers (' + list.length + ")" +
              (warnN ? " · " + warnN + " unplaceable" : "") +
              (r.plannerAvailabilityAt ? " · as of " + dtUK(new Date(r.plannerAvailabilityAt).toISOString()) : "") +
              '</span><button id="rlb-drv-x" type="button">×</button></div>' +
            '<div class="body"><table>' +
            "<thead><tr><th>Driver</th><th>Free from</th><th>Free city (drop-off)</th><th>Next trip</th></tr></thead>" +
            "<tbody>" + rows + "</tbody></table></div>";
        }
        document.body.appendChild(box);
        box.querySelector("#rlb-drv-x").addEventListener("click", function () {
          if (box.parentNode) box.parentNode.removeChild(box);
        });
        makeDraggable(box, box.querySelector(".t"));
      });
    } catch (e) { /* context invalidated */ }
  }

  // Reusable title-bar drag (keeps the box on-screen).
  function makeDraggable(el, handle) {
    if (!handle) return;
    var drag = null;
    handle.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON") return;
      drag = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop };
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var nl = Math.min(Math.max(0, drag.l + (e.clientX - drag.x)), window.innerWidth - el.offsetWidth);
      var nt = Math.min(Math.max(0, drag.t + (e.clientY - drag.y)), window.innerHeight - el.offsetHeight);
      el.style.left = nl + "px"; el.style.top = nt + "px"; el.style.right = "auto"; el.style.bottom = "auto";
    });
    document.addEventListener("mouseup", function () { drag = null; });
  }

  // ── Phase 2: auto-fill origins & search, in rounds of 5 ─────────────────────────
  // Origin box allows max 5 cities. We dedupe driver drop-off cities, sort by
  // soonest-free, and work through them 5 at a time: reset the form (New search),
  // type + pick each city from the autocomplete, then click "Search loads" once.
  // "Next 5" advances to the following batch. Every search is then highlighted by
  // the existing Phase-1 engine. One search per round keeps it human-paced.
  var ROUND_SIZE = 5;
  var batches = [];   // [[{city,country,drivers[],soonest}, …up to 5], …]
  var roundIdx = 0;
  var autofillBusy = false;

  var delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // Poll until testFn returns truthy (or timeout). Resolves with the value.
  function waitFor(testFn, timeoutMs, stepMs) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        var v = null;
        try { v = testFn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > (timeoutMs || 5000)) return reject(new Error("timeout"));
        setTimeout(poll, stepMs || 120);
      })();
    });
  }

  // Set a React-controlled input's value so React actually notices the change
  // (bypasses React's value tracker via the native setter, then fires `input`).
  function nativeSetValue(el, value) {
    var proto = Object.getPrototypeOf(el);
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // React components often toggle on mousedown, which element.click() doesn't
  // fire — dispatch the full pointer/mouse sequence so opens/selects register.
  function realClick(el) {
    if (!el) return;
    ["pointerdown", "mousedown", "mouseup", "click"].forEach(function (type) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    });
  }

  // Simulate a click on empty space, away from any popover. These MDN popovers
  // close on an outside mousedown (Escape isn't wired), so this is what dismisses
  // the origin dropdown / equipment popover.
  function clickOutside() {
    var el = document.documentElement;
    ["pointerdown", "mousedown", "mouseup", "click"].forEach(function (t) {
      try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    });
  }

  // Close any open combobox/popover (origin dropdown, equipment popover) so it
  // can't swallow the next click or cover the Search button.
  function closeOverlays() {
    try {
      var oi = originInput();
      if (oi) { oi.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); oi.blur(); }
      clickOutside();
    } catch (e) {}
    return delay(350).then(function () {
      // If a popover is still open, one more outside click.
      if (document.querySelector('[role="checkbox"][id="REQUIRED"]') || bestOption("")) {
        clickOutside();
        return delay(300);
      }
    });
  }

  function findSearchButton() {
    var bs = document.querySelectorAll("button");
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t === "search loads" || t.indexOf("search loads") !== -1) return bs[i];
    }
    return null;
  }

  function findButtonByText(txt) {
    var bs = document.querySelectorAll("button");
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].textContent || "").replace(/\s+/g, " ").trim();
      if (t === txt) return bs[i];
    }
    return null;
  }

  function originInput() {
    return document.querySelector('#rlb-origin-city-filter input[role=combobox]') ||
      document.querySelector('input[role=combobox][aria-labelledby*="origin"]') ||
      document.querySelector('input[role=combobox][aria-autocomplete="list"]');
  }

  // Choose the best autocomplete option for a city. Typing "War" returns matches
  // across many countries and mid-word ("Newark"), so rank strictly and prefer UK.
  function bestOption(city) {
    var want = String(city).toLowerCase().trim();
    var opts = document.querySelectorAll('[role="option"][aria-label]');
    var best = null, bestRank = 99;
    for (var i = 0; i < opts.length; i++) {
      var al = (opts[i].getAttribute("aria-label") || "").trim();
      var l = al.toLowerCase();
      if (l === "your location" || !l) continue;
      var rank;
      if (l === want + ", uk") rank = 0;                        // exact UK match
      else if (l.indexOf(want + ",") === 0 && /,\s*uk$/.test(l)) rank = 1; // "City, …, UK"
      else if (l.indexOf(want + ",") === 0) rank = 2;           // "City, <other country>"
      else if (l.indexOf(want) === 0) rank = 3;                 // starts with the city
      else rank = 99;
      if (rank < bestRank) { bestRank = rank; best = opts[i]; }
    }
    return bestRank < 99 ? best : null;
  }

  // Type one city and click its best matching suggestion.
  function selectOneOrigin(city) {
    var input = originInput();
    if (!input) return Promise.reject(new Error("origin input not found"));
    input.focus();
    nativeSetValue(input, city);
    return waitFor(function () { return bestOption(city); }, 5000, 150).then(function (opt) {
      realClick(opt);
      return delay(400); // typing the next city overwrites the text; no manual clear
    });
  }

  // Reset to a clean form (empty origins) via "New search". On a fresh form the
  // board does NOT auto-search until we click "Search loads", so we get exactly
  // one search per round.
  function resetForm() {
    var nb = findButtonByText("New search");
    if (nb) { nb.click(); return delay(900); }
    return Promise.resolve();
  }

  function equipmentBox() {
    return document.getElementById("equipment-trailer-filter");
  }

  // "New search" leaves Equipment empty (0 selected) and Equipment is required, so
  // the board returns blank. Re-select the "Tractor and trailer" category card
  // (role=checkbox, stable id="REQUIRED") to restore a broad equipment set — the
  // per-driver equipment match in scoring then narrows results precisely.
  // Find the "Tractor and trailer" category toggle in the open popover. Prefer the
  // stable enum id; fall back to the card whose heading text is exactly that (the
  // collapsed 3-card view doesn't expose id="REQUIRED" until interacted with).
  function equipmentToggle() {
    var byId = document.querySelector('[role="checkbox"][id="REQUIRED"]');
    if (byId) return byId;
    var els = document.querySelectorAll("label,div,span,h3,h4,p");
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || "").replace(/\s+/g, " ").trim();
      if (t === "Tractor and trailer") {
        var node = els[i];
        for (var d = 0; d < 6 && node; d++) {
          var cb = node.querySelector && node.querySelector('[role="checkbox"]');
          if (cb) return cb;
          node = node.parentElement;
        }
        return els[i].parentElement || els[i]; // last resort: click the card itself
      }
    }
    return null;
  }

  // Open the equipment popover, RETRYING until it's actually open. The click
  // handler may sit on any of a few elements in the box, so we cycle through
  // candidate targets (focus + full click) until the popover appears.
  function openEquipment() {
    var box = equipmentBox();
    if (!box) return Promise.reject(new Error("equipment box not found"));
    var candidates = [
      box.querySelector("[mdn-input-box]"),
      box.querySelector("input"),
      box.querySelector(".css-14t83no"),
      box.firstElementChild,
      box,
    ].filter(Boolean);
    var i = 0, tries = 0, max = candidates.length * 2;
    function attempt() {
      if (equipmentToggle()) return Promise.resolve(); // open
      var target = candidates[i % candidates.length];
      try { if (target.focus) target.focus(); } catch (e) {}
      realClick(target);
      return waitFor(equipmentToggle, 1200, 100).then(function () {}, function () {
        i++; tries++;
        if (tries >= max) throw new Error("popover did not open after " + tries + " tries");
        return delay(200).then(attempt);
      });
    }
    return attempt();
  }

  // Tick every currently-unchecked "All" checkbox in the popover (the sub-type
  // "Tell us about your vehicle" section). Ticking the category card alone doesn't
  // select the sub-types, so the field stays empty without this.
  function clickEquipmentAll() {
    var cbs = document.querySelectorAll('[role="checkbox"]');
    var clicked = 0;
    for (var i = 0; i < cbs.length; i++) {
      var labId = cbs[i].getAttribute("aria-labelledby");
      var txt = "";
      if (labId) { var lab = document.getElementById(labId); if (lab) txt = (lab.textContent || "").replace(/\s+/g, " ").trim(); }
      if (!txt) txt = (cbs[i].textContent || "").replace(/\s+/g, " ").trim();
      if (txt === "All" && cbs[i].getAttribute("aria-checked") !== "true") { realClick(cbs[i]); clicked++; }
    }
    return clicked;
  }

  function setEquipment() {
    return openEquipment().then(function () {
      var card = equipmentToggle();
      if (card && !(card.getAttribute && card.getAttribute("aria-checked") === "true")) { realClick(card); }
      return delay(500); // let the "Tell us about your vehicle" sub-types render
    }).then(function () {
      var n = clickEquipmentAll(); // select all sub-types (card alone isn't enough)
      if (!n) console.log("[RLB fill] equipment 'All' checkbox not found");
      return delay(400);
    }).catch(function (e) {
      console.log("[RLB fill] equipment select failed:", e && e.message);
    });
  }

  // Fill a batch of cities, then trigger the search once. We close the origin
  // dropdown before touching equipment (a stuck-open dropdown swallows the click),
  // and close overlays again before pressing Search loads.
  function fillBatch(cities) {
    return resetForm().then(function () {
      var chain = Promise.resolve();
      cities.forEach(function (c) {
        chain = chain.then(function () {
          return selectOneOrigin(c).catch(function (e) {
            console.log("[RLB fill] could not select", c, e && e.message);
          });
        });
      });
      return chain;
    }).then(function () {
      return closeOverlays(); // dismiss the origin dropdown before Equipment
    }).then(function () {
      return setEquipment(); // New search clears equipment; restore it or search blanks
    }).then(function () {
      return closeOverlays(); // dismiss the equipment popover before Search
    }).then(function () {
      var sb = findSearchButton();
      if (sb && !sb.disabled) { realClick(sb); return delay(600); }
      console.log(
        "[RLB fill] Search button " + (sb ? "disabled" : "not found") + " — buttons present: " +
        [].slice.call(document.querySelectorAll("button"))
          .map(function (b) { return "'" + (b.textContent || "").replace(/\s+/g, " ").trim() + "'" + (b.disabled ? "(disabled)" : ""); })
          .filter(function (t) { return t !== "''"; }).join(" | ")
      );
    });
  }

  // Group drivers into batches of ≤5 unique drop-off cities, soonest-free first.
  function buildBatches(list) {
    var byCity = {};
    list.forEach(function (a) {
      var fl = a.freeLocation || {};
      if (fl.latitude == null || fl.longitude == null || !fl.city) return; // unplaceable
      var key = String(fl.city).toLowerCase().trim();
      if (!byCity[key]) byCity[key] = { city: fl.city, country: fl.country || null, drivers: [], soonest: Infinity };
      byCity[key].drivers.push(a.driver && a.driver.name);
      var t = Date.parse(a.freeAtEffective || a.freeAt || 0);
      if (!isNaN(t) && t < byCity[key].soonest) byCity[key].soonest = t;
    });
    var cities = Object.keys(byCity).map(function (k) { return byCity[k]; });
    cities.sort(function (a, b) { return a.soonest - b.soonest; });
    var out = [];
    for (var i = 0; i < cities.length; i += ROUND_SIZE) out.push(cities.slice(i, i + ROUND_SIZE));
    return out;
  }

  // ── autopilot: fetch drivers → search a batch → show matches → pause ────────────
  var scoreResolvers = [];          // resolved by scoreAndPaint when a score completes
  var matchList = [], matchPos = 0; // for stepping through highlighted loads
  var STALE_MS = 6 * 3600 * 1000;   // driver data older than this gets a "refresh?" nudge
  function isStale(at) { return !at || (Date.now() - at > STALE_MS); }

  // A promise that resolves the next time scoreAndPaint finishes (with a fallback).
  function nextScore() {
    return new Promise(function (resolve) {
      scoreResolvers.push(resolve);
      setTimeout(function () {
        var i = scoreResolvers.indexOf(resolve);
        if (i !== -1) { scoreResolvers.splice(i, 1); resolve(null); }
      }, 9000);
    });
  }
  function resolveScores(res) {
    var list = scoreResolvers.slice();
    scoreResolvers.length = 0;
    list.forEach(function (fn) { try { fn(res); } catch (e) {} });
  }

  function refreshDriversAsync() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: "refresh-availability" }, function (res) {
          if (chrome.runtime.lastError || !res || !res.ok) {
            var msg = (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "unknown failure";
            logError("refreshDriversAsync", msg);
            lastDriverError = msg;
            resolve(0);
            return;
          }
          lastDriverError = null;
          driverCount = res.count || 0; driverAt = Date.now();
          resolve(driverCount);
        });
      } catch (e) { lastDriverError = (e && e.message) || String(e); logError("refreshDriversAsync", e); resolve(0); }
    });
  }
  function getAvailability() {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(["plannerAvailability"], function (r) { resolve(r.plannerAvailability || []); }); }
      catch (e) { logError("getAvailability", e); resolve([]); }
    });
  }

  function autopilotSteps(fromSearch) {
    return [
      { label: "Fetching driver details", state: fromSearch ? "done" : "active" },
      { label: "Reading trips & working out availability", state: fromSearch ? "done" : "pending" },
      { label: "Searching loads near your drivers", state: fromSearch ? "active" : "pending" },
      { label: "Matching loads to your drivers", state: "pending" },
    ];
  }

  function loadAvailabilityMeta() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(["plannerAvailability", "plannerAvailabilityAt"], function (r) {
          resolve({ count: (r.plannerAvailability || []).length, at: r.plannerAvailabilityAt || null });
        });
      } catch (e) { resolve({ count: 0, at: null }); }
    });
  }

  // Reuse the last-fetched driver availability by default (no traffic); only fetch
  // when there is none, or when forced via Advanced → Refresh drivers.
  function ensureDrivers(steps, force) {
    return loadAvailabilityMeta().then(function (meta) {
      if (!force && meta.count > 0) {
        steps[0].state = "done";
        steps[0].label = "Using driver details (as of " + dtUK(meta.at) + ")" + (isStale(meta.at) ? " ⚠ may be old" : "");
        steps[1].state = "done"; steps[1].label = "Availability ready";
        renderSteps(steps);
        return meta;
      }
      steps[0].state = "active"; steps[0].label = force ? "Refreshing driver details" : "Fetching driver details";
      renderSteps(steps);
      return refreshDriversAsync().then(function (count) {
        steps[0].state = "done"; steps[1].state = "done"; renderSteps(steps);
        return { count: count, at: Date.now() };
      });
    });
  }

  function runAutopilot(force) {
    if (autofillBusy) return;
    autofillBusy = true;
    showCard();
    setLaunchBusy(true);
    var steps = autopilotSteps(false);
    renderSteps(steps);

    ensureDrivers(steps, force === true).then(function (meta) {
      if (!meta || !meta.count) {
        var reason = lastDriverError ? ("Reason: " + lastDriverError + ". ") : "";
        cardError("No drivers found.", reason + "Open your Trips / In-Transit page once so we can read them, then use Advanced → Refresh drivers.");
        return null;
      }
      driverCount = meta.count; driverAt = meta.at;
      return getAvailability().then(function (list) {
        batches = buildBatches(list);
        roundIdx = 0;
        if (!batches.length) { cardError("No drivers to search from.", "None of your drivers had a usable drop-off location (Advanced → View drivers)."); return null; }
        return runAutoRound(steps);
      });
    }).catch(function (e) {
      logError("runAutopilot", e);
      cardError("Something went wrong.", (e && e.message) ? e.message : String(e));
    }).then(function () {
      setLaunchBusy(false);
      autofillBusy = false;
    });
  }

  function runAutoRound(steps) {
    var cities = batches[roundIdx].map(function (b) { return b.city; });
    steps[2].state = "active";
    steps[2].label = "Searching loads near your drivers (round " + (roundIdx + 1) + " of " + batches.length + ")";
    steps[3].state = "pending";
    renderSteps(steps);
    var scoreP = nextScore(); // arm BEFORE the search fires
    return fillBatch(cities).then(function () {
      steps[2].state = "done"; steps[3].state = "active"; renderSteps(steps);
      return scoreP;          // wait for highlighting to finish
    }).then(function () {
      return delay(500);      // let the paint settle
    }).then(function () {
      steps[3].state = "done"; renderSteps(steps);
      showRoundResult(cities);
    });
  }

  function countHighlighted() { return document.querySelectorAll("[data-rlb-match]").length; }

  // Keep the result card's number in sync with what's actually highlighted — so
  // paginating (a fresh score for the new page) updates the count and the
  // "Show matches" step-through targets the current page. No-op mid-run.
  function refreshCardCount() {
    if (autofillBusy) return;
    var nEl = document.querySelector("#rlb-card .result .n");
    if (!nEl) return; // card isn't showing a result right now
    var n = countHighlighted();
    nEl.textContent = String(n);
    var res = nEl.parentNode;
    if (res && res.classList) res.classList.toggle("zero", n === 0);
    var lbl = document.querySelector("#rlb-card .result .lbl");
    if (lbl) lbl.textContent = n === 1 ? "load matches your drivers" : "loads match your drivers";
    // NOTE: do NOT reset matchPos here — this runs on every repaint (incl. the
    // repaint caused by flashing a match), which would keep "Show matches" stuck.
    var step = document.getElementById("rlb-a-step");
    if (step && step.textContent.indexOf("Next match") === -1) {
      step.style.display = n ? "" : "none";
    }
  }

  function showRoundResult(cities) {
    var n = countHighlighted();
    var more = roundIdx + 1 < batches.length;
    setCard(
      '<div class="result' + (n ? "" : " zero") + '">' +
      '<div class="n">' + n + "</div>" +
      '<div class="lbl">' + (n === 1 ? "load matches your drivers" : "loads match your drivers") + "</div>" +
      '<div class="rnd">Round ' + (roundIdx + 1) + " of " + batches.length + " · " + esc(cities.join(", ")) + "</div>" +
      "</div>" +
      '<div class="actions">' +
      (n ? '<button class="primary" id="rlb-a-step">Show matches ▸</button>' : "") +
      (more ? '<button class="' + (n ? "ghost" : "primary") + '" id="rlb-a-next">Next 5 areas →</button>' : "") +
      '<button class="ghost" id="rlb-a-done">Done</button>' +
      "</div>" +
      '<div class="note' + (isStale(driverAt) ? " stale" : "") + '">Drivers as of ' + esc(dtUK(driverAt)) +
      (isStale(driverAt) ? " · may be out of date — Advanced → Refresh drivers" : "") +
      (more ? "" : " · all areas covered") + "</div>" +
      advancedHtml()
    );
    matchList = [].slice.call(document.querySelectorAll("[data-rlb-match]"));
    matchPos = 0;
    var step = document.getElementById("rlb-a-step");
    var next = document.getElementById("rlb-a-next");
    var done = document.getElementById("rlb-a-done");
    if (step) step.addEventListener("click", stepMatch);
    if (next) next.addEventListener("click", nextRound);
    if (done) done.addEventListener("click", hideCard);
    wireAdvanced();
  }

  // Scroll to the next highlighted load and flash it. We re-query the LIVE nodes
  // each click — React re-renders the load cards, so any saved references go stale
  // (detached), and scrollIntoView on a detached node does nothing.
  function stepMatch() {
    var els = [].slice.call(document.querySelectorAll("[data-rlb-match]"));
    if (!els.length) return;
    var idx = matchPos % els.length;
    matchPos++;
    var el = els[idx];
    var prev = document.querySelectorAll("[data-rlb-flash]");
    for (var i = 0; i < prev.length; i++) prev[i].removeAttribute("data-rlb-flash");
    el.setAttribute("data-rlb-flash", "1");
    try { el.scrollIntoView({ behavior: "smooth", block: "center" }); }
    catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    setTimeout(function () { el.removeAttribute("data-rlb-flash"); }, 1800);
    var s = document.getElementById("rlb-a-step");
    if (s) s.textContent = "Next match ▸ (" + (idx + 1) + "/" + els.length + ")";
  }

  function nextRound() {
    if (autofillBusy) return;
    if (roundIdx + 1 >= batches.length) return;
    roundIdx++;
    autofillBusy = true;
    setLaunchBusy(true);
    var steps = autopilotSteps(true);
    renderSteps(steps);
    runAutoRound(steps).catch(function (e) {
      cardError("Something went wrong.", (e && e.message) ? e.message : String(e));
    }).then(function () {
      setLaunchBusy(false);
      autofillBusy = false;
    });
  }

  function cardError(title, detail) {
    setCard(
      '<div class="result zero"><div class="lbl" style="font-weight:700;color:#b91c1c;font-size:14px;">' + esc(title) + "</div>" +
      (detail ? '<div class="rnd">' + esc(detail) + "</div>" : "") + "</div>" +
      '<div class="actions"><button class="ghost" id="rlb-a-done">Close</button></div>' +
      advancedHtml()
    );
    var done = document.getElementById("rlb-a-done");
    if (done) done.addEventListener("click", hideCard);
    wireAdvanced();
  }

  // The board's initial search often fires before this script's message listener
  // exists (hook.js/bridge.js run at document_start, we run at document_idle), so
  // that first RLB_SEARCH is missed. bridge.js buffers it; replay it here on boot.
  function replayBufferedSearch() {
    try {
      chrome.storage.local.get(["lastSearchLoads", "lastSearchAt"], function (r) {
        var fresh = r.lastSearchAt && Date.now() - r.lastSearchAt < 5 * 60000;
        if (fresh && Array.isArray(r.lastSearchLoads) && r.lastSearchLoads.length) {
          console.log("[RLB board] replaying buffered search:", r.lastSearchLoads.length, "loads");
          scoreAndPaint(r.lastSearchLoads);
        }
      });
    } catch (e) { /* context invalidated */ }
  }

  function refreshDrivers() {
    var btn = document.getElementById("rlb-refresh");
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    setPanel("rlb-msg", "Fetching trips…");
    try {
      chrome.runtime.sendMessage({ type: "refresh-availability" }, function (res) {
        if (btn) { btn.disabled = false; btn.textContent = "Refresh drivers"; }
        if (chrome.runtime.lastError || !res || !res.ok) {
          var msg = (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "failed";
          logError("refreshDriversButton", msg);
          setPanel("rlb-msg", "Error: " + msg);
          return;
        }
        driverCount = res.count || 0;
        driverAt = Date.now();
        setPanel("rlb-msg", "Loaded " + driverCount + " driver(s).");
        updatePanel();
        if (lastLoads) scoreAndPaint(lastLoads); // re-score whatever is on screen
      });
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "Refresh drivers"; }
      logError("refreshDriversButton", e);
      setPanel("rlb-msg", "Extension reloaded — refresh the page.");
    }
  }

  // ── scoring ────────────────────────────────────────────────────────────────────
  function scoreAndPaint(loads) {
    lastLoads = loads;
    setPanel("rlb-seen", String(loads.length));
    try {
      chrome.runtime.sendMessage({ type: "score-loads", loads: loads }, function (res) {
        if (chrome.runtime.lastError || !res || !res.ok) {
          logError("scoreAndPaint", (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "score-loads failed");
          resolveScores(null); // unblock the autopilot even on failure
          return;
        }
        latest = {};
        (res.loads || []).forEach(function (l) { if (l && l.loadId) latest[l.loadId] = l; });
        driverCount = res.drivers || driverCount;
        matchPos = 0; // a fresh score (new page/round) → step-through starts over
        console.log("[RLB board] scored:", (res.loads || []).length, "matching load(s). diag:", res.diag);
        schedulePaint();
        resolveScores(res); // let a running autopilot round continue
      });
    } catch (e) { logError("scoreAndPaint", e); }
  }

  // ── painting ─────────────────────────────────────────────────────────────────
  // Every load row carries a UUID id (`.load-card > div[id]`). Prefer the real
  // result cards; fall back to a broad UUID scan only if this view has none.
  function cardUuid(el) {
    var ch = el.children;
    for (var i = 0; i < ch.length; i++) { if (ch[i].id && UUID_RE.test(ch[i].id)) return ch[i].id; }
    if (el.id && UUID_RE.test(el.id)) return el.id;
    var q = el.querySelector("[id]");
    return q && UUID_RE.test(q.id) ? q.id : null;
  }
  function loadRows() {
    var seen = {}, rows = [];
    var cards = document.querySelectorAll("div.load-card");
    if (cards.length) {
      for (var i = 0; i < cards.length; i++) {
        var id = cardUuid(cards[i]);
        if (id && !seen[id]) { seen[id] = 1; rows.push({ el: cards[i], id: id }); }
      }
      return rows;
    }
    var all = document.querySelectorAll("[id]"); // fallback: outermost UUID elements
    for (var j = 0; j < all.length; j++) {
      var u = all[j].id;
      if (UUID_RE.test(u) && !seen[u]) { seen[u] = 1; rows.push({ el: all[j], id: u }); }
    }
    return rows;
  }
  function clearPaint() {
    var m = document.querySelectorAll("[data-rlb-match]");
    for (var j = 0; j < m.length; j++) {
      m[j].removeAttribute("data-rlb-match");
      m[j].removeAttribute("data-rlb-badge");
      m[j].__rlbInfo = null;
    }
  }
  function schedulePaint() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || window.setTimeout)(function () { scheduled = false; paint(); });
  }
  function paint() {
    if (observer) observer.disconnect();
    try { doPaint(); } finally { if (observer && document.body) observer.observe(document.body, { childList: true, subtree: true }); }
  }
  function doPaint() {
    if (!onLoadboard()) return; // injected on all Relay pages; only act on the board
    ensurePanel();
    positionLauncher();
    ensureAutoRefreshOff();
    var rows = loadRows();
    setPanel("rlb-rows", String(rows.length));
    clearPaint();
    var matched = 0;
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i].el;
      var info = latest[rows[i].id];
      if (!info) continue;
      var target = (el.closest && el.closest(".load-card")) || el;
      matched++;
      target.setAttribute("data-rlb-match", info.bestScore >= 0.85 ? "strong" : "weak");
      target.setAttribute("data-rlb-badge", "▲ " + info.driverCount + (info.driverCount === 1 ? " driver" : " drivers"));
      target.__rlbInfo = info;
      if (!target.__rlbBound) {
        target.__rlbBound = true;
        target.addEventListener("mouseenter", onEnter);
        target.addEventListener("mouseleave", onLeave);
        target.addEventListener("mousemove", onMove);
      }
    }
    setPanel("rlb-mat", String(matched));
    refreshCardCount(); // keep the card count in sync across pagination / re-scores
  }

  // ── auto-refresh off ───────────────────────────────────────────────────────────
  function ensureAutoRefreshOff() {
    var sw = document.querySelector('#utility-bar input[role="switch"]');
    if (sw && sw.getAttribute("aria-checked") === "true") {
      sw.click();
      setPanel("rlb-ar", "auto-refresh off");
    } else if (sw) {
      setPanel("rlb-ar", "auto-refresh off");
    }
  }

  // ── hover tooltip ───────────────────────────────────────────────────────────────
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = "rlb-tip";
    document.body.appendChild(tip);
    return tip;
  }
  function onEnter(e) {
    var info = e.currentTarget.__rlbInfo;
    if (!info) return;
    var t = ensureTip();
    var rows = (info.suitableDrivers || []).map(function (d, i) {
      var name = d.driver && d.driver.name ? d.driver.name : "(unknown)";
      return (
        '<tr class="' + (i === 0 ? "b" : "") + '"><td>' + esc(name) + "</td><td>" +
        n1(d.deadheadMiles) + "mi dh</td><td>" + (d.returnMiles == null ? "—" : n1(d.returnMiles) + "mi ret") + "</td><td>" +
        n1(d.pickupGapHours) + "h</td><td>" + n1(d.fitScore != null ? d.fitScore * 100 : null) + "</td></tr>"
      );
    }).join("");
    var pc = info.pickup && info.pickup.city, dc = info.dropoff && info.dropoff.city;
    t.innerHTML =
      '<div class="h">£' + (info.payout != null ? Math.round(info.payout) : "—") + " · " + esc(pc) + " → " + esc(dc) +
      " · " + esc(info.workType === "ROUND_TRIP" ? "Round trip" : info.workType === "ONE_WAY" ? "One-way" : info.workType || "") + "</div>" +
      "<table>" + rows + "</table>";
    t.style.display = "block";
    positionTip(e);
  }
  function onMove(e) { positionTip(e); }
  function onLeave() { if (tip) tip.style.display = "none"; }
  function positionTip(e) {
    if (!tip) return;
    var pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    var x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > window.innerWidth) x = e.clientX - w - pad;
    if (y + h > window.innerHeight) y = e.clientY - h - pad;
    tip.style.left = Math.max(4, x) + "px";
    tip.style.top = Math.max(4, y) + "px";
  }

  // ── boot ────────────────────────────────────────────────────────────────────────
  function boot() {
    injectStyles();
    ensurePanel();
    loadDriverCount();
    replayBufferedSearch();
    observer = new MutationObserver(schedulePaint);
    observer.observe(document.body, { childList: true, subtree: true });
    schedulePaint();
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (d && d.source === "RLB_SEARCH" && Array.isArray(d.loads)) {
      console.log("[RLB board] live search received:", d.loads.length, "loads");
      scoreAndPaint(d.loads);
    }
  });

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
