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
    downloadLoads: $("downloadLoadsBtn"),
    loadsLog: $("loadsLog"),
  };

  // Per-job button + log wiring.
  const JOBS = {
    harvest: { btn: els.sync, logEl: els.syncLog, idle: "Sync RLB Locations (a–z)", busy: "Syncing…" },
    loads: { btn: els.findLoads, logEl: els.loadsLog, idle: "Find Loads (all locations)", busy: "Finding loads…" },
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

  // Live updates while a job runs.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "progress" && JOBS[msg.job] && msg.entry) appendLog(msg.job, msg.entry);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.harvestRunning) setBusy("harvest", changes.harvestRunning.newValue === true);
    if (changes.loadsRunning) setBusy("loads", changes.loadsRunning.newValue === true);
    if (changes.loadsResults) {
      const v = changes.loadsResults.newValue || [];
      els.downloadLoads.disabled = v.length === 0;
    }
  });

  // On open, restore settings + each job's last run.
  loadSettings();
  chrome.storage.local.get(["harvestLog", "harvestRunning", "loadsLog", "loadsRunning", "loadsResults"], (r) => {
    renderLog("harvest", r.harvestLog);
    renderLog("loads", r.loadsLog);
    if (r.harvestRunning) setBusy("harvest", true);
    if (r.loadsRunning) setBusy("loads", true);
    els.downloadLoads.disabled = !(r.loadsResults && r.loadsResults.length);
  });
})();
