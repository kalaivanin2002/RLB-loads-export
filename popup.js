
// ─── RLB Location Sync + Find Loads ───────────────────────────────────────────
(function () {
  const DEFAULTS = {
    relayBase: "https://relay.amazon.co.uk",
    ontrackUrl: "https://ontrack-api.agilecyber.com/api/v1/rlb-locations",
    ingestUrl: "",
    token: "",
    letters: "abcdefghijklmnopqrstuvwxyz",
    prefix: ", ",
    delayMs: 500,
    searchRadius: 5,
    resultSize: 50,
    maxLocations: 2,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    toggle: $("toggleSettings"),
    settings: $("settings"),
    ontrackUrl: $("ontrackUrl"),
    ingestUrl: $("ingestUrl"),
    token: $("token"),
    relayBase: $("relayBase"),
    prefix: $("prefix"),
    letters: $("letters"),
    delayMs: $("delayMs"),
    searchRadius: $("searchRadius"),
    resultSize: $("resultSize"),
    maxLocations: $("maxLocations"),
    save: $("saveSettings"),
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
  };

  // Per-job button + log wiring.
  const JOBS = {
    harvest: { btn: els.sync, logEl: els.syncLog, idle: "Sync RLB Locations (a–z)", busy: "Syncing…" },
    loads: { btn: els.findLoads, logEl: els.loadsLog, idle: "Find Loads (all locations)", busy: "Finding loads…" },
    trips: { btn: els.syncTrips, logEl: els.tripsLog, idle: "Sync In-Transit Trips", busy: "Syncing trips…" },
  };

  function loadSettings() {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      const cfg = Object.assign({}, DEFAULTS, r || {});
      els.ontrackUrl.value = cfg.ontrackUrl;
      els.ingestUrl.value = cfg.ingestUrl;
      els.token.value = cfg.token;
      els.relayBase.value = cfg.relayBase;
      els.prefix.value = cfg.prefix;
      els.letters.value = cfg.letters;
      els.delayMs.value = cfg.delayMs;
      els.searchRadius.value = cfg.searchRadius;
      els.resultSize.value = cfg.resultSize;
      els.maxLocations.value = cfg.maxLocations;
    });
  }

  els.toggle.addEventListener("click", () => {
    els.settings.classList.toggle("hidden");
  });

  els.save.addEventListener("click", () => {
    const cfg = {
      ontrackUrl: els.ontrackUrl.value.trim() || DEFAULTS.ontrackUrl,
      ingestUrl: els.ingestUrl.value.trim() || DEFAULTS.ingestUrl,
      token: els.token.value.trim(),
      relayBase: els.relayBase.value.trim() || DEFAULTS.relayBase,
      prefix: els.prefix.value,
      letters: els.letters.value.trim() || DEFAULTS.letters,
      delayMs: Math.max(0, parseInt(els.delayMs.value, 10) || DEFAULTS.delayMs),
      searchRadius: Math.max(0, parseInt(els.searchRadius.value, 10) || DEFAULTS.searchRadius),
      resultSize: Math.max(1, parseInt(els.resultSize.value, 10) || DEFAULTS.resultSize),
      maxLocations: (() => {
        const v = parseInt(els.maxLocations.value, 10);
        return isNaN(v) ? DEFAULTS.maxLocations : Math.max(0, v);
      })(),
    };
    chrome.storage.local.set(cfg, () =>
      appendLog("harvest", { msg: "Settings saved.", level: "success", ts: Date.now() })
    );
  });

  els.sync.addEventListener("click", () => start("harvest", "start-harvest"));
  els.findLoads.addEventListener("click", () => start("loads", "start-find-loads"));
  els.stopLoads.addEventListener("click", () => send("stop-find-loads"));
  els.resumeLoads.addEventListener("click", () => send("resume-find-loads"));
  els.retryFailed.addEventListener("click", () => {
    els.loadsLog.innerHTML = "";
    send("retry-failed-loads");
  });
  els.syncTrips.addEventListener("click", () => start("trips", "start-sync-trips"));

  function send(messageType) {
    chrome.runtime.sendMessage({ type: messageType }, () => {
      if (chrome.runtime.lastError) {
        appendLog("loads", { msg: "Error: " + chrome.runtime.lastError.message, level: "error", ts: Date.now() });
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

  // On open, restore settings + each job's last run.
  loadSettings();
  chrome.storage.local.get(["harvestLog", "harvestRunning", "loadsLog", "tripsLog"], (r) => {
    renderLog("harvest", r.harvestLog);
    renderLog("loads", r.loadsLog);
    renderLog("trips", r.tripsLog);
    if (r.harvestRunning) setBusy("harvest", true);
  });
  refreshLoadsUi();
  refreshTripsUi();
})();
