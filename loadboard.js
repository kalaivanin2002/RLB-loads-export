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
      "#rlb-panel{position:fixed;bottom:16px;left:16px;z-index:2147483000;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;width:220px;overflow:hidden;}",
      "#rlb-panel .t{background:#0f172a;color:#fff;font-weight:700;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;}",
      "#rlb-panel .b{padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
      "#rlb-panel .row{display:flex;justify-content:space-between;}",
      "#rlb-panel .muted{color:#64748b;}",
      "#rlb-panel button{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:7px 10px;font:600 12px/1 inherit;cursor:pointer;}",
      "#rlb-panel button:disabled{background:#94a3b8;cursor:not-allowed;}",
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
      '<div id="rlb-msg" class="muted"></div>' +
      "</div>";
    document.body.appendChild(p);
    p.querySelector("#rlb-refresh").addEventListener("click", refreshDrivers);

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
    setPanel("rlb-drv", driverCount ? String(driverCount) + (driverAt ? "" : "") : "0 — click Refresh");
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
