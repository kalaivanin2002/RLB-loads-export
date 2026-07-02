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
  var tip = null;
  var observer = null;
  var scheduled = false;

  var esc = function (s) {
    return s == null ? "" : String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
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
      "#rlb-panel{position:fixed;bottom:16px;left:16px;z-index:2147483000;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;width:250px;overflow:hidden;}",
      "#rlb-panel .t{background:#0f172a;color:#fff;font-weight:700;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;}",
      "#rlb-panel .b{padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
      "#rlb-panel .row{display:flex;justify-content:space-between;gap:10px;}",
      "#rlb-panel .row span:first-child{white-space:nowrap;color:#64748b;}",
      "#rlb-panel .row span:last-child{text-align:right;font-weight:600;overflow-wrap:anywhere;}",
      "#rlb-panel .muted{color:#64748b;overflow-wrap:anywhere;}",
      "#rlb-panel button{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:7px 10px;font:600 12px/1 inherit;cursor:pointer;}",
      "#rlb-panel button.sec{background:#e2e8f0;color:#1e293b;}",
      "#rlb-panel button:disabled{background:#94a3b8;cursor:not-allowed;}",
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

  // ── floating control panel ────────────────────────────────────────────────────
  function ensurePanel() {
    if (!onLoadboard()) return;
    if (document.getElementById("rlb-panel")) return;
    var p = document.createElement("div");
    p.id = "rlb-panel";
    p.innerHTML =
      '<div class="t"><span>RLB match</span><span id="rlb-ar" class="muted" style="font-weight:400;font-size:11px;"></span></div>' +
      '<div class="b">' +
      '<div class="row"><span>Drivers</span><span id="rlb-drv">—</span></div>' +
      '<div class="row"><span>Loads seen</span><span id="rlb-seen">—</span></div>' +
      '<div class="row"><span>Rows found</span><span id="rlb-rows">—</span></div>' +
      '<div class="row"><span>Matches</span><span id="rlb-mat">—</span></div>' +
      '<button id="rlb-refresh" type="button">Refresh drivers</button>' +
      '<button id="rlb-showdrv" class="sec" type="button">View drivers</button>' +
      '<button id="rlb-autofill" type="button">Auto-fill &amp; search</button>' +
      '<button id="rlb-next" class="sec" type="button" style="display:none;">Next 5 →</button>' +
      '<div id="rlb-round" class="muted"></div>' +
      '<div id="rlb-msg" class="muted"></div>' +
      "</div>";
    document.body.appendChild(p);
    p.querySelector("#rlb-refresh").addEventListener("click", refreshDrivers);
    p.querySelector("#rlb-showdrv").addEventListener("click", showDrivers);
    p.querySelector("#rlb-autofill").addEventListener("click", startAutofill);
    p.querySelector("#rlb-next").addEventListener("click", nextRound);

    // Make the panel draggable by its title bar so it never gets stuck off-screen.
    var bar = p.querySelector(".t");
    bar.style.cursor = "move";
    var drag = null;
    bar.addEventListener("mousedown", function (e) {
      drag = { x: e.clientX, y: e.clientY, l: p.offsetLeft, t: p.offsetTop };
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var nl = drag.l + (e.clientX - drag.x);
      var nt = drag.t + (e.clientY - drag.y);
      nl = Math.min(Math.max(0, nl), window.innerWidth - p.offsetWidth);
      nt = Math.min(Math.max(0, nt), window.innerHeight - p.offsetHeight);
      p.style.left = nl + "px";
      p.style.top = nt + "px";
      p.style.right = "auto";
      p.style.bottom = "auto";
    });
    document.addEventListener("mouseup", function () { drag = null; });
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

  function setAutofillEnabled(on) {
    var a = document.getElementById("rlb-autofill");
    var n = document.getElementById("rlb-next");
    if (a) a.disabled = !on;
    if (n) n.disabled = !on;
  }

  function updateRoundUI() {
    var next = document.getElementById("rlb-next");
    var total = batches.length;
    setPanel("rlb-round", total ? "Round " + Math.min(roundIdx + 1, total) + " of " + total : "");
    if (next) next.style.display = total && roundIdx + 1 < total ? "block" : "none";
  }

  function startAutofill() {
    if (autofillBusy) return;
    try {
      chrome.storage.local.get(["plannerAvailability"], function (r) {
        var list = r.plannerAvailability || [];
        if (!list.length) { setPanel("rlb-msg", "Click Refresh drivers first."); return; }
        batches = buildBatches(list);
        roundIdx = 0;
        if (!batches.length) { setPanel("rlb-msg", "No placeable drivers (no drop-off coords)."); return; }
        updateRoundUI();
        runRound();
      });
    } catch (e) { setPanel("rlb-msg", "Extension reloaded — refresh the page."); }
  }

  function nextRound() {
    if (autofillBusy) return;
    if (roundIdx + 1 >= batches.length) { setPanel("rlb-msg", "All rounds done."); return; }
    roundIdx++;
    updateRoundUI();
    runRound();
  }

  function runRound() {
    if (roundIdx >= batches.length) { setPanel("rlb-msg", "All rounds done."); return; }
    var batch = batches[roundIdx];
    var cities = batch.map(function (b) { return b.city; });
    autofillBusy = true;
    setAutofillEnabled(false);
    setPanel("rlb-msg", "Round " + (roundIdx + 1) + "/" + batches.length + ": filling " + cities.join(", ") + "…");
    fillBatch(cities).then(function () {
      setPanel("rlb-msg", "Round " + (roundIdx + 1) + "/" + batches.length + " searched: " + cities.join(", "));
    }).catch(function (e) {
      setPanel("rlb-msg", "Round error: " + (e && e.message ? e.message : e));
    }).then(function () {
      autofillBusy = false;
      setAutofillEnabled(true);
      updateRoundUI();
    });
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
          setPanel("rlb-msg", "Error: " + ((res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "failed"));
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
          console.log("[RLB board] score-loads failed:", chrome.runtime.lastError || res);
          return;
        }
        latest = {};
        (res.loads || []).forEach(function (l) { if (l && l.loadId) latest[l.loadId] = l; });
        driverCount = res.drivers || driverCount;
        updatePanel();
        console.log("[RLB board] scored:", (res.loads || []).length, "matching load(s). diag:", res.diag);
        if (!res.drivers) setPanel("rlb-msg", "No drivers loaded — click Refresh drivers.");
        else if (res.diag) {
          var d = res.diag;
          setPanel("rlb-msg", (res.loads || []).length + " match / " + d.driversUsable + "/" + d.driversTotal + " drivers usable");
        }
        schedulePaint();
      });
    } catch (e) { /* context invalidated */ }
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
