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
  var onlyMyDrivers = false; // "only my driver locations" filter — hide unmatched load cards
  var lastDriverError = null; // set by refreshDriversAsync on failure, shown in the "No drivers found" card
  var lastDriverErrorConfig = false; // true when lastDriverError is a config problem (missing settings)
  var lastAvailabilitySource = null; // "schedule-api" | "relay-trips-fallback" — from the last refresh
  var lastApiError = null; // the shifts-API error message when we fell back to Relay trips
  var tip = null;
  var observer = null;
  var scheduled = false;

  // ── manual auto-refresh state ────────────────────────────────────────────────
  // Our own timed refresh: we click Relay's manual refresh control on a repeating
  // timer, each interval a random value in [arMin, arMax] seconds. Relay's OWN
  // auto-refresh stays off (ensureAutoRefreshOff) — this replaces it on our clock.
  // Config lives in the popup's Developer settings and is read from storage here;
  // a storage.onChanged listener starts/stops the timer live without a reload.
  var AR_MIN_S = 3, AR_MAX_S = 30;         // valid interval bounds (seconds)
  var arEnabled = false;                    // is our auto-refresh running?
  var arMin = 6, arMax = 9;                 // chosen interval bounds (seconds)
  var arTimer = null;                       // setTimeout handle for the next refresh
  var arRescoreTimer = null;                // follow-up timer that re-scores after a refresh
  var lastScoredSearchAt = 0;               // lastSearchAt we last handed to scoreAndPaint

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
      "[data-rlb-badge]::after{content:attr(data-rlb-badge);position:absolute;top:6px;left:6px;z-index:5;background:#f59e0b;color:#fff;font:600 11px/1 'Amazon Ember',-apple-system,Segoe UI,Roboto,sans-serif;padding:3px 6px;border-radius:5px;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.25);}",
      "[data-rlb-match='strong'][data-rlb-badge]::after{background:#16a34a;}",
      // EARLY badge for loads with a driver matched via the availability lead
      // (pickup before drop-off). Rendered via the card's ::before — NO DOM node is
      // inserted into Relay's React tree — and positioned in JS (positionEarlyBadge)
      // to sit on the status row, just right of the "Live" label (between Live and
      // the Amount). Position is scroll-invariant (::before is absolute in the card).
      "[data-rlb-lead]::before{content:'EARLY';position:absolute;left:var(--rlb-early-left,8px);top:var(--rlb-early-top,8px);z-index:6;background:#b91c1c;color:#fff;font:700 10px/1 'Amazon Ember',-apple-system,Segoe UI,Roboto,sans-serif;padding:4px 6px;border-radius:4px;letter-spacing:.04em;box-shadow:0 1px 2px rgba(0,0,0,.3);pointer-events:none;white-space:nowrap;}",
      // Solid near-black tooltip: no borders, no header underline, full-brightness
      // white text on every row (no dimming/opacity). Keeps the tabular columns.
      "#rlb-tip{position:fixed;z-index:2147483647;max-width:360px;background:#0b0f19;color:#ffffff;font:12px/1.3 'Amazon Ember',-apple-system,Segoe UI,Roboto,sans-serif;border-radius:8px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.5);pointer-events:none;display:none;}",
      "#rlb-tip .h{font-weight:700;margin-bottom:4px;color:#fff;}",
      // !important on the border/background resets: Relay's own page styles can leak
      // into our injected table (default cell borders, alternating-row backgrounds)
      // if their stylesheet loads/wins after ours — these overrides keep the tooltip
      // a flat borderless dark panel regardless of load order.
      "#rlb-tip table{width:100%;border-collapse:collapse;border:none!important;box-shadow:none!important;background:transparent!important;}",
      "#rlb-tip td{padding:2px 6px 2px 0;white-space:nowrap;border:none!important;background:transparent!important;color:#ffffff;font-size:11px;}",
      // Driver name truncates (single line + ellipsis) so a long name keeps the row a
      // uniform height and the tooltip narrow; full name still shows on hover.
      "#rlb-tip .rlb-dname{display:inline-block;max-width:108px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;}",
      "#rlb-tip td:not(:first-child){text-align:right;}",
      "#rlb-tip th{padding:0 6px 3px 0;white-space:nowrap;text-align:left;color:#ffffff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.02em;border:none!important;background:transparent!important;}",
      "#rlb-tip th:not(:first-child){text-align:right;}",
      "#rlb-tip tr.b td{color:#4ade80;}",
      // Drivers whose match relies on the availability lead (pickup before drop-off)
      // are indicated by red text ONLY — same font/size as the other names, no badge.
      // Placed after .b so red wins when the best-fit driver is also a lead match.
      "#rlb-tip tr.lead td{color:#ff6b6b;}",
      // Hero launcher button (top-right, near the search).
      "#rlb-launch,#rlb-launch *{box-sizing:border-box;}",
      "#rlb-launch{position:fixed;top:72px;right:22px;z-index:2147483000;display:inline-flex;align-items:center;gap:9px;background:rgb(0,104,141);color:#fff;border:none;border-radius:4px;padding:12px 20px;font:500 14px/1 \"Amazon Ember\",-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;box-shadow:none;transition:background-color .15s ease;}",
      "#rlb-launch:hover{background:rgb(0,88,120);}",
      "#rlb-launch:disabled{cursor:default;}",
      "#rlb-launch .bolt{font-size:16px;}",
      "#rlb-launch.busy .bolt{animation:rlbpulse 1s ease-in-out infinite;}",
      "@keyframes rlbpulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.45;transform:scale(1.28);}}",
      // Second hero button: same shape, distinct colour — "unassigned drivers only".
      "#rlb-launch-unassigned,#rlb-launch-unassigned *{box-sizing:border-box;}",
      "#rlb-launch-unassigned{position:fixed;top:72px;right:22px;z-index:2147483000;display:inline-flex;align-items:center;gap:9px;background:rgb(106,66,171);color:#fff;border:none;border-radius:4px;padding:12px 20px;font:500 14px/1 \"Amazon Ember\",-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;box-shadow:none;transition:background-color .15s ease;}",
      "#rlb-launch-unassigned:hover{background:rgb(88,52,146);}",
      "#rlb-launch-unassigned:disabled{cursor:default;}",
      "#rlb-launch-unassigned .bolt{font-size:16px;}",
      "#rlb-launch-unassigned.busy .bolt{animation:rlbpulse 1s ease-in-out infinite;}",
      // Bottom-bar slider toggle chips — shared by "Only my driver locations"
      // (#rlb-only-mine) and "Fleetyes refresh" (#rlb-fleetyes-refresh).
      "#rlb-only-mine,#rlb-fleetyes-refresh,#rlb-only-mine *,#rlb-fleetyes-refresh *{box-sizing:border-box;}",
      "#rlb-only-mine,#rlb-fleetyes-refresh{position:fixed;bottom:14px;right:22px;z-index:2147483002;display:inline-flex;align-items:center;gap:9px;height:34px;white-space:nowrap;background:#fff;border:1px solid #d5dbe5;border-radius:6px;padding:8px 12px;font:500 13px/1 \"Amazon Ember\",-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;box-shadow:0 1px 4px rgba(15,23,42,.12);cursor:pointer;user-select:none;}",
      // Toggle switch: the real checkbox is transparent on top; the slider draws the UI.
      "#rlb-only-mine .rlb-switch,#rlb-fleetyes-refresh .rlb-switch{position:relative;display:inline-block;width:34px;height:18px;flex:none;}",
      "#rlb-only-mine .rlb-switch input,#rlb-fleetyes-refresh .rlb-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1;}",
      "#rlb-only-mine .rlb-slider,#rlb-fleetyes-refresh .rlb-slider{position:absolute;inset:0;background:#cbd5e1;border-radius:999px;transition:background .15s ease;}",
      "#rlb-only-mine .rlb-slider::before,#rlb-fleetyes-refresh .rlb-slider::before{content:\"\";position:absolute;top:2px;left:2px;width:14px;height:14px;background:#fff;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s ease;}",
      "#rlb-only-mine .rlb-switch input:checked + .rlb-slider,#rlb-fleetyes-refresh .rlb-switch input:checked + .rlb-slider{background:rgb(0,104,141);}",
      "#rlb-only-mine .rlb-switch input:checked + .rlb-slider::before,#rlb-fleetyes-refresh .rlb-switch input:checked + .rlb-slider::before{transform:translateX(16px);}",
      // Auto-refresh countdown chip — sits beside the Refresh toggle and shows
      // the remaining seconds until the next automatic board refresh. box-sizing:
      // border-box keeps its rendered width equal to min-width (160px) so the
      // reserved-slot fallback in positionOnlyMine (which assumes 160px while the
      // chip is display:none and offsetWidth reads 0) actually matches — without
      // it, padding/border pushed the real width to 182px and the chip landed
      // partly underneath the Auto Refresh toggle when switched on.
      "#rlb-ar-countdown{box-sizing:border-box;position:fixed;bottom:14px;right:22px;z-index:2147483000;display:none;align-items:center;justify-content:center;white-space:nowrap;min-width:160px;background:#fff;border:1px solid #d5dbe5;border-radius:6px;padding:8px 10px;font:600 13px/1 \"Amazon Ember\",-apple-system,Segoe UI,Roboto,sans-serif;color:rgb(0,104,141);box-shadow:0 1px 4px rgba(15,23,42,.12);user-select:none;}",
      // "Next Refresh" label — sits to the LEFT of the countdown while the Refresh
      // toggle is on, so the row reads: Only my drivers | Next Refresh | 7s | Refresh.
      "#rlb-next-refresh-label{position:fixed;bottom:14px;right:22px;z-index:2147483000;display:none;align-items:center;background:#fff;border:1px solid #d5dbe5;border-radius:6px;padding:8px 10px;font:500 13px/1 \"Amazon Ember\",-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;box-shadow:0 1px 4px rgba(15,23,42,.12);user-select:none;}",
      // Hide non-matching load cards when the filter is on (data-attr = React-safe,
      // same approach as the highlight outline — we never touch Relay's child nodes).
      "[data-rlb-hidden]{display:none!important;}",
      // When the filter is on, the only visible cards are matches — so the outline,
      // tint and badge are redundant. Suppress them (data-rlb-match stays on the node
      // for counting / step-through; only its visual styling is neutralised here).
      "html[data-rlb-filter] [data-rlb-match]{outline:none!important;background:transparent!important;}",
      "html[data-rlb-filter] [data-rlb-badge]::after{display:none!important;}",
      // Progress / result card.
      "#rlb-card,#rlb-card *{box-sizing:border-box;}",
      "#rlb-card{position:fixed;top:122px;right:22px;width:340px;max-width:92vw;z-index:2147483000;background:#fff;border:1px solid #e5e9f0;border-radius:14px;box-shadow:0 14px 44px rgba(15,23,42,.24);font:13px/1.5 'Amazon Ember',-apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;overflow:hidden;display:none;}",
      "#rlb-card.show{display:block;}",
      "#rlb-card .head{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:#0f172a;color:#fff;}",
      "#rlb-card .head b{font-size:14px;}",
      "#rlb-card .head button{background:transparent;border:none;color:#cbd5e1;font-size:18px;line-height:1;cursor:pointer;}",
      "#rlb-card .head .head-actions{display:inline-flex;align-items:center;gap:4px;}",
      "#rlb-card .body{padding:16px;}",
      // Minimized: collapse to just the header bar (toggled by the ▾ button).
      "#rlb-card.min .body{display:none;}",
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
      "#rlb-card .actions button{width:100%;border:none;border-radius:9px;padding:11px 12px;font:700 13px/1 'Amazon Ember',-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;}",
      "#rlb-card .actions .primary{background:#2563eb;color:#fff;}",
      "#rlb-card .actions .ghost{background:#f1f5f9;color:#334155;}",
      "#rlb-card .actions button:disabled{opacity:.5;cursor:default;}",
      "#rlb-card .note{color:#94a3b8;font-size:12px;margin-top:12px;}",
      "#rlb-card .note.stale{color:#b45309;}",
      "#rlb-card .note.fallback{color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;line-height:1.4;}",
      "#rlb-card .adv{margin-top:12px;border-top:1px solid #eef2f6;padding-top:9px;}",
      "#rlb-card .adv summary{cursor:pointer;color:#94a3b8;font-size:12px;list-style:none;outline:none;}",
      "#rlb-card .adv summary::-webkit-details-marker{display:none;}",
      "#rlb-card .adv .tools{display:flex;flex-direction:column;gap:6px;margin-top:8px;}",
      "#rlb-card .adv .tools button{width:100%;background:#f1f5f9;color:#334155;border:none;border-radius:8px;padding:9px;font:600 12px/1 'Amazon Ember',-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;}",
      // Flash outline used when stepping through matched loads (data-attr = React-safe).
      // Matches the launcher button's teal so it reads as "this extension" feedback.
      "[data-rlb-flash]{outline:3px solid rgb(0,104,141)!important;outline-offset:-3px;}",
      // Drivers verification overlay (spot-check computed drop-offs vs Relay).
      // Drivers overlay restyled to match the dark hover tooltip (#rlb-tip):
      // near-black bg, full-white text, subtle dark separators, and warn rows
      // using the same red wash as the tooltip's lead rows.
      "#rlb-drivers{position:fixed;top:60px;left:16px;z-index:2147483200;background:#0b0f19;border:1px solid #1f2937;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);font:12px/1.4 'Amazon Ember',-apple-system,Segoe UI,Roboto,sans-serif;color:#fff;width:560px;max-width:92vw;max-height:70vh;display:flex;flex-direction:column;overflow:hidden;}",
      "#rlb-drivers .t{background:#0b0f19;color:#fff;font-weight:700;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;cursor:move;border-bottom:1px solid #1f2937;}",
      "#rlb-drivers .t button{background:transparent;color:#cbd5e1;border:none;font-size:16px;cursor:pointer;line-height:1;}",
      "#rlb-drivers .body{overflow:auto;padding:0;}",
      "#rlb-drivers table{width:100%;border-collapse:collapse;}",
      "#rlb-drivers th,#rlb-drivers td{padding:6px 10px;text-align:left;border-bottom:1px solid #1f2937;white-space:nowrap;color:#fff;}",
      "#rlb-drivers th{position:sticky;top:0;background:#0b0f19;font-weight:600;color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.04em;z-index:1;}",
      "#rlb-drivers tr.warn td{background:rgba(239,68,68,.16);color:#ff6b6b;}",
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
    btn.title = "Find loads for ALL your drivers — those finishing trips plus idle (unassigned) drivers.";
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

    // "Find loads for unassigned drivers" (👤) is hidden for now — the button is
    // not created, so it never appears and its handler never binds. The underlying
    // runUnassignedDriversAutopilot() flow is left intact for easy re-enabling:
    // just uncomment this block.
    // var btnUnassigned = document.createElement("button");
    // btnUnassigned.id = "rlb-launch-unassigned";
    // btnUnassigned.type = "button";
    // btnUnassigned.innerHTML = '<span class="bolt">👤</span><span class="lbl">Find loads for unassigned drivers</span>';
    // btnUnassigned.title = "Find loads ONLY for drivers with no current trip (idle / unassigned).";
    // document.body.appendChild(btnUnassigned);
    // btnUnassigned.addEventListener("click", function () {
    //   try {
    //     runUnassignedDriversAutopilot();
    //   } catch (e) {
    //     console.log("[RLB] launch (unassigned) error:", e);
    //     logError("launchUnassignedClick", e);
    //     try { showCard(); cardError("Couldn't start", (e && e.message) ? e.message : String(e)); } catch (e2) {}
    //     setLaunchBusy(false);
    //     autofillBusy = false;
    //   }
    // });

    // "Only my driver locations" filter — when checked, hide every load card that
    // isn't matched to one of your drivers. Reflects the persisted `onlyMyDrivers`
    // JS state (which survives SPA navigation) so it stays in sync if the panel is
    // rebuilt after a route change.
    var only = document.createElement("label");
    only.id = "rlb-only-mine";
    only.title = "Hide loads that don't match any of your drivers.";
    only.innerHTML = '<span class="rlb-switch"><input id="rlb-only-mine-cb" type="checkbox" /><span class="rlb-slider"></span></span><span>Only my driver locations</span>';
    document.body.appendChild(only);
    var onlyCb = only.querySelector("#rlb-only-mine-cb");
    onlyCb.checked = onlyMyDrivers;
    onlyCb.addEventListener("change", function () {
      onlyMyDrivers = onlyCb.checked;
      try { chrome.storage.local.set({ onlyMyDrivers: onlyMyDrivers }); } catch (e) { /* context invalidated */ }
      schedulePaint();
    });

    // "Refresh" toggle = the on-page Auto Refresh switch. Its checked state mirrors
    // arEnabled (set by reflectAutoRefreshToggle); clicking it writes arEnabled to
    // storage, which the storage.onChanged listener turns into start/stop. Placed
    // by positionOnlyMine; the countdown chip sits beside it.
    var fy = document.createElement("label");
    fy.id = "rlb-fleetyes-refresh";
    fy.title = "Auto refresh — refresh the board on a randomized timer";
    fy.innerHTML = '<span class="rlb-switch"><input id="rlb-fleetyes-refresh-cb" type="checkbox" /><span class="rlb-slider"></span></span><span>Auto Refresh</span>';
    document.body.appendChild(fy);
    var fyCb = fy.querySelector("#rlb-fleetyes-refresh-cb");
    fyCb.checked = arEnabled;
    fyCb.addEventListener("change", function () {
      try { chrome.storage.local.set({ arEnabled: !!fyCb.checked }); } catch (e) { /* context invalidated */ }
    });

    // Countdown chip: remaining seconds until the next auto-refresh, shown beside
    // the Refresh toggle. Text + visibility driven by the auto-refresh tick logic.
    var arCd = document.createElement("span");
    arCd.id = "rlb-ar-countdown";
    arCd.title = "Time until the next automatic refresh";
    document.body.appendChild(arCd);

    var card = document.createElement("div");
    card.id = "rlb-card";
    card.innerHTML =
      '<div class="head"><b>⚡ Best loads</b><span class="head-actions">' +
      '<button id="rlb-card-min" type="button" title="Minimize">▾</button>' +
      '<button id="rlb-card-x" type="button" title="Close">×</button></span></div>' +
      '<div class="body"><div id="rlb-card-content"></div></div>';
    document.body.appendChild(card);
    card.querySelector("#rlb-card-x").addEventListener("click", hideCard);
    var minBtn = card.querySelector("#rlb-card-min");
    if (minBtn) minBtn.addEventListener("click", toggleMinCard);

    positionLauncher();
    window.addEventListener("scroll", positionLauncher, true);
    window.addEventListener("resize", positionLauncher);

    // The "Only my driver locations" toggle is a fixed control next to the refresh
    // button at the bottom; the footer is viewport-fixed, so track resize (not
    // scroll). Retry once shortly after load — the utility bar renders after us.
    positionOnlyMine();
    window.addEventListener("resize", positionOnlyMine);
    window.setTimeout(positionOnlyMine, 1200);
  }

  // Anchor the floating launcher to the search panel's top-right so it reads as
  // part of the search area (we can't inject INTO the React panel without crashing
  // it, so we position a fixed button over it and keep it aligned on scroll/resize).
  // The second ("unassigned drivers") button sits immediately to its left, same row.
  function positionLauncher() {
    var b = document.getElementById("rlb-launch");
    var bf = document.getElementById("rlb-launch-unassigned");
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
    if (bf) {
      var br = b.getBoundingClientRect();
      bf.style.top = b.style.top;
      bf.style.right = Math.max(12, window.innerWidth - br.left + 10) + "px";
    }
    // NOTE: the "Only my driver locations" toggle used to be overlaid inline on
    // this search panel; it now lives as a fixed control next to the refresh
    // button at the bottom of the page — see positionOnlyMine below.
  }

  // Pin the "Only my driver locations" toggle as a fixed control next to Relay's
  // manual refresh button at the bottom of the page (inside .refresh-and-chat-box
  // / #utility-bar). That footer is viewport-fixed, so — unlike the launcher,
  // which tracks the scrolling search panel — this only runs on load + resize
  // (no scroll jitter). Falls back to the CSS bottom-right default until the
  // refresh control is present.
  // Find Relay's "Last updated …" timestamp in the footer utility bar — the
  // tightest element whose text contains "last updated". Returns null if absent.
  function findLastUpdatedEl() {
    var bar = document.getElementById("utility-bar") || document;
    var nodes = bar.querySelectorAll("*");
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var t = (n.textContent || "").trim();
      if (t && /last updated/i.test(t)) {
        if (!best || n.querySelectorAll("*").length < best.querySelectorAll("*").length) best = n;
      }
    }
    return best;
  }

  // Hide Relay's native "Last updated …" label + its countdown timer — the user's
  // "Refresh" chip takes that slot. Climb from the "last updated" text to the
  // tightest container that also holds the timer, stopping before a parent that
  // would swallow the auto-refresh toggle / chat button; also hide a right-side
  // timer sibling in a flat layout. Re-applied on repaint because Relay re-renders
  // the timer each second.
  function hideLastUpdated() {
    var el = findLastUpdatedEl();
    if (!el) return;
    var node = el;
    while (node.parentElement) {
      var p = node.parentElement;
      var pt = (p.textContent || "").toLowerCase();
      if (/auto[\s-]?refresh|chat|message|help|reload/.test(pt)) break;
      if (p.querySelectorAll("*").length > 6) break;
      node = p;
    }
    if (node.style.display !== "none") node.style.display = "none";
    var sib = node.nextElementSibling;
    while (sib) {
      var st = (sib.textContent || "").trim();
      if (st && /^\d/.test(st) && st.length <= 8) {
        if (sib.style.display !== "none") sib.style.display = "none";
        sib = sib.nextElementSibling;
      } else break;
    }
  }

  // Hide Relay's native "Turn on auto-refresh" toggle + its label — the user's
  // "Refresh" chip replaces that whole area. The switch stays in the DOM
  // (display:none) so ensureAutoRefreshOff can still click it off; we hide it
  // and the "…auto-refresh" label leaf.
  function hideAutoRefreshToggle() {
    var box = document.querySelector(".refresh-and-chat-box");
    if (!box) return;
    // The visible toggle is a painted slider that shares a wrapper with the
    // accessible switch — so hide the WRAPPER (climb from the switch to the box's
    // direct child), not just the switch input (which is often invisible on its
    // own). Relay's role isn't always literally "switch", so match a few shapes.
    var sw = box.querySelector('[role="switch"], [role="checkbox"], button[aria-checked="true"], button[aria-checked="false"]');
    if (sw) {
      var refreshBtn = findRelayRefreshControl();
      var sLab = (sw.getAttribute && (sw.getAttribute("aria-label") || sw.getAttribute("title"))) || (sw.textContent || "");
      // Never treat the refresh button or chat button as the toggle.
      if (sw !== refreshBtn && !/chat|message|help|support|reload/i.test(sLab)) {
        var node = sw;
        while (node && node.parentElement && node.parentElement !== box) node = node.parentElement;
        if (node && node !== box && node.style.display !== "none") node.style.display = "none";
      }
    }
    // Hide the "…auto-refresh" label leaf(s) — sometimes outside the wrapper.
    var nodes = box.querySelectorAll("*");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.children.length !== 0) continue;
      var lt = (n.textContent || "").trim().toLowerCase();
      if (lt && /auto[\s-]?refresh/.test(lt) && n.style.display !== "none") n.style.display = "none";
    }
  }

  function positionOnlyMine() {
    var only = document.getElementById("rlb-only-mine");
    if (!only) return;
    var fy = document.getElementById("rlb-fleetyes-refresh");
    var arCdEl = document.getElementById("rlb-ar-countdown");

    // Bottom row, left → right: Only my drivers | Refresh | "Next Refresh 7s" | refresh icon.
    // Position right → left so each chip anchors to the one on its right.
    var iconBtn = findRelayRefreshControl();
    var ir = iconBtn && iconBtn.getBoundingClientRect();
    var box2 = document.querySelector(".refresh-and-chat-box");
    var fr = box2 && box2.getBoundingClientRect();

    // SHIFT pulls the whole chip group this many px further LEFT of the refresh icon.
    // We anchor to a copy of the icon rect shifted SHIFT px right, so every chip
    // (directly or indirectly) anchored to it moves SHIFT px left — inter-chip gaps unchanged.
    var SHIFT = 16;
    var irS = ir ? { top: ir.top, height: ir.height, width: ir.width, bottom: ir.bottom, left: ir.left - SHIFT, right: ir.right - SHIFT } : null;

    // Place `el` immediately LEFT of `anchorRect` on the same baseline; gap is the
    // px between el's right edge and the anchor's left edge. Returns true if placed.
    function placeLeft(el, anchorRect, gap) {
      if (!el || !anchorRect || !anchorRect.width) return false;
      var h = el.offsetHeight || 34;
      el.style.top = Math.max(8, anchorRect.top + (anchorRect.height - h) / 2) + "px";
      el.style.left = "auto";
      el.style.right = Math.max(8, window.innerWidth - anchorRect.left + (gap || 8)) + "px";
      el.style.bottom = "auto";
      return true;
    }

    var haveIcon = ir && ir.width && ir.bottom > 0 && ir.top < window.innerHeight;
    var haveCluster = fr && fr.width && fr.bottom > 0 && fr.top < window.innerHeight;

    if (haveIcon) {
      // Countdown left of the (shifted) icon — positioned even while hidden, so ready.
      placeLeft(arCdEl, irS, 8);
      // Always reserve the countdown's slot (its stable width, even while hidden)
      // so the toggle never overlaps it. offsetWidth is 0 while display:none → fall
      // back to the CSS min-width (160), which matches the visible width. A few
      // extra px of margin absorb any small font/rounding variance so the toggle
      // group never crowds the timer's left edge.
      var cdW = ((arCdEl && arCdEl.offsetWidth) || 160) + 6;
      var cdSlot = { top: irS.top, height: irS.height, width: cdW, bottom: irS.bottom, left: irS.left - 8 - cdW, right: irS.left - 8 };
      var placedFy = placeLeft(fy, cdSlot, 8);
      // "Only my drivers" left of the Refresh toggle (or the icon if no toggle).
      placeLeft(only, (placedFy && fy) ? fy.getBoundingClientRect() : irS, 10);
    } else if (haveCluster && fy) {
      // No icon yet — anchor to the cluster's right edge (shifted, same idea as
      // the icon case) so the countdown still reserves its slot here too, instead
      // of overlapping fy at their shared CSS default position.
      var frS = { top: fr.top, height: fr.height, width: fr.width, bottom: fr.bottom, left: fr.right - SHIFT, right: fr.right - SHIFT };
      placeLeft(arCdEl, frS, 8);
      var cdWCluster = ((arCdEl && arCdEl.offsetWidth) || 160) + 6;
      var cdSlotCluster = { top: frS.top, height: frS.height, width: cdWCluster, bottom: frS.bottom, left: frS.left - 8 - cdWCluster, right: frS.left - 8 };
      var placedFyCluster = placeLeft(fy, cdSlotCluster, 8);
      placeLeft(only, (placedFyCluster && fy) ? fy.getBoundingClientRect() : frS, 10);
    } else {
      // Nothing to anchor to — Relay's refresh icon AND .refresh-and-chat-box are
      // both gone (e.g. it's removed from the DOM while "Find my best loads" runs).
      // only/fy/arCdEl all share the same CSS bottom-right default (bottom:14px;
      // right:22px), so clearing their inline styles used to stack all three
      // directly on top of each other — the countdown chip (lower z-index) landed
      // hidden behind the Auto Refresh toggle. Anchor to a synthetic corner rect
      // instead and lay them out left→right the same way the haveIcon branch does.
      var corner = { top: window.innerHeight - 14 - 34, height: 34, width: 1, bottom: window.innerHeight - 14, left: window.innerWidth - 22, right: window.innerWidth - 22 };
      placeLeft(arCdEl, corner, 8);
      var cdWFallback = ((arCdEl && arCdEl.offsetWidth) || 160) + 6;
      var cdSlotFallback = { top: corner.top, height: corner.height, width: cdWFallback, bottom: corner.bottom, left: corner.left - 8 - cdWFallback, right: corner.left - 8 };
      var placedFyFallback = placeLeft(fy, cdSlotFallback, 8);
      placeLeft(only, (placedFyFallback && fy) ? fy.getBoundingClientRect() : corner, 10);
    }
    hideLastUpdated();
    hideAutoRefreshToggle();
  }

  function showCard() {
    // A fresh show (e.g. clicking ⚡ again) re-expands a previously minimized card.
    var c = document.getElementById("rlb-card");
    if (c) { c.classList.add("show"); c.classList.remove("min"); }
    var mn = document.getElementById("rlb-card-min");
    if (mn) { mn.textContent = "▾"; mn.title = "Minimize"; }
  }
  function hideCard() { var c = document.getElementById("rlb-card"); if (c) c.classList.remove("show"); }
  // Collapse the card to just its header bar; click again to expand. Content is
  // kept (not cleared), so expanding restores whatever was showing.
  function toggleMinCard() {
    var c = document.getElementById("rlb-card");
    if (!c) return;
    var min = c.classList.toggle("min");
    var b = document.getElementById("rlb-card-min");
    if (b) { b.textContent = min ? "▸" : "▾"; b.title = min ? "Expand" : "Minimize"; }
  }
  function setCard(html) { var el = document.getElementById("rlb-card-content"); if (el) el.innerHTML = html; }
  // Both launcher buttons share one busy state — only one autopilot run
  // (of either kind) can be in flight at a time (see autofillBusy).
  function setLaunchBusy(on) {
    var b = document.getElementById("rlb-launch");
    var bf = document.getElementById("rlb-launch-unassigned");
    if (b) {
      b.classList.toggle("busy", !!on);
      b.disabled = !!on;
      var lbl = b.querySelector(".lbl");
      if (lbl) lbl.textContent = on ? "Working…" : "Find my best loads";
    }
    if (bf) {
      bf.classList.toggle("busy", !!on);
      bf.disabled = !!on;
      var lblf = bf.querySelector(".lbl");
      if (lblf) lblf.textContent = on ? "Working…" : "Find loads for unassigned drivers";
    }
  }

  // Live step list shown while the autopilot runs.
  function renderSteps(steps) {
    var html = steps.map(function (s) {
      var ic = s.state === "done" ? "✓" : (s.state === "active" ? '<span class="spin"></span>' : "○");
      return '<div class="step ' + s.state + '"><span class="ic">' + ic + "</span><span>" + esc(s.label) + "</span></div>";
    }).join("");
    setCard(html);
  }

  // Same steps list, but with the API-fallback banner shown ABOVE it — used the
  // moment we know the shifts API failed, before the Relay-fallback search runs.
  function renderStepsWithFallback(steps) {
    var stepsHtml = steps.map(function (s) {
      var ic = s.state === "done" ? "✓" : (s.state === "active" ? '<span class="spin"></span>' : "○");
      return '<div class="step ' + s.state + '"><span class="ic">' + ic + "</span><span>" + esc(s.label) + "</span></div>";
    }).join("");
    setCard(fallbackNoteHtml() + stepsHtml);
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
    if (r) r.addEventListener("click", function () {
      // Force fresh fetch + re-run whichever flow produced this card.
      if (lastMode === "unassigned") runUnassignedDriversAutopilot();
      else runAutopilot(true);
    });
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

  // Restore the persisted "only my driver locations" filter state, sync the
  // checkbox, and repaint so the filter takes effect on the current board.
  function loadOnlyMinePref() {
    try {
      chrome.storage.local.get(["onlyMyDrivers"], function (r) {
        onlyMyDrivers = !!r.onlyMyDrivers;
        var cb = document.getElementById("rlb-only-mine-cb");
        if (cb) cb.checked = onlyMyDrivers;
        schedulePaint();
      });
    } catch (e) { /* context invalidated */ }
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
            // "Free city" shows the DRIVER'S OWN end location (apiLocation) — where
            // they actually finish — not the Search Location the loads are searched
            // from. Fall back to raw coords, then the search city, then "—".
            var al = a.apiLocation || {};
            var driverCity = al.city
              ? esc(al.city)
              : (al.latitude != null && al.longitude != null
                  ? esc(n1(al.latitude) + ", " + n1(al.longitude))
                  : (fl.city ? esc(fl.city) : "—"));
            var freeCity = driverCity;
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

  // ── Phase 2: auto-fill origin & search, one round per driver drop-off city ──────
  // We dedupe driver drop-off cities and sort by soonest-free, then search them
  // one at a time, all in THIS browser tab: each round clicks Load Board's own
  // "+ New search" button (see resetForm) to get a clean origin box, types +
  // picks that one city from the autocomplete, clicks "Search loads", and shows
  // its result — so every city gets its own search (instead of being combined
  // into one multi-origin search) and its own Load Board search tab (instead of
  // a separate Chrome browser tab), switchable via the chips at the top of the
  // search panel.
  var batches = [];   // [[{city,country}], [{city,country}], …] — one city per round
  var roundIdx = 0;
  var autofillBusy = false;
  var lastMode = "all"; // "all" (runAutopilot) or "unassigned" (runUnassignedDriversAutopilot) — which one Advanced → Refresh drivers should re-run

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
  // Coordinates are set to the element's own center so any coordinate-based hit
  // testing (e.g. an "is this click inside/outside the popover" check) sees a
  // real position rather than the (0,0) default.
  function realClick(el) {
    if (!el) return;
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    var x = r ? r.left + r.width / 2 : 0;
    var y = r ? r.top + r.height / 2 : 0;
    ["pointerdown", "mousedown", "mouseup", "click"].forEach(function (type) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); } catch (e) {}
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

  // A tab that's been sitting open across repeated test runs accumulates its
  // own stray "New search" sessions in Relay's UI (visible as extra chips at
  // the top of the search panel) — Relay appears to keep each one's DOM
  // mounted, so a plain querySelector can silently grab a HIDDEN previous
  // session's input/button instead of the one actually on screen. Prefer a
  // visible match; fall back to the first match if nothing is visible.
  function isVisible(el) {
    return !!(el && el.offsetParent !== null);
  }
  function firstVisible(selector) {
    var els = document.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) { if (isVisible(els[i])) return els[i]; }
    return els[0] || null;
  }

  function findSearchButton() {
    var bs = document.querySelectorAll("button");
    var fallback = null;
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t === "search loads" || t.indexOf("search loads") !== -1) {
        if (isVisible(bs[i])) return bs[i];
        if (!fallback) fallback = bs[i];
      }
    }
    return fallback;
  }

  function originInput() {
    return firstVisible('#rlb-origin-city-filter input[role=combobox]') ||
      firstVisible('input[role=combobox][aria-labelledby*="origin"]') ||
      firstVisible('input[role=combobox][aria-autocomplete="list"]');
  }

  // Choose the best autocomplete option for a city. Typing "War" returns matches
  // across many countries and mid-word ("Newark"), so rank strictly and prefer UK.
  function bestOption(city) {
    var want = String(city).toLowerCase().trim();
    var opts = document.querySelectorAll('[role="option"][aria-label]');
    var best = null, bestRank = 99;
    for (var i = 0; i < opts.length; i++) {
      if (!isVisible(opts[i])) continue; // skip options left over from a stale/hidden popover
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
    realClick(input); // a cold combobox may only open its listbox on a real click
    nativeSetValue(input, city);
    return waitFor(function () { return bestOption(city); }, 5000, 150).then(function (opt) {
      realClick(opt);
      return delay(400); // typing the next city overwrites the text; no manual clear
    });
  }

  // First query after a page load is often cold (autocomplete backend + lazy
  // UI chunks), so a single attempt can time out even though the very next one
  // succeeds — retype once before giving up. Resolves true/false, never rejects.
  function selectOriginWithRetry(city) {
    return selectOneOrigin(city).then(function () { return true; }, function (e1) {
      console.log("[RLB fill] retrying", city, "(" + ((e1 && e1.message) || e1) + ")");
      return delay(600).then(function () { return selectOneOrigin(city); }).then(
        function () { return true; },
        function (e2) {
          logError("fillBatch/selectOrigin", e2, { city: city });
          return false;
        }
      );
    });
  }

  // The "+ New search" button that opens a fresh Load Board search tab isn't
  // uniquely identifiable by its CSS class — Relay reuses the same generated
  // class (e.g. "css-pevixi") on an unrelated button ("no-results__create-pat-
  // link", shown on a zero-results page). Match by exact visible text instead,
  // and explicitly skip anything whose class marks it as that other button.
  function findNewSearchButton() {
    var bs = document.querySelectorAll("button");
    var fallback = null;
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].textContent || "").replace(/\s+/g, " ").trim();
      if (t !== "New search") continue;
      if (/no-results/i.test(bs[i].className || "")) continue; // the other "New search"-labelled button
      if (isVisible(bs[i])) return bs[i];
      if (!fallback) fallback = bs[i];
    }
    return fallback;
  }

  // Reset to a clean form (empty origins) via Load Board's own "+ New search"
  // button — this opens a fresh internal search tab rather than reusing the
  // current one. On a fresh form the board does NOT auto-search until we click
  // "Search loads", so we get exactly one search per round.
  function resetForm() {
    var nb = findNewSearchButton();
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

  // How far around the origin to search (miles). "New search" resets this to
  // Relay's own default (50), so every round has to re-select it, same as Equipment.
  var SEARCH_RADIUS_MI = 250;

  function radiusBox() {
    return document.getElementById("rlb-origin-radius-filter");
  }
  function radiusValueEl() {
    return document.getElementById("rlb-origin-radius-filter-value");
  }
  function currentRadius() {
    var el = radiusValueEl();
    var v = el ? parseInt((el.textContent || "").trim(), 10) : NaN;
    return isNaN(v) ? null : v;
  }
  function radiusListbox() {
    var box = radiusBox();
    var id = box && box.getAttribute("aria-controls");
    return id ? document.getElementById(id) : null;
  }
  // Radius options render as plain numbers (possibly with a "mi" suffix) —
  // read the leading integer so the exact label text doesn't matter.
  function optionRadiusValue(opt) {
    var t = (opt.textContent || "").replace(/\s+/g, " ").trim();
    var m = /^(\d+)/.exec(t);
    return m ? parseInt(m[1], 10) : null;
  }
  function findRadiusOption(value) {
    var lb = radiusListbox();
    if (!lb) return null;
    var opts = lb.querySelectorAll('[role="option"]');
    for (var i = 0; i < opts.length; i++) {
      if (isVisible(opts[i]) && optionRadiusValue(opts[i]) === value) return opts[i];
    }
    return null;
  }
  function openRadius() {
    var box = radiusBox();
    if (!box) return Promise.reject(new Error("radius box not found"));
    realClick(box);
    return waitFor(function () { return findRadiusOption(SEARCH_RADIUS_MI) || radiusListbox(); }, 1500, 100);
  }

  // Unlike the origin/equipment popovers (which close on an outside mousedown —
  // Escape isn't wired for any of these MDN popovers, see clickOutside above),
  // this one is a toggle-style combobox: the box itself flips aria-expanded
  // open/closed on click, same as it did to open it. Click it again to close;
  // fall back to an outside click if aria-expanded says it's still open.
  function closeRadiusPopover() {
    var box = radiusBox();
    if (box && box.getAttribute("aria-expanded") === "true") {
      realClick(box);
      return delay(300).then(function () {
        var b = radiusBox();
        if (b && b.getAttribute("aria-expanded") === "true") {
          clickOutside();
          return delay(300);
        }
      });
    }
    clickOutside();
    return delay(300);
  }

  // "New search" leaves Radius at Relay's default (50) — force it to
  // SEARCH_RADIUS_MI every round, same reasoning as setEquipment above.
  function setRadius() {
    if (currentRadius() === SEARCH_RADIUS_MI) return Promise.resolve(); // already correct
    return openRadius().then(function () {
      var opt = findRadiusOption(SEARCH_RADIUS_MI);
      if (!opt) { console.log("[RLB fill] radius option " + SEARCH_RADIUS_MI + " not found"); return; }
      realClick(opt);
      return delay(300);
    }).then(function () {
      return closeRadiusPopover();
    }).then(function () {
      if (currentRadius() !== SEARCH_RADIUS_MI) {
        console.log("[RLB fill] radius shows " + currentRadius() + " after selecting " + SEARCH_RADIUS_MI + " — leaving as-is");
      }
    }).catch(function (e) {
      console.log("[RLB fill] radius select failed:", e && e.message);
    });
  }

  // Fill a batch of cities, then trigger the search once. We close the origin
  // dropdown before touching equipment (a stuck-open dropdown swallows the click),
  // and close overlays again before pressing Search loads.
  // How many of the batch's cities are visibly selected in the origin box.
  // Clicking a suggestion can silently not stick on a cold form, so we check
  // the DOM (box text or input value) rather than trusting the click.
  function countOriginsSelected(cities) {
    var input = originInput();
    var box = (input && (input.closest("#rlb-origin-city-filter") || input.parentElement)) ||
      document.getElementById("rlb-origin-city-filter");
    var txt = (((box && box.textContent) || "") + " " + ((input && input.value) || "")).toLowerCase();
    return cities.filter(function (c) { return txt.indexOf(String(c).toLowerCase()) !== -1; }).length;
  }

  // The origin box's already-selected cities render as one plain comma-joined
  // string in a sibling <div id="rlb-origin-city-filter-value" mdn-select-
  // value> — there is no separate per-city "×" to click. Clicking a city
  // again in the open dropdown is how a real user deselects it (same as a
  // checkbox toggle), so we open the listbox this input actually points to
  // (via its own aria-controls — the id is React-generated and differs per
  // render, so we read it live rather than hardcode it) and click off
  // whatever it reports as currently selected.
  function originBoxText() {
    var input = originInput();
    var box = (input && (input.closest("#rlb-origin-city-filter") || input.parentElement)) ||
      document.getElementById("rlb-origin-city-filter");
    return ((box && box.textContent) || "").replace(/\s+/g, " ").trim();
  }
  function originListbox(input) {
    var id = input && input.getAttribute("aria-controls");
    return id ? document.getElementById(id) : null;
  }
  function findSelectedOriginOption(listbox) {
    if (!listbox) return null;
    // Try the standard ARIA attribute first, then fall back to other common
    // "this option is selected" patterns in case this widget doesn't use it.
    return listbox.querySelector('[role="option"][aria-selected="true"]') ||
      listbox.querySelector('[role="option"][aria-checked="true"]') ||
      listbox.querySelector('[role="option"][class*="selected" i]');
  }
  function clearOriginSelections() {
    var before = originBoxText();
    if (!before) return Promise.resolve(); // already empty — nothing to clear
    var input = originInput();
    if (!input) return Promise.resolve();
    input.focus();
    realClick(input); // open the listbox (same trick used for a cold combobox elsewhere)
    var chain = delay(350); // let the listbox actually open/populate
    for (var pass = 0; pass < 6; pass++) {
      chain = chain.then(function () {
        var opt = findSelectedOriginOption(originListbox(input));
        if (!opt) return null;
        realClick(opt);
        return delay(250);
      });
    }
    return chain.then(function () {
      var after = originBoxText();
      if (after) {
        console.log("[RLB fill] origin box still shows content after clearing — before: \"" + before + "\" after: \"" + after + "\"");
      } else {
        console.log("[RLB fill] cleared stale origin selection: \"" + before + "\"");
      }
    });
  }

  // Reset the form and fill the origin cities. Resolves with
  // { clicked: <suggestions clicked>, verified: <cities visible in the box> }.
  function fillOrigins(cities) {
    return resetForm().then(function () {
      // "New search" mounts the form lazily — on the first run after a page
      // load the fixed post-click delay isn't enough, so wait until the origin
      // combobox actually exists before typing into it.
      return waitFor(originInput, 8000, 200).catch(function () {
        throw new Error("The search form didn't finish loading (origin box never appeared). Reload the page and try again.");
      });
    }).then(function () {
      return clearOriginSelections(); // strip anything carried over from the previous round's tab
    }).then(function () {
      var clicked = 0;
      var chain = Promise.resolve();
      cities.forEach(function (c) {
        chain = chain.then(function () {
          return selectOriginWithRetry(c).then(function (ok) { if (ok) clicked++; });
        });
      });
      return chain.then(function () { return delay(300); }).then(function () {
        return { clicked: clicked, verified: countOriginsSelected(cities) };
      });
    });
  }

  function fillBatch(cities) {
    return fillOrigins(cities).then(function (r) {
      if (r.verified > 0) return r;
      // Nothing stuck (typical on the first run after a page load, while the
      // form is still cold) — redo the whole fill once before giving up.
      console.log("[RLB fill] no origins stuck (clicked " + r.clicked + ") — redoing the fill once");
      return fillOrigins(cities);
    }).then(function (r) {
      // Never search with an empty origin: Relay would return 0 results and
      // the card would report a misleading "0 loads match your drivers".
      if (!r.verified && !r.clicked) {
        throw new Error("Couldn't select any origin city — the page's autocomplete didn't respond. Click the launcher to try again.");
      }
      if (!r.verified) {
        // Suggestions were clicked but we can't see them in the box — possibly
        // just a rendering difference, so proceed rather than hard-fail.
        console.log("[RLB fill] origins clicked (" + r.clicked + ") but not visible in the box — proceeding");
      } else if (r.verified < cities.length) {
        console.log("[RLB fill] only " + r.verified + "/" + cities.length + " origin cities selected — searching with those");
      }
      return closeOverlays(); // dismiss the origin dropdown before Radius
    }).then(function () {
      // Radius before Equipment: Relay auto-fires a live search on each filter
      // change, and Equipment is the field that actually completes the required
      // set — setting Radius first means that auto-search already sees 250
      // instead of firing once at the stale default (50) and again at 250.
      return setRadius(); // New search resets radius to Relay's default; force ours
    }).then(function () {
      return closeOverlays(); // dismiss the radius popover before Equipment
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

  // Dedupe drivers down to their unique drop-off cities, soonest-free first —
  // one entry per city, one round per entry.
  function buildCityList(list) {
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
    return cities;
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
        // Carrier code comes from Relay's own page (#case-carrier-scac), not the
        // popup — pass it to the background, which has no DOM access.
        var carrierCode = readCarrierCode();
        chrome.runtime.sendMessage({ type: "refresh-availability", carrierCode: carrierCode }, function (res) {
          if (chrome.runtime.lastError || !res || !res.ok) {
            var msg = (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "unknown failure";
            logError("refreshDriversAsync", msg);
            lastDriverError = msg;
            lastDriverErrorConfig = !!(res && res.config);
            resolve(0);
            return;
          }
          lastDriverError = null;
          lastDriverErrorConfig = false;
          driverCount = res.count || 0; driverAt = Date.now();
          lastAvailabilitySource = res.source || "schedule-api";
          lastApiError = res.apiError || null;
          // Log which availability source ran so a silent fallback to Relay trips
          // (instead of the shifts API) is obvious in the page console.
          if (res.source === "relay-trips-fallback") {
            console.warn("[RLB board] availability SOURCE = Relay trips (fallback) — shifts API failed:", res.apiError || "(no reason)");
          } else {
            console.log("[RLB board] availability SOURCE = " + (res.source || "schedule-api") + " — " + driverCount + " driver(s).");
          }
          resolve(driverCount);
        });
      } catch (e) { lastDriverError = (e && e.message) || String(e); logError("refreshDriversAsync", e); resolve(0); }
    });
  }

  // Same shape as refreshDriversAsync, but writes to its OWN storage key
  // (plannerAvailabilityUnassigned, via background.js's
  // refreshUnassignedDriversOnly) instead of the shared plannerAvailability
  // — so this button and "Find my best loads" never clobber each other's
  // cached data.
  function refreshUnassignedDriversAsync() {
    return new Promise(function (resolve) {
      try {
        var carrierCode = readCarrierCode();
        chrome.runtime.sendMessage({ type: "refresh-unassigned-drivers", carrierCode: carrierCode }, function (res) {
          if (chrome.runtime.lastError || !res || !res.ok) {
            var msg = (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "unknown failure";
            logError("refreshUnassignedDriversAsync", msg);
            lastDriverError = msg;
            resolve(0);
            return;
          }
          lastDriverError = null;
          driverCount = res.count || 0; driverAt = Date.now();
          if (res.source === "relay-unassigned-fallback") {
            console.warn("[RLB board] unassigned availability SOURCE = Relay (fallback) — shifts API failed:", res.apiError || "(no reason)");
          } else {
            console.log("[RLB board] unassigned availability SOURCE = " + (res.source || "schedule-api") + " — " + driverCount + " driver(s).");
          }
          resolve(driverCount);
        });
      } catch (e) { lastDriverError = (e && e.message) || String(e); logError("refreshUnassignedDriversAsync", e); resolve(0); }
    });
  }
  function getAvailability() {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(["plannerAvailability"], function (r) { resolve(r.plannerAvailability || []); }); }
      catch (e) { logError("getAvailability", e); resolve([]); }
    });
  }
  function getUnassignedAvailability() {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(["plannerAvailabilityUnassigned"], function (r) { resolve(r.plannerAvailabilityUnassigned || []); }); }
      catch (e) { logError("getUnassignedAvailability", e); resolve([]); }
    });
  }

  // Steps shown while a round's fetch/search/match sequence runs.
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
        chrome.storage.local.get(
          ["plannerAvailability", "plannerAvailabilityAt", "plannerAvailabilitySearchLocation", "searchLocation", "plannerAvailabilitySource"],
          function (r) {
            var cachedLoc = (r.plannerAvailabilitySearchLocation || "").trim().toLowerCase();
            var currentLoc = (r.searchLocation || "").trim().toLowerCase();
            resolve({
              count: (r.plannerAvailability || []).length,
              at: r.plannerAvailabilityAt || null,
              source: r.plannerAvailabilitySource || null,
              // Cache is stale if it was built for a different Search Location.
              searchLocationChanged: cachedLoc !== currentLoc,
            });
          }
        );
      } catch (e) { resolve({ count: 0, at: null, searchLocationChanged: false }); }
    });
  }

  // Reuse the last-fetched driver availability by default (no traffic); only fetch
  // when there is none, when forced via Advanced → Refresh drivers, or when the
  // Search Location setting changed since the cache was built.
  function ensureDrivers(steps, force) {
    return loadAvailabilityMeta().then(function (meta) {
      if (meta.searchLocationChanged && meta.count > 0) {
        console.log("[RLB board] Search Location changed since last fetch — refreshing availability.");
      }
      var reuse = !force && meta.count > 0 && !meta.searchLocationChanged;
      if (reuse) {
        steps[0].state = "done";
        steps[0].label = "Using driver details (as of " + dtUK(meta.at) + ")" + (isStale(meta.at) ? " ⚠ may be old" : "");
        steps[1].state = "done"; steps[1].label = "Availability ready";
        renderSteps(steps);
        return meta;
      }
      steps[0].state = "active"; steps[0].label = force ? "Refreshing driver details" : "Fetching driver details";
      renderSteps(steps);
      // Pull the latest planning rules / scoring weights from FleetYes (rlb-settings)
      // BEFORE fetching drivers, so the fresh availability is built + scored with the
      // current server settings. Best-effort — a sync failure never blocks the fetch.
      return syncSettingsAsync().then(function () {
        return refreshDriversAsync().then(function (count) {
          steps[0].state = "done"; steps[1].state = "done"; renderSteps(steps);
          return { count: count, at: Date.now() };
        });
      });
    });
  }

  // Fetch/read driver availability, then search every unique driver drop-off
  // city one round at a time, all in THIS tab: each round gets its own Load
  // Board "+ New search" tab (see resetForm), so results for every city stay
  // one click away via the chips at the top of the search panel — no separate
  // Chrome browser tabs involved.
  function runAutopilot(force) {
    if (autofillBusy) return;
    autofillBusy = true;
    lastMode = "all";
    showCard();
    setLaunchBusy(true);
    var steps = autopilotSteps(false);
    renderSteps(steps);

    // Every "Find my best loads" click fetches FRESH — always re-sync settings and
    // re-call the drivers API rather than reusing the cached availability, so the
    // results reflect the current FleetYes settings + shifts on each run.
    ensureDrivers(steps, true).then(function (meta) {
      if (!meta || !meta.count) {
        if (lastDriverErrorConfig) {
          // Missing settings (carrier code / token / search location) — point the
          // user straight at settings, not the Trips page.
          cardError("Setup needed", lastDriverError + " Open the extension popup to configure it, then try again.");
        } else {
          var reason = lastDriverError ? ("Reason: " + lastDriverError + ". ") : "";
          cardError("No drivers found.", reason + "Open your Trips / In-Transit page once so we can read them, then use Advanced → Refresh drivers.");
        }
        return null;
      }
      driverCount = meta.count; driverAt = meta.at;
      // When drivers were reused from cache (no fresh refresh), refreshDriversAsync
      // didn't run, so pull the source from the cached meta so the fallback banner
      // still reflects how those drivers were actually obtained.
      if (meta.source) lastAvailabilitySource = meta.source;
      return getAvailability().then(function (list) {
        var cities = buildCityList(list);
        if (!cities.length) { cardError("No drivers to search from.", "None of your drivers had a usable drop-off location (Advanced → View drivers)."); return null; }

        batches = cities.map(function (c) { return [{ city: c.city, country: c.country || null }]; });
        roundIdx = 0;
        // If the shifts API failed and we're on the Relay-trips fallback, surface the
        // reason on the card NOW — before the fallback searches start — so the user
        // sees why we're searching Relay driver locations instead of the Search
        // Location. Brief pause so the banner is readable before tabs start opening.
        if (lastAvailabilitySource === "relay-trips-fallback") {
          renderStepsWithFallback(steps);
          return delay(1600).then(function () { return runAllRounds(steps, cities); });
        }
        return runAllRounds(steps, cities);
      });
    }).catch(function (e) {
      logError("runAutopilot", e);
      cardError("Something went wrong.", (e && e.message) ? e.message : String(e));
    }).then(function () {
      setLaunchBusy(false);
      autofillBusy = false;
    });
  }

  // Same overall flow as runAutopilot, but sourced from the dedicated
  // plannerAvailabilityUnassigned key (see getUnassignedAvailability) instead
  // of the shared plannerAvailability. Always does a fresh fetch: "unassigned
  // right now" is a live/volatile fact that a stale cached list can't answer,
  // so there's no cache-reuse path here (unlike runAutopilot/ensureDrivers).
  function runUnassignedDriversAutopilot() {
    if (autofillBusy) return;
    autofillBusy = true;
    lastMode = "unassigned";
    showCard();
    setLaunchBusy(true);
    var steps = autopilotSteps(false);
    steps[0].label = "Fetching unassigned drivers";
    renderSteps(steps);

    refreshUnassignedDriversAsync().then(function (count) {
      steps[0].state = "done"; steps[1].state = "done"; renderSteps(steps);
      if (!count) {
        var reason = lastDriverError ? ("Reason: " + lastDriverError + ". ") : "";
        cardError("No unassigned drivers found.", reason + "Every driver may currently be on a trip, or none had a resolvable domicile city.");
        return null;
      }
      driverCount = count; driverAt = Date.now();
      return getUnassignedAvailability().then(function (list) {
        var cities = buildCityList(list);
        if (!cities.length) { cardError("No unassigned drivers to search from.", "None of the unassigned drivers had a resolvable domicile city."); return null; }

        batches = cities.map(function (c) { return [{ city: c.city, country: c.country || null }]; });
        roundIdx = 0;
        return runAllRounds(steps, cities);
      });
    }).catch(function (e) {
      logError("runUnassignedDriversAutopilot", e);
      cardError("Something went wrong.", (e && e.message) ? e.message : String(e));
    }).then(function () {
      setLaunchBusy(false);
      autofillBusy = false;
    });
  }

  // Pace between rounds — firing search after search back-to-back with no gap
  // reads as automated traffic and is what got the account flagged. A plain
  // human pause between locations is cheap insurance against that.
  var ROUND_DELAY_MS = 30000;

  // Run every city's round, pacing ROUND_DELAY_MS between each one.
  // showRoundResult overwrites the card with each round's own result as it
  // completes; once the last one is done, append a summary noting every
  // location that was searched (each has its own Load Board search tab by then).
  function runAllRounds(steps, cities) {
    return runAutoRound(steps).then(function () {
      if (roundIdx + 1 >= batches.length) {
        if (cities.length > 1) announceOtherRounds(cities);
        return;
      }
      roundIdx++;
      var nextSteps = autopilotSteps(true);
      nextSteps[2].label = "Waiting " + Math.round(ROUND_DELAY_MS / 1000) + "s before the next search…";
      renderSteps(nextSteps);
      return delay(ROUND_DELAY_MS).then(function () {
        return runAllRounds(nextSteps, cities);
      });
    });
  }

  // Append a note to the (already-shown) final round's result card listing
  // every location searched, without disturbing the match results / buttons
  // showRoundResult already rendered and wired up.
  function announceOtherRounds(cities) {
    var host = document.getElementById("rlb-card-content");
    if (!host) return;
    var html =
      '<div class="note">Searched ' + cities.length + " driver locations (" +
      esc(cities.map(function (c) { return c.city; }).join(", ")) +
      ") — each has its own “New search” tab at the top of the page. Switch tabs to see each one’s matches.</div>";
    var adv = host.querySelector(".adv");
    if (adv) adv.insertAdjacentHTML("beforebegin", html);
    else host.insertAdjacentHTML("beforeend", html);
  }

  function runAutoRound(steps) {
    var cities = batches[roundIdx].map(function (b) { return b.city; });
    steps[2].state = "active";
    steps[2].label = "Searching loads near " + cities.join(", ") +
      (batches.length > 1 ? " (" + (roundIdx + 1) + " of " + batches.length + ")" : "");
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

  // When the shifts API failed and we fell back to Relay trips, explain WHY on the
  // card so the user knows the driver list came from Relay (their trip drop-offs),
  // not the FleetYes schedule + Search Location. Empty string when the API worked.
  function fallbackNoteHtml() {
    if (lastAvailabilitySource !== "relay-trips-fallback") return "";
    return (
      '<div class="note fallback">⚠ Driver shifts unavailable' +
      (lastApiError ? " (" + esc(lastApiError) + ")" : "") +
      " — likely no drivers set up for this carrier in FleetYes, or the carrier isn’t registered yet. " +
      "Showing drivers read from Relay trips instead, searched from each driver’s own location.</div>"
    );
  }

  function showRoundResult(cities) {
    var n = countHighlighted();
    var roundLabel = batches.length > 1 ? ("Location " + (roundIdx + 1) + " of " + batches.length + " · ") : "";
    setCard(
      '<div class="result' + (n ? "" : " zero") + '">' +
      '<div class="n">' + n + "</div>" +
      '<div class="lbl">' + (n === 1 ? "load matches your drivers" : "loads match your drivers") + "</div>" +
      '<div class="rnd">' + roundLabel + esc(cities.join(", ")) + "</div>" +
      "</div>" +
      '<div class="actions">' +
      (n ? '<button class="primary" id="rlb-a-step">Show matches ▸</button>' : "") +
      '<button class="ghost" id="rlb-a-done">Done</button>' +
      "</div>" +
      '<div class="note' + (isStale(driverAt) ? " stale" : "") + '">Drivers as of ' + esc(dtUK(driverAt)) +
      (isStale(driverAt) ? " · may be out of date — Advanced → Refresh drivers" : "") + "</div>" +
      fallbackNoteHtml() +
      advancedHtml()
    );
    matchList = [].slice.call(document.querySelectorAll("[data-rlb-match]"));
    matchPos = 0;
    var step = document.getElementById("rlb-a-step");
    var done = document.getElementById("rlb-a-done");
    if (step) step.addEventListener("click", stepMatch);
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

  // Read the carrier SCAC that Relay embeds in a hidden input on every page.
  // <input type="hidden" id="case-carrier-scac" value="AMYSL" …>
  function readCarrierCode() {
    var el = document.getElementById("case-carrier-scac");
    var v = el && el.value ? String(el.value).trim() : "";
    return v || null;
  }

  // Pull the latest RLB settings for this carrier from FleetYes and merge them
  // into the extension's storage before a run, so scoring uses server values.
  // Best-effort: a failure here must not block the drivers refresh — we log it
  // and carry on with whatever settings are already in storage.
  function syncSettings(done) {
    var carrierCode = readCarrierCode();
    if (!carrierCode) {
      logError("syncSettings", "carrier code not found on page (#case-carrier-scac)");
      done();
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "sync-rlb-settings", carrierCode: carrierCode }, function (res) {
        if (chrome.runtime.lastError || !res || !res.ok) {
          var msg = (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "failed";
          logError("syncSettings", msg);
        } else {
          console.log("[RLB board] rlb-settings synced (" + (res.applied != null ? res.applied + " key(s)" : "ok") + ").");
        }
        done();
      });
    } catch (e) {
      logError("syncSettings", e);
      done();
    }
  }

  // Promise wrapper around syncSettings — resolves once the sync completes
  // (success OR best-effort failure), so the autopilot can await it before fetching.
  function syncSettingsAsync() {
    return new Promise(function (resolve) {
      try { syncSettings(resolve); } catch (e) { logError("syncSettingsAsync", e); resolve(); }
    });
  }

  function refreshDrivers() {
    var btn = document.getElementById("rlb-refresh");
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    setPanel("rlb-msg", "Syncing settings…");
    // Sync server settings first, then fetch trips with those settings applied.
    syncSettings(function () {
    setPanel("rlb-msg", "Fetching trips…");
    try {
      var carrierCode = readCarrierCode();
      chrome.runtime.sendMessage({ type: "refresh-availability", carrierCode: carrierCode }, function (res) {
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
    }); // end syncSettings
  }

  // ── scoring ────────────────────────────────────────────────────────────────────
  function scoreAndPaint(loads) {
    lastLoads = loads;
    setPanel("rlb-seen", String(loads.length));
    try {
      chrome.runtime.sendMessage({ type: "score-loads", loads: loads, mode: lastMode }, function (res) {
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
      m[j].removeAttribute("data-rlb-lead");
      m[j].__rlbInfo = null;
    }
    // Reveal anything the "only my drivers" filter hid — doPaint re-hides as needed.
    var h = document.querySelectorAll("[data-rlb-hidden]");
    for (var k = 0; k < h.length; k++) h[k].removeAttribute("data-rlb-hidden");
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
  // Find the "Live" status label inside a card — a leaf element whose own text is
  // exactly "Live". Used to anchor the EARLY badge on the same row, just after it.
  function findLiveEl(card) {
    var els = card.querySelectorAll("*");
    for (var i = 0; i < els.length; i++) {
      if ((els[i].textContent || "").replace(/\s+/g, " ").trim() === "Live") return els[i];
    }
    return null;
  }
  // Place the EARLY badge (the card's ::before) on the status row, immediately
  // right of the "Live" label — i.e. between Live and the Amount. Computed from the
  // live rects so it tracks the real layout; scroll-invariant (::before is absolute
  // within the card). Falls back to bottom-right if "Live" isn't found.
  function positionEarlyBadge(card) {
    var cr = card.getBoundingClientRect();
    var live = findLiveEl(card);
    var left, top;
    if (live) {
      var lr = live.getBoundingClientRect();
      left = (lr.right - cr.left) + 6;                 // just right of "Live"
      top = (lr.top - cr.top) + (lr.height - 18) / 2;  // center on the row (~badge height 18)
    } else {
      left = cr.width - 64; top = cr.height - 22;      // fallback: bottom-right
    }
    card.style.setProperty("--rlb-early-left", left + "px");
    card.style.setProperty("--rlb-early-top", top + "px");
  }
  function doPaint() {
    if (!onLoadboard()) return; // injected on all Relay pages; only act on the board
    ensurePanel();
    positionLauncher();
    ensureAutoRefreshOff();
    hideLastUpdated();
    hideAutoRefreshToggle();
    var rows = loadRows();
    setPanel("rlb-rows", String(rows.length));
    clearPaint();
    // Only hide non-matching cards once we actually have scored loads — otherwise
    // (e.g. before the first search is scored) the whole board would blank out.
    var haveScores = false;
    for (var k in latest) { if (Object.prototype.hasOwnProperty.call(latest, k)) { haveScores = true; break; } }
    var hideOthers = onlyMyDrivers && haveScores;
    // Filter on → drop the highlight styling (outline/tint/badge) via CSS; see the
    // "html[data-rlb-filter]" rules. The match attributes themselves stay for counting.
    if (onlyMyDrivers) document.documentElement.setAttribute("data-rlb-filter", "1");
    else document.documentElement.removeAttribute("data-rlb-filter");
    var matched = 0;
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i].el;
      var info = latest[rows[i].id];
      var target = (el.closest && el.closest(".load-card")) || el;
      if (!info) {
        if (hideOthers) target.setAttribute("data-rlb-hidden", "1");
        continue;
      }
      matched++;
      target.setAttribute("data-rlb-match", info.bestScore >= 0.85 ? "strong" : "weak");
      target.setAttribute("data-rlb-badge", "▲ " + info.driverCount + (info.driverCount === 1 ? " driver" : " drivers"));
      // EARLY badge when ≥1 driver matches via the lead (pickup before drop-off).
      if ((info.suitableDrivers || []).some(function (d) { return driverUsesLead(info, d); })) {
        target.setAttribute("data-rlb-lead", "1");
        positionEarlyBadge(target); // place on the status row, just right of "Live"
      }
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

  // ── manual auto-refresh (our own timer) ──────────────────────────────────────
  // Relay's native auto-refresh stays off; instead WE click Relay's manual
  // "refresh" control on a repeating timer, each cycle waiting a random number of
  // seconds in [arMin, arMax]. Clicking Relay's own control re-runs its real
  // search, whose response flows back through hook.js → gets re-scored and
  // re-painted automatically (same pipeline as pagination/live search).

  // Locate Relay's manual refresh control. It's ICON-ONLY (an <svg aria-hidden>
  // inside a <button> with no text/aria-label), so text matching can't find it.
  // Its stable landmark is the ".refresh-and-chat-box" wrapper inside #utility-bar,
  // which holds the "Turn on auto-refresh" label + the refresh button (+ chat).
  // We target the refresh button structurally, and never the auto-refresh toggle.
  function findRelayRefreshControl() {
    var norm = function (s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase(); };
    var bar = document.getElementById("utility-bar") || document;
    var box = (bar.querySelector && bar.querySelector(".refresh-and-chat-box")) ||
              document.querySelector(".refresh-and-chat-box") || bar;

    // The native auto-refresh control is the switch (or the <p>"…auto-refresh"</p>'s
    // associated control) — exclude anything tied to it.
    var autoSwitch = box.querySelector && box.querySelector('input[role="switch"], [role="switch"]');

    var buttons = [].slice.call(box.querySelectorAll ? box.querySelectorAll('button, [role="button"]') : []);
    var refreshBtn = null;
    for (var i = 0; i < buttons.length; i++) {
      var el = buttons[i];
      if (autoSwitch && (el === autoSwitch || el.contains(autoSwitch) || (autoSwitch.contains && autoSwitch.contains(el)))) continue;
      var label = norm((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || el.textContent);
      // Skip the auto-refresh toggle and the chat button — leave only refresh.
      if (/auto[\s-]?refresh/.test(label)) continue;
      if (/chat|message|help|support/.test(label)) continue;
      // First non-excluded button in this box is the refresh control. Prefer one
      // whose label/testid explicitly says refresh/reload if present, else take it.
      if (/refresh|reload/.test(label) || /refresh|reload/.test(norm(el.getAttribute && el.getAttribute("data-testid")))) {
        return el;
      }
      if (!refreshBtn) refreshBtn = el; // icon-only fallback (no label at all)
    }
    return refreshBtn;
  }

  // Fire one refresh: click Relay's control if found. Returns true if it clicked.
  // Clicking refresh re-runs Relay's own /loadboard/search; hook.js intercepts the
  // response and bridge.js buffers it into lastSearchLoads/lastSearchAt. But that
  // buffered search is NOT guaranteed to reach our RLB_SEARCH message listener on a
  // manual refresh, so new loads would never get scored/highlighted. To close that
  // gap we schedule an explicit re-score: after a short delay (for Relay to
  // fetch+render), read the freshest buffered search and run it through the SAME
  // scoreAndPaint path the launcher uses — so newly-arrived loads that match a
  // driver get highlighted just like on the initial search.
  function doAutoRefresh() {
    if (!onLoadboard()) return false;
    var ctrl = findRelayRefreshControl();
    if (!ctrl) return false;
    try { ctrl.click(); }
    catch (e) { logError("autoRefreshClick", e); return false; }
    scheduleRescoreAfterRefresh();
    return true;
  }

  // After a refresh, re-score the newest intercepted search so new matching loads
  // highlight. Only scores a buffer NEWER than the one we last scored, so we don't
  // redundantly re-score stale results.
  function scheduleRescoreAfterRefresh() {
    if (arRescoreTimer) { clearTimeout(arRescoreTimer); arRescoreTimer = null; }
    arRescoreTimer = setTimeout(function () {
      arRescoreTimer = null;
      if (!arEnabled || !onLoadboard()) return;
      try {
        chrome.storage.local.get(["lastSearchLoads", "lastSearchAt"], function (r) {
          var at = r.lastSearchAt || 0;
          if (at && at > lastScoredSearchAt && Array.isArray(r.lastSearchLoads) && r.lastSearchLoads.length) {
            lastScoredSearchAt = at;
            console.log("[RLB board] auto-refresh re-score:", r.lastSearchLoads.length, "loads");
            scoreAndPaint(r.lastSearchLoads);
          }
        });
      } catch (e) { /* context invalidated */ }
    }, 2000); // ~1.5s: enough for Relay to return + render the refreshed search
  }

  var arRand = function (lo, hi) { return lo + Math.random() * (hi - lo); };

  // Countdown-to-next-refresh state. nextRefreshAt is set each cycle in
  // scheduleNextRefresh; a 1s interval (arCountdownTimer) ticks the chip text.
  var nextRefreshAt = 0;
  var arCountdownTimer = null;

  function clearAutoRefreshTimer() {
    if (arTimer) { clearTimeout(arTimer); arTimer = null; }
    if (arRescoreTimer) { clearTimeout(arRescoreTimer); arRescoreTimer = null; }
  }

  // Min ≤ Max is required; refuse to run while the range is invalid.
  function autoRefreshRangeValid() { return arMin <= arMax; }

  // Mirror arEnabled into the Refresh toggle checkbox + countdown visibility.
  function reflectAutoRefreshToggle() {
    var cb = document.getElementById("rlb-fleetyes-refresh-cb");
    if (cb && cb.checked !== arEnabled) cb.checked = arEnabled;
    var cd = document.getElementById("rlb-ar-countdown");
    if (cd) cd.style.display = arEnabled ? "inline-flex" : "none";
  }

  function tickCountdown() {
    var cd = document.getElementById("rlb-ar-countdown");
    if (!cd) return;
    var remaining = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    cd.textContent = "Next Refresh In " + remaining + "s";
    // Re-layout the bottom chip row each tick. The countdown can change width as
    // the seconds tick (1- vs 2-digit) and re-appear after an OFF→ON toggle, which
    // could otherwise let it paint over the Auto Refresh toggle. Repositioning here
    // keeps the toggle → countdown → icon chain aligned at all times.
    positionOnlyMine();
  }
  function startCountdown() {
    if (arCountdownTimer) return;
    tickCountdown();
    arCountdownTimer = setInterval(tickCountdown, 1000);
  }
  function stopCountdown() {
    if (arCountdownTimer) { clearInterval(arCountdownTimer); arCountdownTimer = null; }
    var cd = document.getElementById("rlb-ar-countdown");
    if (cd) cd.textContent = "";
  }

  // Schedule the next refresh at a random point in [arMin, arMax] seconds.
  function scheduleNextRefresh() {
    if (!arEnabled) return;
    var lo = Math.min(arMin, arMax), hi = Math.max(arMin, arMax);
    var waitMs = Math.round(arRand(lo, hi) * 1000);
    nextRefreshAt = Date.now() + waitMs;
    startCountdown();
    arTimer = setTimeout(function () {
      arTimer = null;
      doAutoRefresh();
      scheduleNextRefresh(); // pick a fresh random interval each cycle
    }, waitMs);
  }

  function startAutoRefresh() {
    clearAutoRefreshTimer();
    if (!arEnabled || !autoRefreshRangeValid()) return;
    scheduleNextRefresh();
  }

  function stopAutoRefresh() {
    clearAutoRefreshTimer();
    stopCountdown();
  }

  // Apply auto-refresh config (from storage): clamp, validate, and (re)start/stop.
  function applyAutoRefreshConfig(r) {
    if (typeof r.arMin === "number") arMin = Math.min(Math.max(r.arMin, AR_MIN_S), AR_MAX_S);
    if (typeof r.arMax === "number") arMax = Math.min(Math.max(r.arMax, AR_MIN_S), AR_MAX_S);
    arEnabled = !!r.arEnabled && autoRefreshRangeValid();
    reflectAutoRefreshToggle();
    if (arEnabled) startAutoRefresh(); else stopAutoRefresh();
    positionOnlyMine(); // reposition AFTER the countdown has its text (stable width)
  }

  // Read the popup-managed config from storage on boot, then start if enabled.
  function loadAutoRefreshPrefs() {
    try {
      chrome.storage.local.get(["arEnabled", "arMin", "arMax"], function (r) {
        applyAutoRefreshConfig(r || {});
      });
    } catch (e) { /* context invalidated */ }
  }

  // React live to popup changes: when the user saves new auto-refresh settings,
  // start/stop/retime the running board without needing a page reload.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if (!("arEnabled" in changes || "arMin" in changes || "arMax" in changes)) return;
      applyAutoRefreshConfig({
        arEnabled: "arEnabled" in changes ? changes.arEnabled.newValue : arEnabled,
        arMin: "arMin" in changes ? changes.arMin.newValue : arMin,
        arMax: "arMax" in changes ? changes.arMax.newValue : arMax,
      });
    });
  } catch (e) { /* context invalidated */ }

  // ── hover tooltip ───────────────────────────────────────────────────────────────
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = "rlb-tip";
    document.body.appendChild(tip);
    return tip;
  }
  // True when this load picks up BEFORE the given driver's drop-off/free time
  // (availableFrom) — i.e. the match only works because availability was relaxed
  // by the configured lead (e.g. −2h). Single rule shared by the tooltip's red
  // "early" driver label and the load card's red corner dot (see doPaint).
  function driverUsesLead(info, d) {
    var pkMs = info && info.pickup && info.pickup.time ? Date.parse(info.pickup.time) : NaN;
    var fMs = d && d.availableFrom ? Date.parse(d.availableFrom) : NaN;
    return !isNaN(pkMs) && !isNaN(fMs) && pkMs < fMs;
  }
  function onEnter(e) {
    var info = e.currentTarget.__rlbInfo;
    if (!info) return;
    var t = ensureTip();
    // Compact rows: driver name + inline "value unit" cells (e.g. "0.1mi", "22.6h"),
    // no cell borders — a short header row above labels each column.
    var rows = (info.suitableDrivers || []).map(function (d, i) {
      var name = d.driver && d.driver.name ? d.driver.name : "(unknown)";
      var usesLead = driverUsesLead(info, d); // pickup before drop-off → matches via the lead
      var cls = (i === 0 ? "b" : "") + (usesLead ? " lead" : "");
      return (
        '<tr class="' + cls + '"><td><span class="rlb-dname" title="' + esc(name) + '">' + esc(name) + "</span></td><td>" +
        n1(d.deadheadMiles) + "mi</td><td>" + (d.returnMiles == null ? "—" : n1(d.returnMiles) + "mi") + "</td><td>" +
        n1(d.pickupGapHours) + "h</td><td>" + n1(d.fitScore != null ? d.fitScore * 100 : null) + "</td></tr>"
      );
    }).join("");
    var pc = info.pickup && info.pickup.city, dc = info.dropoff && info.dropoff.city;
    // Short column headers so the numbers read clearly: empty miles to pickup, miles
    // the delivery leaves them from start, hours until pickup, the 0–100 fit score.
    var head =
      "<thead><tr><th>Driver</th><th>Deadhead</th><th>Return</th>" +
      "<th>Pickup</th><th>Fit</th></tr></thead>";
    t.innerHTML =
      '<div class="h">£' + (info.payout != null ? Math.round(info.payout) : "—") + " · " + esc(pc) + " → " + esc(dc) +
      " · " + esc(info.workType === "ROUND_TRIP" ? "Round trip" : info.workType === "ONE_WAY" ? "One-way" : info.workType || "") + "</div>" +
      "<table>" + head + "<tbody>" + rows + "</tbody></table>";
    t.style.display = "block";
    positionTip(e);
  }
  function onMove(e) { positionTip(e); }
  function onLeave() { if (tip) tip.style.display = "none"; }
  function positionTip(e) {
    if (!tip) return;
    // padY is larger than padX: Relay's own hover tooltips (e.g. the full stop
    // address) tend to open just above/at the cursor, so a bigger vertical
    // offset keeps ours from landing on top of theirs.
    var padX = 16, padY = 28, w = tip.offsetWidth, h = tip.offsetHeight;
    var x = e.clientX + padX, y = e.clientY + padY;
    if (x + w > window.innerWidth) x = e.clientX - w - padX;
    if (y + h > window.innerHeight) y = e.clientY - h - padY;
    tip.style.left = Math.max(4, x) + "px";
    tip.style.top = Math.max(4, y) + "px";
  }

  // ── boot ────────────────────────────────────────────────────────────────────────
  function boot() {
    injectStyles();
    ensurePanel();
    loadOnlyMinePref();
    loadAutoRefreshPrefs();
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
      // Mark this search as scored so the auto-refresh follow-up doesn't re-score
      // the same buffer (bridge.js writes lastSearchAt for this same RLB_SEARCH).
      lastScoredSearchAt = Date.now();
      scoreAndPaint(d.loads);
    }
  });

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
