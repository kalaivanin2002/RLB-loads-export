
// ─── RLB Location Sync + Find Loads ───────────────────────────────────────────
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

  const DEFAULTS = {
    relayBase: "https://relay.amazon.co.uk",
    ontrackUrl: "https://ontrack-api.agilecyber.com/api/v1/rlb-locations",
    ingestUrl: "",
    token: "",
    carrierCode: "",
    useFleetyesPlaces: false,
    letters: "abcdefghijklmnopqrstuvwxyz",
    prefix: ", ",
    delayMs: 500,
    searchRadius: 50,
    nearbyRadius: 10,
    resultSize: 50,
    maxLocations: 2,
    minTripMiles: 25,
    topLoads: 30,
    restHours: 0,
    availabilityLeadHours: 2,
    maxWaitHours: 48,
    gapBeforeNextHours: 2,
    deadheadMph: 30,
    matchEquipment: true,
    weightPayout: 0.4,
    weightRate: 0.25,
    weightDeadhead: 0.2,
    weightTiming: 0.15,
    weightReposition: 0.2,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    toggleAdmin: $("toggleAdmin"),
    toggleDev: $("toggleDev"),
    adminSettings: $("adminSettings"),
    devSettings: $("devSettings"),
    toggleTools: $("toggleTools"),
    moreTools: $("moreTools"),
    ontrackUrl: $("ontrackUrl"),
    ingestUrl: $("ingestUrl"),
    token: $("token"),
    carrierCode: $("carrierCode"),
    useFleetyesPlaces: $("useFleetyesPlaces"),
    relayBase: $("relayBase"),
    prefix: $("prefix"),
    letters: $("letters"),
    delayMs: $("delayMs"),
    searchRadius: $("searchRadius"),
    nearbyRadius: $("nearbyRadius"),
    resultSize: $("resultSize"),
    maxLocations: $("maxLocations"),
    minTripMiles: $("minTripMiles"),
    topLoads: $("topLoads"),
    restHours: $("restHours"),
    availabilityLeadHours: $("availabilityLeadHours"),
    maxWaitHours: $("maxWaitHours"),
    gapBeforeNextHours: $("gapBeforeNextHours"),
    deadheadMph: $("deadheadMph"),
    matchEquipment: $("matchEquipment"),
    weightPayout: $("weightPayout"),
    weightRate: $("weightRate"),
    weightDeadhead: $("weightDeadhead"),
    weightTiming: $("weightTiming"),
    weightReposition: $("weightReposition"),
    saveAdmin: $("saveAdmin"),
    saveDev: $("saveDev"),
    sync: $("syncBtn"),
    syncLog: $("syncLog"),
    findLoads: $("findLoadsBtn"),
    stopLoads: $("stopLoadsBtn"),
    resumeLoads: $("resumeLoadsBtn"),
    retryFailed: $("retryFailedBtn"),
    downloadLoads: $("downloadLoadsBtn"),
    loadsProgress: $("loadsProgress"),
    loadsLog: $("loadsLog"),
    syncTrips: $("syncTripsBtn"),
    downloadTrips: $("downloadTripsBtn"),
    tripsProgress: $("tripsProgress"),
    tripsLog: $("tripsLog"),
    plan: $("planBtn"),
    downloadPlan: $("downloadPlanBtn"),
    downloadReport: $("downloadReportBtn"),
    plannerProgress: $("plannerProgress"),
    plannerLog: $("plannerLog"),
  };

  // Per-job button + log wiring.
  const JOBS = {
    harvest: { btn: els.sync, logEl: els.syncLog, idle: "Sync RLB Locations (a–z)", busy: "Syncing…" },
    loads: { btn: els.findLoads, logEl: els.loadsLog, idle: "Find Loads (all locations)", busy: "Finding loads…" },
    trips: { btn: els.syncTrips, logEl: els.tripsLog, idle: "Sync In-Transit Trips", busy: "Syncing trips…" },
    planner: { btn: els.plan, logEl: els.plannerLog, idle: "Fetch Loads", busy: "Fetching…" },
  };

  function loadSettings() {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      const cfg = Object.assign({}, DEFAULTS, r || {});
      els.ontrackUrl.value = cfg.ontrackUrl;
      els.ingestUrl.value = cfg.ingestUrl;
      els.token.value = cfg.token;
      els.carrierCode.value = cfg.carrierCode || "";
      els.useFleetyesPlaces.checked = cfg.useFleetyesPlaces === true;
      els.relayBase.value = cfg.relayBase;
      els.prefix.value = cfg.prefix;
      els.letters.value = cfg.letters;
      els.delayMs.value = cfg.delayMs;
      els.searchRadius.value = cfg.searchRadius;
      els.nearbyRadius.value = cfg.nearbyRadius;
      els.resultSize.value = cfg.resultSize;
      els.maxLocations.value = cfg.maxLocations;
      els.minTripMiles.value = cfg.minTripMiles;
      els.topLoads.value = cfg.topLoads;
      els.restHours.value = cfg.restHours;
      els.availabilityLeadHours.value = cfg.availabilityLeadHours;
      els.maxWaitHours.value = cfg.maxWaitHours;
      els.gapBeforeNextHours.value = cfg.gapBeforeNextHours;
      els.deadheadMph.value = cfg.deadheadMph;
      els.matchEquipment.checked = cfg.matchEquipment !== false;
      els.weightPayout.value = cfg.weightPayout;
      els.weightRate.value = cfg.weightRate;
      els.weightDeadhead.value = cfg.weightDeadhead;
      els.weightTiming.value = cfg.weightTiming;
      els.weightReposition.value = cfg.weightReposition;
    });
  }

  // Admin (header) and Dev (inside More tools) toggle independently.
  els.toggleAdmin.addEventListener("click", () => {
    els.adminSettings.classList.toggle("hidden");
  });
  els.toggleDev.addEventListener("click", () => {
    const open = els.devSettings.classList.toggle("hidden") === false;
    els.toggleDev.textContent = open ? "Developer settings ▴" : "Developer settings ▾";
  });

  // "More tools" disclosure for the secondary cards.
  els.toggleTools.addEventListener("click", () => {
    const open = els.moreTools.classList.toggle("hidden") === false;
    els.toggleTools.textContent = open ? "More tools ▴" : "More tools ▾";
  });

  // Read a non-negative number from a field, allowing 0 and decimals.
  const numField = (el, dflt) => {
    const v = parseFloat(el.value);
    return isNaN(v) ? dflt : Math.max(0, v);
  };

  // Both Save buttons persist the full settings object (all fields, both tabs).
  function saveSettings() {
    const cfg = {
      ontrackUrl: els.ontrackUrl.value.trim() || DEFAULTS.ontrackUrl,
      ingestUrl: els.ingestUrl.value.trim() || DEFAULTS.ingestUrl,
      token: els.token.value.trim(),
      carrierCode: els.carrierCode.value.trim(),
      useFleetyesPlaces: els.useFleetyesPlaces.checked,
      relayBase: els.relayBase.value.trim() || DEFAULTS.relayBase,
      prefix: els.prefix.value,
      letters: els.letters.value.trim() || DEFAULTS.letters,
      delayMs: Math.max(0, parseInt(els.delayMs.value, 10) || DEFAULTS.delayMs),
      searchRadius: Math.max(0, parseInt(els.searchRadius.value, 10) || DEFAULTS.searchRadius),
      nearbyRadius: Math.max(0, parseInt(els.nearbyRadius.value, 10) || DEFAULTS.nearbyRadius),
      resultSize: Math.max(1, parseInt(els.resultSize.value, 10) || DEFAULTS.resultSize),
      maxLocations: (() => {
        const v = parseInt(els.maxLocations.value, 10);
        return isNaN(v) ? DEFAULTS.maxLocations : Math.max(0, v);
      })(),
      minTripMiles: Math.max(0, parseInt(els.minTripMiles.value, 10) || DEFAULTS.minTripMiles),
      topLoads: Math.max(1, parseInt(els.topLoads.value, 10) || DEFAULTS.topLoads),
      restHours: numField(els.restHours, DEFAULTS.restHours),
      availabilityLeadHours: numField(els.availabilityLeadHours, DEFAULTS.availabilityLeadHours),
      maxWaitHours: numField(els.maxWaitHours, DEFAULTS.maxWaitHours),
      gapBeforeNextHours: numField(els.gapBeforeNextHours, DEFAULTS.gapBeforeNextHours),
      deadheadMph: Math.max(1, parseFloat(els.deadheadMph.value) || DEFAULTS.deadheadMph),
      matchEquipment: els.matchEquipment.checked,
      weightPayout: numField(els.weightPayout, DEFAULTS.weightPayout),
      weightRate: numField(els.weightRate, DEFAULTS.weightRate),
      weightDeadhead: numField(els.weightDeadhead, DEFAULTS.weightDeadhead),
      weightTiming: numField(els.weightTiming, DEFAULTS.weightTiming),
      weightReposition: numField(els.weightReposition, DEFAULTS.weightReposition),
    };
    chrome.storage.local.set(cfg, () =>
      appendLog("harvest", { msg: "Settings saved.", level: "success", ts: Date.now() })
    );
  }

  els.saveAdmin.addEventListener("click", saveSettings);
  els.saveDev.addEventListener("click", saveSettings);

  els.sync.addEventListener("click", () => start("harvest", "start-harvest"));
  els.findLoads.addEventListener("click", () => start("loads", "start-find-loads"));
  els.stopLoads.addEventListener("click", () => send("stop-find-loads"));
  els.resumeLoads.addEventListener("click", () => send("resume-find-loads"));
  els.retryFailed.addEventListener("click", () => {
    els.loadsLog.innerHTML = "";
    send("retry-failed-loads");
  });
  els.syncTrips.addEventListener("click", () => start("trips", "start-sync-trips"));
  els.plan.addEventListener("click", () => start("planner", "start-planner"));

  els.downloadPlan.addEventListener("click", () => {
    chrome.storage.local.get(["plannerTopLoads", "plannerResults", "plannerAvailability"], (r) => {
      const topLoads = r.plannerTopLoads || [];
      const byDriver = r.plannerResults && r.plannerResults.length ? r.plannerResults : r.plannerAvailability || [];
      if (!topLoads.length && !byDriver.length) {
        appendLog("planner", { msg: "Nothing to download yet.", level: "warn", ts: Date.now() });
        return;
      }
      const data = {
        generatedAt: new Date().toISOString(),
        topLoads: topLoads,
        byDriver: byDriver,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rlb-plan-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".json";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  els.downloadReport.addEventListener("click", () => {
    chrome.storage.local.get(["plannerTopLoads", "plannerResults", "plannerAvailability"], (r) => {
      const topLoads = r.plannerTopLoads || [];
      const byDriver = r.plannerResults && r.plannerResults.length ? r.plannerResults : r.plannerAvailability || [];
      if (!topLoads.length && !byDriver.length) {
        appendLog("planner", { msg: "Nothing to download yet.", level: "warn", ts: Date.now() });
        return;
      }
      const html = buildPlanReport(topLoads, byDriver);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rlb-plan-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".html";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  // ── HTML report builder ────────────────────────────────────────────────────
  function buildPlanReport(topLoads, byDriver) {
    const esc = (s) =>
      s == null
        ? ""
        : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    // Always render in UK time so it matches Relay regardless of the PC's timezone.
    const dt = (iso) => {
      if (!iso) return "—";
      const d = new Date(iso);
      if (isNaN(d)) return esc(iso);
      return d.toLocaleString("en-GB", {
        weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        timeZone: "Europe/London",
      });
    };
    const n1 = (v) => (v == null || isNaN(v) ? "—" : (Math.round(v * 10) / 10).toLocaleString());
    const money = (v, unit) =>
      v == null ? "—" : (unit === "USD" ? "$" : "£") + (Math.round(Number(v) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tripType = (t) =>
      t === "ROUND_TRIP" ? "Round trip" : t === "ONE_WAY" ? "One-way" : t ? esc(String(t)) : "—";

    const matched = (byDriver || []).filter((d) => d && d.recommended).length;
    const unmatched = (byDriver || []).filter((d) => d && !d.recommended);

    const loadCards = (topLoads || [])
      .map((l, i) => {
        const drivers = (l.suitableDrivers || [])
          .map((d, di) => {
            const name = d.driver && d.driver.name ? d.driver.name : "(unknown)";
            return (
              '<tr class="' + (di === 0 ? "best" : "") + '">' +
              "<td>" + esc(name) + (di === 0 ? ' <span class="tag">best fit</span>' : "") + "</td>" +
              "<td>" + dt(d.availableFrom) + "</td>" +
              "<td>" + esc(d.currentDropoff || "—") + "</td>" +
              "<td>" + n1(d.deadheadMiles) + " mi</td>" +
              "<td>" + (d.returnMiles == null ? "—" : n1(d.returnMiles) + " mi") + "</td>" +
              "<td>" + n1(d.pickupGapHours) + " h</td>" +
              "<td>" + n1(d.fitScore != null ? d.fitScore * 100 : null) + "</td>" +
              "</tr>"
            );
          })
          .join("");
        return (
          '<section class="load">' +
          '<div class="load-head">' +
          '<span class="rank">#' + (i + 1) + "</span>" +
          '<span class="route">' + esc(l.pickup && l.pickup.city) + ' <span class="arrow">→</span> ' + esc(l.dropoff && l.dropoff.city) + "</span>" +
          '<span class="pay">' + money(l.payout, l.payoutUnit) + "</span>" +
          "</div>" +
          '<div class="load-meta">' +
          "<span>£" + n1(l.ratePerMile) + "/mi</span>" +
          "<span>" + n1(l.tripMiles) + " mi</span>" +
          "<span>" + esc(l.equipment || "—") + "</span>" +
          "<span>" + tripType(l.workType) + "</span>" +
          "<span>Pickup " + dt(l.pickup && l.pickup.time) + "</span>" +
          "<span>Deliver " + dt(l.dropoff && l.dropoff.time) + "</span>" +
          '<span class="dc">' + (l.driverCount || (l.suitableDrivers || []).length) + " suitable driver(s)</span>" +
          "</div>" +
          '<table class="drivers"><thead><tr><th>Driver</th><th>Free from</th><th>Currently at</th><th>Deadhead</th><th>Return</th><th>Pickup gap</th><th>Fit</th></tr></thead><tbody>' +
          (drivers || '<tr><td colspan="7">No drivers.</td></tr>') +
          "</tbody></table>" +
          "</section>"
        );
      })
      .join("");

    const unmatchedRows = unmatched
      .map((d) => {
        const name = d.driver && d.driver.name ? d.driver.name : "(unknown)";
        const reason = d.note || d.error || "No feasible load in window/radius";
        return "<tr><td>" + esc(name) + "</td><td>" + dt(d.availableFrom) + "</td><td>" + esc(reason) + "</td></tr>";
      })
      .join("");

    const unmatchedSection = unmatched.length
      ? '<h2>Drivers with no load (' + unmatched.length + ")</h2>" +
        '<table class="unmatched"><thead><tr><th>Driver</th><th>Free from</th><th>Reason</th></tr></thead><tbody>' +
        unmatchedRows +
        "</tbody></table>"
      : "";

    return (
      "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<title>RLB Load Plan</title><style>" +
      "body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7fa;color:#1e293b;margin:0;padding:24px;}" +
      "h1{font-size:22px;margin:0 0 4px;}h2{font-size:16px;margin:28px 0 10px;}" +
      ".meta{color:#64748b;font-size:13px;margin:0 0 20px;}" +
      ".load{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:14px;}" +
      ".load-head{display:flex;align-items:center;gap:12px;}" +
      ".rank{background:#1e293b;color:#fff;font-weight:700;font-size:12px;border-radius:6px;padding:2px 8px;}" +
      ".route{font-size:16px;font-weight:700;flex:1;}.arrow{color:#94a3b8;}" +
      ".pay{font-size:18px;font-weight:700;color:#16a34a;}" +
      ".load-meta{display:flex;flex-wrap:wrap;gap:8px 14px;margin:8px 0 12px;font-size:12px;color:#475569;}" +
      ".load-meta .dc{margin-left:auto;font-weight:600;color:#2563eb;}" +
      "table{width:100%;border-collapse:collapse;font-size:12px;}" +
      "th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eef2f7;}" +
      "th{color:#64748b;font-weight:600;background:#f8fafc;}" +
      "tr.best td{background:#ecfdf5;}" +
      ".tag{background:#16a34a;color:#fff;font-size:10px;border-radius:4px;padding:1px 5px;margin-left:4px;}" +
      ".unmatched td{color:#475569;}" +
      "</style></head><body>" +
      "<h1>RLB Load Plan</h1>" +
      '<p class="meta">Generated ' + esc(new Date().toLocaleString()) + " · " + (topLoads || []).length +
      " top loads · " + matched + " driver(s) with a match</p>" +
      (loadCards || "<p>No loads found.</p>") +
      unmatchedSection +
      "</body></html>"
    );
  }

  function logTriggerError(job, messageType, err) {
    console.error("[RLB popup] trigger failed:", messageType, err);
    chrome.storage.local.get(["errorLog"], (r) => {
      const ERROR_LOG_MAX = 200;
      const entry = { ts: Date.now(), source: "popup/trigger/" + messageType, message: err, context: { job: job } };
      const next = (r.errorLog || []).concat(entry).slice(-ERROR_LOG_MAX);
      chrome.storage.local.set({ errorLog: next });
    });
  }

  function send(messageType) {
    chrome.runtime.sendMessage({ type: messageType }, () => {
      if (chrome.runtime.lastError) {
        appendLog("loads", { msg: "Error: " + chrome.runtime.lastError.message, level: "error", ts: Date.now() });
        logTriggerError("loads", messageType, chrome.runtime.lastError.message);
      }
    });
  }

  els.downloadLoads.addEventListener("click", () => {
    chrome.storage.local.get(["loadsResults"], (r) => {
      const data = r.loadsResults || [];
      if (!data.length) {
        appendLog("loads", { msg: "No results to download yet.", level: "warn", ts: Date.now() });
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rlb-loads-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".json";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  els.downloadTrips.addEventListener("click", () => {
    chrome.storage.local.get(["tripsResults"], (r) => {
      const data = r.tripsResults || [];
      if (!data.length) {
        appendLog("trips", { msg: "No results to download yet.", level: "warn", ts: Date.now() });
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rlb-trips-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".json";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  function start(job, messageType) {
    JOBS[job].logEl.innerHTML = "";
    chrome.runtime.sendMessage({ type: messageType }, () => {
      if (chrome.runtime.lastError) {
        appendLog(job, { msg: "Error: " + chrome.runtime.lastError.message, level: "error", ts: Date.now() });
        logTriggerError(job, messageType, chrome.runtime.lastError.message);
      }
    });
  }

  function appendLog(job, entry) {
    const logEl = JOBS[job].logEl;
    const line = document.createElement("div");
    line.className = "log-line log-" + (entry.level || "info");
    const t = new Date(entry.ts || Date.now()).toLocaleTimeString();
    line.textContent = "[" + t + "] " + entry.msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderLog(job, entries) {
    JOBS[job].logEl.innerHTML = "";
    (entries || []).forEach((e) => appendLog(job, e));
  }

  function setBusy(job, busy) {
    const j = JOBS[job];
    j.btn.disabled = busy === true;
    j.btn.textContent = busy ? j.busy : j.idle;
  }

  // Reflect the find-loads job state across its buttons + progress line.
  function refreshLoadsUi() {
    chrome.storage.local.get(["loadsJobState", "loadsRunning", "loadsFailed", "loadsResults"], (r) => {
      const state = r.loadsJobState;
      const running = r.loadsRunning === true;
      const failedCount = (r.loadsFailed || []).length;
      const resultsCount = (r.loadsResults || []).length;

      els.findLoads.disabled = running;
      els.findLoads.textContent = running ? "Finding loads…" : "Find Loads (all locations)";
      els.stopLoads.disabled = !running;
      const resumable = !running && state && state.status !== "done" && state.cursor < state.total;
      els.resumeLoads.disabled = !resumable;
      els.retryFailed.disabled = running || failedCount === 0;
      els.retryFailed.textContent = failedCount ? "Retry failed (" + failedCount + ")" : "Retry failed";
      els.downloadLoads.disabled = resultsCount === 0;

      if (state && state.total) {
        els.loadsProgress.textContent =
          "Processed " + state.processed + "/" + state.total + " · " + state.errors + " errors · " +
          state.status + (failedCount ? " · " + failedCount + " failed" : "");
      } else {
        els.loadsProgress.textContent = running ? "Starting…" : "Idle.";
      }
    });
  }

  // Live updates while a job runs.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "progress" && JOBS[msg.job] && msg.entry) appendLog(msg.job, msg.entry);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.harvestRunning) setBusy("harvest", changes.harvestRunning.newValue === true);
    if (changes.loadsRunning || changes.loadsJobState || changes.loadsFailed || changes.loadsResults) {
      refreshLoadsUi();
    }
  });

  // Reflect the trips job state across its buttons + progress line.
  function refreshTripsUi() {
    chrome.storage.local.get(["tripsRunning", "tripsResults"], (r) => {
      const running = r.tripsRunning === true;
      const resultsCount = (r.tripsResults || []).length;

      els.syncTrips.disabled = running;
      els.syncTrips.textContent = running ? "Syncing trips…" : "Sync In-Transit Trips";
      els.downloadTrips.disabled = resultsCount === 0;

      els.tripsProgress.textContent = running ? "Starting…" : resultsCount > 0 ? "Captured " + resultsCount + " trip(s)" : "Idle.";
    });
  }

  // Update trips UI when storage changes.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.tripsRunning || changes.tripsResults) {
      refreshTripsUi();
    }
  });

  // Reflect the planner job state.
  function refreshPlannerUi() {
    chrome.storage.local.get(["plannerRunning", "plannerResults", "plannerAvailability", "plannerTopLoads"], (r) => {
      const running = r.plannerRunning === true;
      const resCount = (r.plannerResults || []).length;
      const availCount = (r.plannerAvailability || []).length;
      const topCount = (r.plannerTopLoads || []).length;
      const withRec = (r.plannerResults || []).filter((x) => x && x.recommended).length;
      els.plan.disabled = running;
      els.plan.textContent = running ? "Fetching…" : "Fetch Loads";
      const nothing = topCount === 0 && resCount === 0 && availCount === 0;
      els.downloadPlan.disabled = nothing;
      els.downloadReport.disabled = nothing;
      els.plannerProgress.textContent = running
        ? "Planning… (" + resCount + "/" + availCount + ")"
        : topCount > 0
        ? topCount + " top load(s) · " + withRec + "/" + resCount + " driver(s) matched"
        : resCount > 0
        ? withRec + "/" + resCount + " driver(s) have a load"
        : availCount > 0
        ? availCount + " driver(s) (availability only)"
        : "Idle.";
    });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.plannerRunning || changes.plannerResults || changes.plannerAvailability || changes.plannerTopLoads) {
      refreshPlannerUi();
    }
  });

  // On open, restore settings + each job's last run.
  loadSettings();
  chrome.storage.local.get(["harvestLog", "harvestRunning", "loadsLog", "tripsLog", "plannerLog"], (r) => {
    renderLog("harvest", r.harvestLog);
    renderLog("loads", r.loadsLog);
    renderLog("trips", r.tripsLog);
    renderLog("planner", r.plannerLog);
    if (r.harvestRunning) setBusy("harvest", true);
  });
  refreshLoadsUi();
  refreshTripsUi();
  refreshPlannerUi();
})();
