// ─── RLB settings popup ───────────────────────────────────────────────────────
// The popup is now settings-only — the actual workflow lives on the load board
// (the ⚡ / 👤 buttons). These settings feed the on-page scoring + FleetYes lookup.
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

  // Only the settings the on-page workflow actually reads. (background.js keeps its
  // own full DEFAULTS for any legacy keys still sitting in storage — harmless.)
  const DEFAULTS = {
    relayBase: "https://relay.amazon.co.uk",
    ontrackUrl: "https://ontrack-api.agilecyber.com/api/v1/rlb-locations",
    token: "",
    carrierCode: "",
    useFleetyesPlaces: false,
    homeCity: "Darlington, UK",
    nearbyRadius: 10,
    minTripMiles: 25,
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
    // Manual auto-refresh: our own timed board refresh (Relay's native one stays off).
    arEnabled: false,
    arMin: 6,
    arMax: 9,
  };

  // Second bound for the auto-refresh interval dropdowns (seconds).
  const AR_MIN_S = 3, AR_MAX_S = 30;

  const $ = (id) => document.getElementById(id);
  const els = {
    toggleAdmin: $("toggleAdmin"),
    adminSettings: $("adminSettings"),
    toggleDev: $("toggleDev"),
    devSettings: $("devSettings"),
    ontrackUrl: $("ontrackUrl"),
    token: $("token"),
    carrierCode: $("carrierCode"),
    useFleetyesPlaces: $("useFleetyesPlaces"),
    relayBase: $("relayBase"),
    homeCity: $("homeCity"),
    nearbyRadius: $("nearbyRadius"),
    minTripMiles: $("minTripMiles"),
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
    arEnabled: $("arEnabled"),
    arMin: $("arMin"),
    arMax: $("arMax"),
    arError: $("arError"),
    saveAdmin: $("saveAdmin"),
    saveDev: $("saveDev"),
  };

  // Populate the min/max interval dropdowns (3s … 30s).
  (function fillIntervalOptions() {
    let opts = "";
    for (let s = AR_MIN_S; s <= AR_MAX_S; s++) opts += '<option value="' + s + '">' + s + "s</option>";
    els.arMin.innerHTML = opts;
    els.arMax.innerHTML = opts;
  })();

  // Min ≤ Max guard: show the error hint when the range is invalid.
  function reflectArValidity() {
    const min = parseInt(els.arMin.value, 10);
    const max = parseInt(els.arMax.value, 10);
    const bad = min > max;
    els.arError.style.display = bad ? "block" : "none";
    return !bad;
  }
  els.arMin.addEventListener("change", reflectArValidity);
  els.arMax.addEventListener("change", reflectArValidity);
  els.arEnabled.addEventListener("change", reflectArValidity);

  function loadSettings() {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      const cfg = Object.assign({}, DEFAULTS, r || {});
      els.ontrackUrl.value = cfg.ontrackUrl;
      els.token.value = cfg.token;
      els.carrierCode.value = cfg.carrierCode || "";
      els.useFleetyesPlaces.checked = cfg.useFleetyesPlaces === true;
      els.relayBase.value = cfg.relayBase;
      els.homeCity.value = cfg.homeCity;
      els.nearbyRadius.value = cfg.nearbyRadius;
      els.minTripMiles.value = cfg.minTripMiles;
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
      // Clamp saved interval into the dropdown range so .value always matches an option.
      const clampAr = (v, d) => Math.min(Math.max(parseInt(v, 10) || d, AR_MIN_S), AR_MAX_S);
      els.arEnabled.checked = cfg.arEnabled === true;
      els.arMin.value = String(clampAr(cfg.arMin, DEFAULTS.arMin));
      els.arMax.value = String(clampAr(cfg.arMax, DEFAULTS.arMax));
      reflectArValidity();
    });
  }

  els.toggleAdmin.addEventListener("click", () => {
    const open = els.adminSettings.classList.toggle("hidden") === false;
    els.toggleAdmin.textContent = open ? "Planning rules ▴" : "Planning rules ▾";
  });
  els.toggleDev.addEventListener("click", () => {
    const open = els.devSettings.classList.toggle("hidden") === false;
    els.toggleDev.textContent = open ? "Developer settings ▴" : "Developer settings ▾";
  });

  // Numeric field readers that ALLOW 0 (0 is meaningful: "keep all", "off", etc.).
  const numField = (el, dflt) => {
    const v = parseFloat(el.value);
    return isNaN(v) ? dflt : Math.max(0, v);
  };
  const intField = (el, dflt) => {
    const v = parseInt(el.value, 10);
    return isNaN(v) ? dflt : Math.max(0, v);
  };

  function flashSaved() {
    [els.saveAdmin, els.saveDev].forEach((b) => {
      if (!b) return;
      const orig = b.textContent;
      b.textContent = "Saved ✓";
      setTimeout(() => { b.textContent = orig; }, 1200);
    });
  }

  // Both Save buttons persist the full settings object.
  function saveSettings() {
    const cfg = {
      relayBase: els.relayBase.value.trim() || DEFAULTS.relayBase,
      ontrackUrl: els.ontrackUrl.value.trim() || DEFAULTS.ontrackUrl,
      token: els.token.value.trim(),
      carrierCode: els.carrierCode.value.trim(),
      useFleetyesPlaces: els.useFleetyesPlaces.checked,
      homeCity: els.homeCity.value.trim() || DEFAULTS.homeCity,
      nearbyRadius: intField(els.nearbyRadius, DEFAULTS.nearbyRadius),
      minTripMiles: intField(els.minTripMiles, DEFAULTS.minTripMiles),
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
      arMin: parseInt(els.arMin.value, 10) || DEFAULTS.arMin,
      arMax: parseInt(els.arMax.value, 10) || DEFAULTS.arMax,
      // Only allow enabling when the range is valid — otherwise force it off.
      arEnabled: els.arEnabled.checked && reflectArValidity(),
    };
    // Reflect the possibly-forced-off state back into the checkbox.
    els.arEnabled.checked = cfg.arEnabled;
    chrome.storage.local.set(cfg, flashSaved);
  }

  els.saveAdmin.addEventListener("click", saveSettings);
  els.saveDev.addEventListener("click", saveSettings);

  loadSettings();
})();
