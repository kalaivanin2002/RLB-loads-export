// ─────────────────────────────────────────────────────────────────────────────
// RLB background worker — two jobs:
//
//   "harvest" (Phase 1): loop ", a".." , z" on Relay cities/search, POST each
//     batch to the OnTrack rlb-locations endpoint.
//
//   "loads" (Phase 2): GET all saved locations from OnTrack, then for each one
//     POST relay.amazon.co.uk/api/loadboard/search (from the Relay page, so the
//     session cookie is sent), and POST the search response to the OnTrack
//     ingest endpoint.
//
// Relay calls run INSIDE the open Relay tab via chrome.scripting (same-origin).
// OnTrack calls run HERE in the service worker (host_permissions bypass CORS,
// Bearer-token auth).
// ─────────────────────────────────────────────────────────────────────────────

importScripts("payloads.js"); // provides self.RLB_PAYLOADS (entitiesV2 request bodies)

const DEFAULTS = {
  relayBase: "https://relay.amazon.co.uk",
  ontrackUrl: "https://ontrack-api.agilecyber.com/api/v1/rlb-locations",
  ingestUrl: "",
  token: "",
  letters: "abcdefghijklmnopqrstuvwxyz",
  prefix: ", ",
  delayMs: 500,
  searchRadius: 50,
  nearbyRadius: 10,
  resultSize: 50,
  maxLocations: 2,
  minTripMiles: 25,
  topLoads: 30,
  // Planner timing rules (hours).
  restHours: 0, // rest after finishing a trip before the driver is available
  maxWaitHours: 48, // latest pickup = free + this
  gapBeforeNextHours: 2, // load must deliver this long before the next booked trip
  deadheadMph: 30, // effective speed over straight-line deadhead miles (road-time check)
  matchEquipment: true, // only recommend loads whose trailer matches the driver's
  // Planner scoring weights (relative; need not sum to 1).
  weightPayout: 0.4,
  weightRate: 0.25,
  weightDeadhead: 0.2,
  weightTiming: 0.15,
  weightReposition: 0.2, // favours loads that finish near where the driver started
};

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      resolve(Object.assign({}, DEFAULTS, r || {}));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
// Numeric config value with a fallback when blank/invalid (allows 0).
const numOr = (v, d) => {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return isNaN(n) ? d : n;
};

// ── progress reporting (per job) ─────────────────────────────────────────────
// Persisted to storage (so the popup can show it after being reopened) and also
// pushed live via runtime messaging while the popup is open.
async function resetLog(job) {
  await chrome.storage.local.set({ [job + "Log"]: [], [job + "Running"]: true });
}
async function setRunning(job, running) {
  await chrome.storage.local.set({ [job + "Running"]: running });
}
async function log(job, msg, level) {
  const entry = { ts: Date.now(), msg: msg, level: level || "info" };
  const key = job + "Log";
  const stored = await chrome.storage.local.get([key]);
  const next = (stored[key] || []).concat(entry).slice(-300);
  await chrome.storage.local.set({ [key]: next });
  try {
    chrome.runtime.sendMessage({ type: "progress", job: job, entry: entry });
  } catch (e) {
    /* popup not open — ignore */
  }
}

// ── durable error log ────────────────────────────────────────────────────────
// Separate from the per-job progress logs (which get wiped by resetLog on every
// run). Survives across runs/service-worker restarts so a transient failure
// (e.g. an intermittent 500) can still be diagnosed after the fact. Capped to
// avoid unbounded storage growth.
const ERROR_LOG_MAX = 200;

async function logError(source, err, context) {
  const message = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? String(err.stack) : null;
  const entry = {
    ts: Date.now(),
    source: source, // e.g. "background/searchLoadsInPage" or "hook/entitiesV2"
    message: message,
    stack: stack,
    context: context || null,
  };
  console.error("[RLB error] " + source + ": " + message, context || "", stack || "");
  try {
    const { errorLog } = await chrome.storage.local.get(["errorLog"]);
    const next = (errorLog || []).concat(entry).slice(-ERROR_LOG_MAX);
    await chrome.storage.local.set({ errorLog: next });
  } catch (e) {
    /* storage unavailable — already console.error'd above */
  }
}

// Global safety net: catch anything that escapes normal try/catch (e.g. a bug
// in a .then() chain with no .catch, or a synchronous error outside our own
// handlers) so it lands in the durable error log instead of vanishing when the
// service worker is later recycled.
self.addEventListener("error", (event) => {
  logError("background/uncaught", event.error || event.message || "unknown error", {
    filename: event.filename,
    lineno: event.lineno,
  });
});
self.addEventListener("unhandledrejection", (event) => {
  logError("background/unhandledrejection", event.reason || "unknown rejection");
});

// ── Relay tab + in-page request runner ───────────────────────────────────────
async function findRelayTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://relay.amazon.co.uk/*", "https://relay.amazon.com/*"],
  });
  return tabs && tabs.length ? tabs[0] : null;
}

// Runs in the Relay page. `init` is a plain (serializable) fetch options object.
// Returns { ok, status, body } where body is raw text.
function pageRequest(url, init) {
  return fetch(url, init)
    .then(function (r) {
      return r.text().then(function (t) {
        return { ok: r.ok, status: r.status, body: t };
      });
    })
    .catch(function (e) {
      return { ok: false, status: 0, body: String(e) };
    });
}

async function runInPage(tabId, url, init) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: pageRequest,
    args: [url, init],
    world: "MAIN",
  });
  const r = results && results[0] && results[0].result;
  if (!r) {
    const err = new Error("no response from page");
    await logError("background/runInPage", err, { url: url, tabId: tabId });
    throw err;
  }
  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 1 — harvest cities a–z → POST rlb-locations
// ═════════════════════════════════════════════════════════════════════════════
async function fetchCitiesInPage(tabId, cfg, query) {
  const url =
    cfg.relayBase.replace(/\/+$/, "") +
    "/api/loadboard/filters/cities/search/" +
    encodeURIComponent(query);
  const r = await runInPage(tabId, url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) {
    const err = new Error("Relay HTTP " + r.status);
    await logError("background/fetchCitiesInPage", err, { url: url, status: r.status, body: (r.body || "").slice(0, 300) });
    throw err;
  }
  try {
    return JSON.parse(r.body);
  } catch (e) {
    await logError("background/fetchCitiesInPage/parse", e, { url: url, body: (r.body || "").slice(0, 300) });
    throw new Error("Relay response was not JSON");
  }
}

function extractEntries(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const keys = ["entities", "cities", "results", "data", "suggestions", "items", "locations"];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  return [];
}

// The Relay cities/search response is already in the OnTrack payload shape, but
// stay tolerant of field-name variants.
function mapCity(entry) {
  if (!entry || typeof entry !== "object") return null;
  const pick = (...names) => {
    for (const n of names) {
      if (entry[n] !== undefined && entry[n] !== null && entry[n] !== "") return entry[n];
    }
    return null;
  };
  const name = pick("name", "city", "cityName", "label", "displayName");
  const latitude = num(pick("latitude", "lat", "latitudeValue"));
  const longitude = num(pick("longitude", "lng", "lon", "longitudeValue"));
  if (name === null || latitude === null || longitude === null) return null;
  return {
    name: name,
    stateCode: pick("stateCode", "stateProvinceCode", "state", "region"),
    country: pick("country", "countryCode", "countryName"),
    latitude: latitude,
    longitude: longitude,
    nearestDomicileCode: pick("nearestDomicileCode", "domicileCode"),
    displayValue: pick("displayValue", "label", "displayName"),
  };
}

async function postLocations(cfg, locations) {
  const res = await fetch(cfg.ontrackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.token,
    },
    body: JSON.stringify(locations),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("OnTrack HTTP " + res.status + ": " + text.slice(0, 300));
    await logError("background/postLocations", err, { url: cfg.ontrackUrl, status: res.status, count: locations.length });
    throw err;
  }
  return text;
}

let isHarvesting = false;

async function harvest() {
  if (isHarvesting) {
    await log("harvest", "Harvest already running.", "warn");
    return;
  }
  isHarvesting = true;
  await resetLog("harvest");
  try {
    const cfg = await getConfig();
    if (!cfg.token) {
      await log("harvest", "No OnTrack token set — open Settings, paste the token, and Save.", "error");
      return;
    }
    const tab = await findRelayTab();
    if (!tab) {
      await log("harvest", "No Amazon Relay tab found — open the Relay load board (and log in) first.", "error");
      return;
    }
    await log("harvest", "Using Relay tab #" + tab.id);

    const letters = String(cfg.letters).split("").filter((c) => c.trim());
    let totalSaved = 0;

    for (const letter of letters) {
      const query = cfg.prefix + letter;
      try {
        const data = await fetchCitiesInPage(tab.id, cfg, query);
        const entries = extractEntries(data);
        const locations = entries.map(mapCity).filter(Boolean);
        if (locations.length === 0) {
          await log("harvest", "'" + query + "': 0 mappable locations (raw entries: " + entries.length + ")", "warn");
        } else {
          await postLocations(cfg, locations);
          totalSaved += locations.length;
          await log("harvest", "'" + query + "': saved " + locations.length + " locations", "success");
        }
      } catch (e) {
        await log("harvest", "'" + query + "': " + (e && e.message ? e.message : String(e)), "error");
        await logError("background/harvest", e, { query: query });
      }
      await sleep(cfg.delayMs);
    }
    await log("harvest", "Done. Total locations saved: " + totalSaved, "success");
  } finally {
    isHarvesting = false;
    await setRunning("harvest", false);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SYNC IN-TRANSIT TRIPS — intercept entitiesV2 response from the page
// ═════════════════════════════════════════════════════════════════════════════
async function waitForEntitiesResponse(maxWaitMs = 15000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const stored = await chrome.storage.local.get(["capturedEntitiesResponse"]);
    if (stored.capturedEntitiesResponse) {
      await chrome.storage.local.remove(["capturedEntitiesResponse", "capturedEntitiesAt"]);
      return stored.capturedEntitiesResponse;
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for entitiesV2 response from the page (waited " + maxWaitMs + "ms)");
}

async function injectManualApiCall(tabId) {
  function manualFetchEntities() {
    return fetch("/api/tours/entitiesV2", {
      credentials: "include",
      headers: { Accept: "application/json" }
    })
    .then(r => r.json())
    .then(data => {
      window.postMessage({
        source: "RLB_ENTITIES",
        entities: data
      }, "*");
      return data;
    })
    .catch(e => {
      console.error("[RLB Manual] Failed to fetch entities:", e);
      throw e;
    });
  }

  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: manualFetchEntities,
    world: "MAIN"
  });
}

async function navigateToInTransitPage(tabId, cfg) {
  const inTransitUrl = cfg.relayBase.replace(/\/+$/, "") + "/tours/in-transit?ref=owp_nav_tours";
  await chrome.tabs.update(tabId, { url: inTransitUrl });
  await sleep(5000);
}

function extractDriver(entity) {
  if (!entity || !Array.isArray(entity.loads)) return null;
  for (const load of entity.loads) {
    if (load && load.driverList && Array.isArray(load.driverList)) {
      for (const driver of load.driverList) {
        if (driver) {
          const firstName = driver.firstName || "";
          const lastName = driver.lastName || "";
          const fullName = (firstName + " " + lastName).trim() || "Unknown";
          return {
            driverName: fullName,
            phoneNumber: driver.phoneNumber || null,
            email: driver.email || null,
          };
        }
      }
    }
    if (load && load.assignments && Array.isArray(load.assignments)) {
      for (const assignment of load.assignments) {
        if (assignment && assignment.driver) {
          const d = assignment.driver;
          return {
            driverName: (d.firstName ? d.firstName : "") + (d.lastName ? " " + d.lastName : "") || "Unknown",
            phoneNumber: d.phoneNumber || null,
            email: d.email || null,
          };
        }
      }
    }
  }
  return null;
}

function extractFinalDropoffLocation(entity) {
  if (!entity || !Array.isArray(entity.loads)) return null;
  let lastDropoff = null;
  let maxSeqNum = -1;

  for (const load of entity.loads) {
    if (!load || !Array.isArray(load.stops)) continue;
    for (const stop of load.stops) {
      if (stop && stop.stopType === "DROPOFF" && stop.stopSequenceNumber > maxSeqNum) {
        lastDropoff = stop.location || stop.stopLocation;
        maxSeqNum = stop.stopSequenceNumber;
      }
    }
  }
  return lastDropoff;
}

async function syncInTransitTrips() {
  await resetLog("trips");
  try {
    const cfg = await getConfig();
    let tab = await findRelayTab();

    if (!tab) {
      await log("trips", "No Amazon Relay tab found — creating one…", "info");
      const inTransitUrl = cfg.relayBase.replace(/\/+$/, "") + "/tours/in-transit?ref=owp_nav_tours";
      tab = await chrome.tabs.create({ url: inTransitUrl, active: true });
      await log("trips", "Created new tab #" + tab.id + ", waiting for page to load…", "info");
      await sleep(5000);
    } else {
      await log("trips", "Using existing Relay tab #" + tab.id);
      await log("trips", "Navigating to In-Transit page…", "info");
      await navigateToInTransitPage(tab.id, cfg);
    }

    await log("trips", "Waiting for entitiesV2 API response from the page…", "info");
    let data;
    try {
      data = await waitForEntitiesResponse(10000);
      await log("trips", "Intercepted API response via hook.js", "info");
    } catch (e) {
      await log("trips", "Hook interception timed out, triggering manual API call…", "warn");
      try {
        await injectManualApiCall(tab.id);
        data = await waitForEntitiesResponse(15000);
        await log("trips", "Fetched API response via manual call", "info");
      } catch (e2) {
        await log("trips", "Both interception and manual call failed: " + (e2.message || String(e2)), "error");
        await logError("background/syncInTransitTrips/fetch", e2, { tabId: tab.id });
        throw e2;
      }
    }
    const entities = extractEntries(data);
    await log("trips", "Captured " + entities.length + " trip entities from API response.", "success");

    const trips = [];
    let errors = 0;

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      try {
        const driver = extractDriver(entity);
        const finalDropoff = extractFinalDropoffLocation(entity);

        if (!driver) {
          await log("trips", (i + 1) + "/" + entities.length + " " + (entity.id || "unknown") + ": No driver found — skipping.", "warn");
          errors++;
          continue;
        }

        if (!finalDropoff) {
          await log("trips", (i + 1) + "/" + entities.length + " " + entity.id + ": No drop-off stop found — skipping.", "warn");
          errors++;
          continue;
        }

        const trip = {
          tripId: entity.id,
          tripStartTime: entity.startTime,
          tripEndTime: entity.endTime,
          tripState: entity.tourState,
          driver: driver,
          finalDropoffLocation: finalDropoff,
        };

        trips.push(trip);
        await log("trips", (i + 1) + "/" + entities.length + " " + entity.id + ": OK", "success");
      } catch (e) {
        await log("trips", (i + 1) + "/" + entities.length + " " + (entity.id || "unknown") + ": " + (e.message || String(e)), "error");
        await logError("background/syncInTransitTrips/entity", e, { entityId: entity && entity.id, index: i });
        errors++;
      }
    }

    await chrome.storage.local.set({ tripsResults: trips });
    await log("trips", "Done. Captured " + trips.length + " trip(s)" + (errors > 0 ? " with " + errors + " error(s)" : "") + ".", trips.length > 0 ? "success" : "warn");
  } catch (e) {
    await log("trips", "Error: " + (e.message || String(e)), "error");
    await logError("background/syncInTransitTrips", e);
  } finally {
    await setRunning("trips", false);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 2 — for each saved location, search Relay loads → ingest the response
// ═════════════════════════════════════════════════════════════════════════════
async function getLocations(cfg) {
  const res = await fetch(cfg.ontrackUrl, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer " + cfg.token },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("OnTrack GET HTTP " + res.status + ": " + text.slice(0, 200));
    await logError("background/getLocations", err, { url: cfg.ontrackUrl, status: res.status });
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    await logError("background/getLocations/parse", e, { url: cfg.ontrackUrl, body: text.slice(0, 300) });
    throw new Error("OnTrack GET response was not JSON");
  }
  if (Array.isArray(data)) return data;
  for (const k of ["data", "locations", "results", "items"]) {
    if (data && Array.isArray(data[k])) return data[k];
  }
  return [];
}

// Build the loadboard/search payload for one location (mirrors the sample,
// injecting this location as the single origin city).
function buildSearchPayload(loc, cfg, dateWindow) {
  const name = loc.name != null ? loc.name : loc.cityName;
  const stateCode = loc.stateCode != null ? loc.stateCode : loc.state_code;
  const country = loc.country != null ? loc.country : null;
  const latitude = num(loc.latitude != null ? loc.latitude : loc.lat);
  const longitude = num(loc.longitude != null ? loc.longitude : loc.lng);
  const displayValue =
    (loc.displayValue != null ? loc.displayValue : loc.display_value) ||
    (name + (stateCode ? ", " + stateCode : ""));
  const radius = Number(cfg.searchRadius) || 5;

  return {
    workOpportunityTypeList: ["ROUND_TRIP", "ONE_WAY"],
    originCity: null,
    liveCity: null,
    originCities: [
      {
        name: name,
        stateCode: stateCode,
        country: country,
        latitude: latitude,
        longitude: longitude,
        displayValue: displayValue,
        isCityLive: false,
        isAnywhere: false,
        uniqueKey: String(latitude) + displayValue,
      },
    ],
    startCityName: null,
    startCityStateCode: null,
    startCityLatitude: null,
    startCityLongitude: null,
    startCityDisplayValue: null,
    isOriginCityLive: null,
    startCityRadius: 50,
    destinationCity: null,
    originCitiesRadiusFilters: [
      {
        cityLatitude: latitude,
        cityLongitude: longitude,
        cityName: name,
        cityStateCode: stateCode,
        cityDisplayValue: displayValue,
        radius: radius,
      },
    ],
    destinationCitiesRadiusFilters: null,
    exclusionCitiesFilter: null,
    endCityName: null,
    endCityStateCode: null,
    endCityDisplayValue: null,
    endCityLatitude: null,
    endCityLongitude: null,
    isDestinationCityLive: null,
    endCityRadius: null,
    // Bias the board to the driver's free window so forward-dated loads surface
    // for drivers who only free up in 1–2 days (ISO, matching Relay's own times).
    startDate: dateWindow && dateWindow.startDate ? dateWindow.startDate : null,
    endDate: dateWindow && dateWindow.endDate ? dateWindow.endDate : null,
    minDistance: null,
    maxDistance: null,
    minimumDurationInMillis: null,
    maximumDurationInMillis: null,
    minPayout: null,
    minPricePerDistance: null,
    driverTypeFilters: [],
    uiiaCertificationsFilter: [],
    workOpportunityOperatingRegionFilter: [],
    loadingTypeFilters: [],
    maximumNumberOfStops: null,
    workOpportunityAccessType: null,
    sortByField: "relevanceForSearchTab",
    sortOrder: "asc",
    visibilityStatusType: "VISIBLE",
    categorizedEquipmentTypeList: [{ equipmentCategory: "REQUIRED", equipmentsList: null }],
    categorizedEquipmentTypeListForFilterPills: [{ equipmentCategory: "REQUIRED", equipmentsList: null }],
    eligibleFeaturesExclusionFilter: ["UNANCHORED_NEGO"],
    nextItemToken: 0,
    resultSize: Number(cfg.resultSize) || 50,
    searchURL: "",
    isAutoRefreshCall: false,
    notificationId: "",
    auditContextMap: JSON.stringify({
      rlbChannel: "EXACT_MATCH",
      isOriginCityLive: "false",
      isDestinationCityLive: "false",
      userAgent: (self.navigator && self.navigator.userAgent) || "",
      source: "AVAILABLE_WORK",
    }),
  };
}

async function searchLoadsInPage(tabId, cfg, payload, csrf) {
  const url = cfg.relayBase.replace(/\/+$/, "") + "/api/loadboard/search";
  const headers = applyCsrfHeader({ "Content-Type": "application/json", Accept: "application/json" }, csrf);
  const r = await runInPage(tabId, url, {
    method: "POST",
    credentials: "include",
    headers: headers,
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = new Error("Relay search HTTP " + r.status);
    await logError("background/searchLoadsInPage", err, { url: url, status: r.status, body: (r.body || "").slice(0, 300) });
    throw err;
  }
  try {
    return JSON.parse(r.body);
  } catch (e) {
    await logError("background/searchLoadsInPage/parse", e, { url: url, body: (r.body || "").slice(0, 300) });
    throw new Error("Relay search response was not JSON");
  }
}

function countWorkOpportunities(data) {
  if (!data || typeof data !== "object") return 0;
  if (Array.isArray(data.workOpportunities)) return data.workOpportunities.length;
  for (const k of ["workOpportunityList", "results", "data"]) {
    if (Array.isArray(data[k])) return data[k].length;
  }
  return 0;
}

async function postIngest(cfg, searchResponse) {
  const res = await fetch(cfg.ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.token,
    },
    body: JSON.stringify(searchResponse),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("Ingest HTTP " + res.status + ": " + text.slice(0, 200));
    await logError("background/postIngest", err, { url: cfg.ingestUrl, status: res.status });
    throw err;
  }
  return text;
}

// Best-effort: find the load board's "Auto refresh" toggle and switch it off.
// Runs in the page (DOM access). Returns { found, action }.
function disableAutoRefreshInPage() {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const wantedRe = /auto[\s-]?refresh/i;

  const controls = Array.from(
    document.querySelectorAll('[role="switch"], input[type="checkbox"], button[aria-pressed], [aria-checked]')
  );

  function isOn(el) {
    const ac = el.getAttribute && el.getAttribute("aria-checked");
    const ap = el.getAttribute && el.getAttribute("aria-pressed");
    if (ac != null) return ac === "true";
    if (ap != null) return ap === "true";
    if (typeof el.checked === "boolean") return el.checked;
    return null;
  }

  // Return the auto-refresh label text near this control, or "" if none.
  function labelFor(el) {
    const aria = norm(el.getAttribute && el.getAttribute("aria-label"));
    if (wantedRe.test(aria)) return aria;
    if (el.id) {
      const lbl = document.querySelector('label[for="' + (window.CSS ? CSS.escape(el.id) : el.id) + '"]');
      if (lbl && wantedRe.test(norm(lbl.textContent))) return norm(lbl.textContent);
    }
    let p = el;
    for (let i = 0; i < 4 && p; i++) {
      const t = norm(p.textContent);
      if (wantedRe.test(t)) return t;
      p = p.parentElement;
    }
    return "";
  }

  for (const el of controls) {
    const label = labelFor(el);
    if (!label) continue;

    let on = isOn(el);
    // Amazon's label flips: "turn on auto-refresh" (currently off) vs
    // "turn off auto-refresh" (currently on). Use it when aria/checked is absent.
    if (on === null) {
      if (/turn off auto[\s-]?refresh/.test(label)) on = true;
      else if (/turn on auto[\s-]?refresh/.test(label)) on = false;
    }

    if (on === true) {
      el.click();
      return { found: true, action: "turned-off" };
    }
    if (on === false) {
      return { found: true, action: "already-off" };
    }
    // State undetermined — do NOT click (avoid accidentally enabling it).
    return { found: true, action: "state-unknown-left-as-is" };
  }
  return { found: false, action: "not-found" };
}

// Fallback CSRF lookup: read the token straight from the page (meta tag,
// global var, cookie, or inline script). Runs in the MAIN world.
function extractCsrfFromPage() {
  const out = { token: null, name: "anti-csrftoken-a2z", source: null };

  try {
    const metas = document.querySelectorAll("meta[name]");
    for (const m of metas) {
      const n = (m.getAttribute("name") || "").toLowerCase();
      if (n.indexOf("csrf") !== -1 && m.getAttribute("content")) {
        out.token = m.getAttribute("content");
        out.name = m.getAttribute("name");
        out.source = "meta:" + n;
        return out;
      }
    }
  } catch (e) {}

  try {
    const cands = ["csrfToken", "CSRF_TOKEN", "antiCsrfToken", "antiCsrftokenA2z", "__CSRF__"];
    for (const k of cands) {
      if (window[k] && typeof window[k] === "string") {
        out.token = window[k];
        out.source = "window." + k;
        return out;
      }
    }
  } catch (e) {}

  try {
    const m = document.cookie.match(/(?:^|;\s*)((?:anti-csrftoken[^=]*|csrf[^=]*))=([^;]+)/i);
    if (m) {
      out.token = decodeURIComponent(m[2]);
      out.source = "cookie:" + m[1];
      return out;
    }
  } catch (e) {}

  try {
    const scripts = document.querySelectorAll("script:not([src])");
    for (const s of scripts) {
      const t = s.textContent || "";
      const mm =
        t.match(/anti-csrftoken-a2z["'\s:=]+([A-Za-z0-9+/=_-]{16,})/i) ||
        t.match(/csrf[_-]?token["'\s:=]+([A-Za-z0-9+/=_-]{16,})/i);
      if (mm) {
        out.token = mm[1];
        out.source = "inline-script";
        return out;
      }
    }
  } catch (e) {}

  return out;
}

async function disableAutoRefresh(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: disableAutoRefreshInPage,
  });
  return (res && res[0] && res[0].result) || { found: false, action: "no-result" };
}

// ── resilient job engine ─────────────────────────────────────────────────────
// State is split so the hot path stays cheap:
//   loadsJobLocations — the full list (written once per job)
//   loadsJobState     — small mutable progress {status,cursor,total,processed,errors,csrf,relayTabId,updatedAt}
//   loadsFailed       — failures, for a retry pass
//   loadsResults      — full responses, only when no ingest URL (download/testing)
const rand = (n) => Math.floor(Math.random() * n);

let loopActive = false; // per-worker guard against concurrent loops
let stopRequested = false;

function ensureWatchdog() {
  chrome.alarms.create("loadsWatchdog", { periodInMinutes: 1 });
}

async function resolveCsrf(tabId) {
  const s = await chrome.storage.local.get(["csrfToken", "csrfHeaderName"]);
  if (s.csrfToken) return { token: s.csrfToken, headerName: s.csrfHeaderName };
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: extractCsrfFromPage,
      world: "MAIN",
    });
    const r = res && res[0] && res[0].result;
    if (r && r.token) {
      await chrome.storage.local.set({
        csrfToken: r.token,
        csrfHeaderName: r.name || "anti-csrftoken-a2z",
        csrfCapturedAt: Date.now(),
      });
      await log("loads", "Found CSRF token in page (" + r.source + ").", "success");
      return { token: r.token, headerName: r.name || "anti-csrftoken-a2z" };
    }
  } catch (e) {
    /* fall through */
  }
  return null;
}

// Attach the CSRF token under Relay's canonical header name AND the captured
// one. The page-scrape fallback can store a non-standard name (e.g. a meta tag
// called "csrf-token"); sending only that name makes Relay answer
// HTTP 400 {"defaultErrorMessage":"No CSRF token present!"}.
function applyCsrfHeader(headers, csrf) {
  // Marker for hook.js: this fetch is OURS — don't capture its CSRF header
  // (that would write our own, possibly rejected, token back into storage,
  // re-poisoning the cache right after we cleared it) and don't intercept its
  // response. hook.js strips the marker before the request is sent.
  headers["x-rlb-internal"] = "1";
  if (!csrf || !csrf.token) return headers;
  headers["anti-csrftoken-a2z"] = csrf.token;
  if (csrf.headerName && csrf.headerName.toLowerCase() !== "anti-csrftoken-a2z") {
    headers[csrf.headerName] = csrf.token;
  }
  return headers;
}

// Recover a trustworthy CSRF token: open the in-transit Trips page — its own
// entitiesV2 call carries the token the server actually accepts, which hook.js
// captures into storage — and wait for that capture. Returns the fresh token
// or null on timeout.
async function captureFreshCsrf(cfg) {
  const t0 = Date.now();
  const baseUrl = cfg.relayBase.replace(/\/+$/, "");
  try {
    chrome.windows.create({ url: baseUrl + "/tours/in-transit?ref=owp_nav_tours" }, function () {
      if (chrome.runtime.lastError) console.error("[RLB] Failed to open trips window for CSRF capture:", chrome.runtime.lastError);
    });
  } catch (e) {
    return null;
  }
  while (Date.now() - t0 < 25000) {
    await sleep(700);
    const s = await chrome.storage.local.get(["csrfToken", "csrfHeaderName", "csrfCapturedAt"]);
    if (s.csrfToken && s.csrfCapturedAt && s.csrfCapturedAt > t0) {
      return { token: s.csrfToken, headerName: s.csrfHeaderName || "anti-csrftoken-a2z" };
    }
  }
  return null;
}

// Retry transient failures (429/5xx/network) with exponential backoff + jitter.
async function withRetry(fn, kind, label, maxRetries) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const transient =
        /HTTP (0|408|429|500|502|503|504)\b/.test(msg) || /network|failed to fetch|no response/i.test(msg);
      attempt++;
      if (attempt > maxRetries || !transient) {
        await logError("background/withRetry/" + kind, e, { label: label, attempt: attempt, exhausted: attempt > maxRetries, transient: transient });
        throw e;
      }
      const backoff = Math.min(10000, 400 * Math.pow(2, attempt)) + rand(400);
      await log("loads", label + ": " + kind + " retry " + attempt + "/" + maxRetries + " in " + Math.round(backoff) + "ms (" + msg + ")", "warn");
      await sleep(backoff);
    }
  }
}

async function appendResult(rec) {
  const { loadsResults } = await chrome.storage.local.get(["loadsResults"]);
  const arr = loadsResults || [];
  arr.push(rec);
  await chrome.storage.local.set({ loadsResults: arr });
}

async function recordFailure(index, label, location, error) {
  const { loadsFailed } = await chrome.storage.local.get(["loadsFailed"]);
  const arr = loadsFailed || [];
  arr.push({ index: index, label: label, location: location, error: error });
  await chrome.storage.local.set({ loadsFailed: arr });
}

// Set up tab/CSRF/auto-refresh, persist a fresh job, and kick the loop.
async function startJob(locations) {
  const cfg = await getConfig();
  if (!cfg.token) {
    await log("loads", "No token set — open Settings, paste the token, and Save.", "error");
    return;
  }
  const tab = await findRelayTab();
  if (!tab) {
    await log("loads", "No Amazon Relay tab found — open the Relay load board (and log in) first.", "error");
    return;
  }
  const csrf = await resolveCsrf(tab.id);
  if (!csrf) {
    await log("loads", "No CSRF token found. Reload the Relay load board TAB, run one manual search, then retry.", "error");
    return;
  }
  await log("loads", "Using CSRF token (" + (csrf.headerName || "anti-csrftoken-a2z") + ").");

  try {
    const ar = await disableAutoRefresh(tab.id);
    await log("loads", "Auto-refresh: " + (ar.found ? ar.action : "toggle not found — continuing") + ".", ar.found ? "success" : "warn");
  } catch (e) {
    await log("loads", "Auto-refresh step failed: " + (e.message || String(e)) + " — continuing.", "warn");
    await logError("background/startJob/disableAutoRefresh", e);
  }

  await chrome.storage.local.set({
    loadsJobLocations: locations,
    loadsJobState: {
      status: "running",
      cursor: 0,
      total: locations.length,
      processed: 0,
      errors: 0,
      csrf: csrf,
      relayTabId: tab.id,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    },
    loadsFailed: [],
    loadsResults: [],
  });
  ensureWatchdog();
  await setRunning("loads", true);
  stopRequested = false;
  await log("loads", "Queued " + locations.length + " locations. Pacing ~" + (Number(cfg.delayMs) || 300) + "ms + jitter.");
  processLoop();
}

async function startFindLoads() {
  if (loopActive) {
    await log("loads", "A job is already running — Stop it first.", "warn");
    return;
  }
  await resetLog("loads");
  const cfg = await getConfig();
  if (!cfg.token) {
    await log("loads", "No token set — open Settings, paste the token, and Save.", "error");
    return;
  }
  const tab = await findRelayTab();
  if (!tab) {
    await log("loads", "No Amazon Relay tab found — open the Relay load board (and log in) first.", "error");
    return;
  }
  let locations;
  try {
    locations = await getLocations(cfg);
  } catch (e) {
    await log("loads", "Failed to fetch locations: " + (e.message || String(e)), "error");
    await logError("background/startFindLoads/getLocations", e);
    return;
  }
  if (!locations.length) {
    await log("loads", "No saved locations returned from the API.", "warn");
    return;
  }
  const max = Number(cfg.maxLocations) || 0;
  const toSearch = max > 0 ? locations.slice(0, max) : locations;
  await log("loads", "Fetched " + locations.length + " locations" + (max > 0 ? " — using first " + toSearch.length : "") + ".");
  await startJob(toSearch);
}

async function resumeFindLoads() {
  const { loadsJobState: state } = await chrome.storage.local.get(["loadsJobState"]);
  if (!state) {
    await log("loads", "No job to resume.", "warn");
    return;
  }
  if (state.status === "done" || state.cursor >= state.total) {
    await log("loads", "Job already complete.", "info");
    return;
  }
  if (loopActive && state.status === "running") {
    await log("loads", "Already running.", "info");
    return;
  }
  state.status = "running";
  state.updatedAt = Date.now();
  await chrome.storage.local.set({ loadsJobState: state });
  ensureWatchdog();
  await setRunning("loads", true);
  stopRequested = false;
  await log("loads", "Resuming from " + state.cursor + "/" + state.total + "…");
  processLoop();
}

async function stopFindLoads() {
  stopRequested = true;
  const { loadsJobState: state } = await chrome.storage.local.get(["loadsJobState"]);
  if (state && state.status === "running") {
    state.status = "paused";
    state.updatedAt = Date.now();
    await chrome.storage.local.set({ loadsJobState: state });
  }
  if (!loopActive) {
    await setRunning("loads", false);
    await log("loads", "Stopped.", "warn");
  } else {
    await log("loads", "Stopping after current request…", "warn");
  }
}

async function retryFailed() {
  if (loopActive) {
    await log("loads", "A job is running — Stop it before retrying failed.", "warn");
    return;
  }
  const { loadsFailed } = await chrome.storage.local.get(["loadsFailed"]);
  const failed = loadsFailed || [];
  if (!failed.length) {
    await log("loads", "No failed locations to retry.", "info");
    return;
  }
  await resetLog("loads");
  await log("loads", "Retrying " + failed.length + " failed locations…");
  await startJob(failed.map((f) => f.location));
}

async function processLoop() {
  if (loopActive) return;
  loopActive = true;
  try {
    const cfg = await getConfig();
    const base = Math.max(0, Number(cfg.delayMs) || 300);
    const { loadsJobLocations: locations } = await chrome.storage.local.get(["loadsJobLocations"]);
    if (!locations || !locations.length) return;

    while (true) {
      const { loadsJobState: state } = await chrome.storage.local.get(["loadsJobState"]);
      if (!state || state.status !== "running") break;

      if (stopRequested) {
        state.status = "paused";
        state.updatedAt = Date.now();
        await chrome.storage.local.set({ loadsJobState: state });
        await log("loads", "Paused at " + state.processed + "/" + state.total + ".", "warn");
        await setRunning("loads", false);
        break;
      }

      if (state.cursor >= state.total) {
        state.status = "done";
        state.updatedAt = Date.now();
        await chrome.storage.local.set({ loadsJobState: state });
        const { loadsFailed } = await chrome.storage.local.get(["loadsFailed"]);
        const failN = (loadsFailed || []).length;
        await log(
          "loads",
          "Done. " + state.processed + "/" + state.total + " processed, " + state.errors + " errors" +
            (failN ? " — " + failN + " failed (use Retry failed)" : "") + ".",
          "success"
        );
        await setRunning("loads", false);
        chrome.alarms.clear("loadsWatchdog");
        break;
      }

      const i = state.cursor;
      const loc = locations[i];
      const label = (loc && (loc.displayValue || loc.name)) || "#" + i;

      try {
        const payload = buildSearchPayload(loc, cfg);
        const data = await withRetry(() => searchLoadsInPage(state.relayTabId, cfg, payload, state.csrf), "search", label, 3);
        const n = countWorkOpportunities(data);

        if (cfg.ingestUrl) {
          await withRetry(() => postIngest(cfg, data), "ingest", label, 3);
        } else {
          await appendResult({ location: loc, capturedAt: new Date().toISOString(), count: n, response: data });
        }

        state.cursor = i + 1;
        state.processed = state.processed + 1;
        state.updatedAt = Date.now();
        await chrome.storage.local.set({ loadsJobState: state });
        await log("loads", i + 1 + "/" + state.total + " " + label + ": " + n + " loads" + (cfg.ingestUrl ? " → ingested" : " (stored)"), n > 0 ? "success" : "info");
      } catch (e) {
        await recordFailure(i, label, loc, e && e.message ? e.message : String(e));
        state.cursor = i + 1;
        state.processed = state.processed + 1;
        state.errors = state.errors + 1;
        state.updatedAt = Date.now();
        await chrome.storage.local.set({ loadsJobState: state });
        await log("loads", i + 1 + "/" + state.total + " " + label + ": ERROR " + (e.message || e), "error");
        await logError("background/processLoop", e, { index: i, label: label });
      }

      await sleep(base + rand(base)); // fast: base..2×base (jitter)
    }
  } finally {
    loopActive = false;
  }
}

// Auto-resume: if the worker was killed mid-run, restart the loop.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "loadsWatchdog") return;
  if (loopActive) return;
  const { loadsJobState: state } = await chrome.storage.local.get(["loadsJobState"]);
  if (!state) return;
  if (state.status === "running" && Date.now() - (state.updatedAt || 0) > 25000) {
    await log("loads", "Resuming after worker restart…", "warn");
    stopRequested = false;
    processLoop();
  } else if (state.status !== "running") {
    chrome.alarms.clear("loadsWatchdog");
  }
});

// Also resume immediately when the worker spins back up.
(async function resumeOnStartup() {
  const { loadsJobState: state } = await chrome.storage.local.get(["loadsJobState"]);
  if (state && state.status === "running") {
    ensureWatchdog();
    processLoop();
  }
})();

// ═════════════════════════════════════════════════════════════════════════════
// LOAD PLANNER — Stage A: per-driver availability from trips
//   Fetch in-transit + upcoming entitiesV2, chain each driver's trips, derive
//   freeAt (last trip end) + freeLocation (last drop-off) + domicile + equipment.
// ═════════════════════════════════════════════════════════════════════════════

// Refresh the date bounds in a captured entitiesV2 payload so the trip window
// stays current (broad: now-30d … now+180d). Returns a fresh clone.
// keepOriginalSize: leave pagination.size as captured — used as a fallback when
// the server 500s on the raised size (see fetchEntitiesFresh).
function freshenDates(payload, keepOriginalSize) {
  const clone = JSON.parse(JSON.stringify(payload));
  const lte = new Date(Date.now() + 180 * 86400000).toISOString();
  const gte = new Date(Date.now() - 30 * 86400000).toISOString();
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      // Raise the page size so trips can't be truncated (the captured payload
      // caps at 100, which silently drops trips for larger fleets).
      if (!keepOriginalSize && o.pagination && typeof o.pagination === "object") o.pagination.size = 100;
      for (const k of Object.keys(o)) {
        if (k === "lte" && typeof o[k] === "string") o[k] = lte;
        else if (k === "gte" && typeof o[k] === "string") o[k] = gte;
        else walk(o[k]);
      }
    }
  })(clone);
  return clone;
}

// Runs in the page: POST entitiesV2, then return ONLY slim trip fields (the raw
// response is multi-MB — we never ship that across contexts).
function pageFetchTrips(url, init) {
  return fetch(url, init)
    .then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) return { ok: false, status: r.status, body: (t || "").slice(0, 300), entities: [] };
        var data;
        try { data = JSON.parse(t); } catch (e) { return { ok: false, status: r.status, parseError: true, body: (t || "").slice(0, 300), entities: [] }; }
        var ents = data && Array.isArray(data.entities) ? data.entities : [];
        var slimLoc = function (loc, pt) {
          if (!loc) return null;
          return {
            city: loc.city || null,
            state: loc.state || null,
            country: loc.country || null,
            postalCode: loc.postalCode || null,
            latitude: loc.latitude != null ? loc.latitude : null,
            longitude: loc.longitude != null ? loc.longitude : null,
            code: loc.label || loc.stopCode || null,
            plannedTime: pt || null,
          };
        };
        var slim = ents.map(function (e) {
          var dl = e.drivers && e.drivers.length ? e.drivers.slice() : [];
          if (!dl.length) {
            (e.loads || []).forEach(function (l) { (l.driverList || []).forEach(function (d) { dl.push(d); }); });
          }
          var seen = {}, drivers = [];
          dl.forEach(function (d) {
            if (!d || !d.id || seen[d.id]) return;
            seen[d.id] = true;
            drivers.push({
              id: d.id,
              staticDriverId: d.staticDriverId || null,
              name: ((d.firstName || "") + " " + (d.lastName || "")).trim() || "Unknown",
              phoneNumber: d.phoneNumber || null,
              email: d.email || null,
            });
          });
          // final drop-off: TOUR → last DROPOFF stop; BLOCK has no stops →
          // use locationList (has lat/lng) or startLocationCentroid.
          var best = null, bestT = -Infinity;
          (e.loads || []).forEach(function (l) {
            (l.stops || []).forEach(function (s) {
              if (s.stopType !== "DROPOFF" || !s.location) return;
              var acts = s.actions || [];
              var co = acts.filter(function (a) { return a.type === "CHECKOUT"; })[0] || acts[acts.length - 1];
              var ts = co && co.plannedTime ? Date.parse(co.plannedTime) : (s.stopSequenceNumber || 0);
              if (ts > bestT) { bestT = ts; best = slimLoc(s.location, co && co.plannedTime ? co.plannedTime : null); }
            });
          });
          if (!best) {
            var ll = e.locationList;
            if (ll && ll.length) best = slimLoc(ll[ll.length - 1], e.lastDeliveryTime || null);
            else if (e.startLocationCentroid && e.startLocationCentroid.centerAddress) {
              best = slimLoc(e.startLocationCentroid.centerAddress, e.lastDeliveryTime || null);
            }
          }
          var equip = null;
          (e.loads || []).forEach(function (l) { if (!equip && l && l.equipmentType) equip = l.equipmentType; });
          if (!equip) equip = e.equipmentType || null;
          return {
            id: e.id,
            entityType: e.entityType,
            tourState: e.tourState || e.blockState || null,
            startTime: e.startTime || e.firstPickupTime || null,
            endTime: e.endTime || e.lastDeliveryTime || null,
            domicileRoute: e.domicileRoute || null,
            drivers: drivers,
            finalDropoff: best,
            equipment: equip,
          };
        });
        return { ok: true, status: r.status, entities: slim };
      });
    })
    .catch(function (err) { return { ok: false, status: 0, error: String(err), entities: [] }; });
}

async function fetchEntities(tabId, cfg, csrf, payload) {
  const url = cfg.relayBase.replace(/\/+$/, "") + "/api/tours/entitiesV2";
  const headers = applyCsrfHeader({ "Content-Type": "application/json", Accept: "application/json" }, csrf);
  const res = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: pageFetchTrips,
    args: [url, { method: "POST", credentials: "include", headers: headers, body: JSON.stringify(payload) }],
    world: "MAIN",
  });
  const r = res && res[0] && res[0].result;
  if (!r) {
    const err = new Error("no response from page");
    await logError("background/fetchEntities", err, { url: url });
    throw err;
  }
  if (!r.ok) {
    const err = new Error(
      "entitiesV2 HTTP " + r.status +
      (r.parseError ? " (parse error)" : "") +
      (r.error ? " " + r.error : "") +
      (r.body ? " — " + r.body : "")
    );
    err.status = r.status;
    err.body = r.body || null;
    await logError("background/fetchEntities", err, { url: url, status: r.status, parseError: !!r.parseError, body: r.body || null });
    // A bad CSRF token surfaces as 401/403, or as a 400 whose body names CSRF
    // ("No CSRF token present!"). Clear the cached token in those cases so the
    // next attempt re-derives it from the page instead of resending the same
    // rejected one forever. Do NOT clear on a plain 500: that's a server-side
    // rejection of the request itself (e.g. pagination.size too large).
    if (r.status === 401 || r.status === 403 || /csrf/i.test(r.body || "")) {
      await chrome.storage.local.remove(["csrfToken", "csrfHeaderName", "csrfCapturedAt"]);
    }
    throw err;
  }
  return r.entities || [];
}

// entitiesV2 rejects a raised pagination.size with a bare HTTP 500 on some
// accounts. Try with the raised size first (avoids truncation for large
// fleets); if the server 500s, retry once with the captured payload's original
// size so the refresh still succeeds.
async function fetchEntitiesFresh(tabId, cfg, csrf, payload) {
  try {
    return await fetchEntities(tabId, cfg, csrf, freshenDates(payload));
  } catch (e) {
    if (e && e.status === 500) {
      await logError("background/fetchEntitiesFresh", e, { note: "HTTP 500 with raised pagination.size — retrying with the payload's original size" });
      return await fetchEntities(tabId, cfg, csrf, freshenDates(payload, true));
    }
    if (e && e.body && /csrf/i.test(e.body)) {
      // The cached token was rejected (fetchEntities already cleared it). The
      // only token the server reliably accepts is the one the Relay page
      // itself sends — open the Trips page so hook.js captures it, retry once.
      await logError("background/fetchEntitiesFresh", e, { note: "CSRF rejected — opening Trips page to capture a fresh token, then retrying" });
      const fresh = await captureFreshCsrf(cfg);
      if (fresh) return await fetchEntities(tabId, cfg, fresh, freshenDates(payload));
    }
    throw e;
  }
}

// Build per-driver availability using the NEXT FREE GAP: each driver's trips
// are busy intervals; we find the earliest point from now where they're not
// booked, plus where that free window ends (the next trip's start). A load must
// fit inside that window.
function buildAvailability(entities, cfg) {
  const now = Date.now();
  const restMs = numOr(cfg && cfg.restHours, 0) * HOUR_MS;
  const byDriver = {};
  for (const e of entities) {
    if (!e.drivers || !e.drivers.length) continue; // unassigned capacity block
    const endMs = e.endTime ? Date.parse(e.endTime) : NaN;
    if (isNaN(endMs)) continue;
    const startMs = e.startTime ? Date.parse(e.startTime) : NaN;
    const interval = {
      tripId: e.id,
      state: e.tourState,
      start: isNaN(startMs) ? endMs : startMs,
      end: endMs,
      endLocation: e.finalDropoff,
      equipment: e.equipment,
      domicile: e.domicileRoute,
    };
    for (const d of e.drivers) {
      if (!byDriver[d.id]) byDriver[d.id] = { driver: d, intervals: [] };
      byDriver[d.id].intervals.push(interval);
    }
  }

  const out = [];
  for (const id in byDriver) {
    const rec = byDriver[id];
    const ivs = rec.intervals.slice().sort((a, b) => a.start - b.start);

    // Merge overlapping/adjacent busy intervals.
    const merged = [];
    for (const iv of ivs) {
      const last = merged[merged.length - 1];
      if (last && iv.start <= last.end) {
        if (iv.end > last.end) {
          last.end = iv.end;
          last.endLocation = iv.endLocation;
          last.equipment = iv.equipment || last.equipment;
          last.tripId = iv.tripId;
          last.state = iv.state;
          last.domicile = iv.domicile || last.domicile;
        }
      } else {
        merged.push(Object.assign({}, iv));
      }
    }

    // Resolve the earliest free start ≥ now (push past any interval covering now)
    // and remember the location/trip we came off.
    let freeStart = now;
    let freeLocation = null;
    let lastPastEnd = -Infinity;
    let source = null;
    for (const b of merged) {
      if (b.end <= now && b.end > lastPastEnd) { lastPastEnd = b.end; freeLocation = b.endLocation; source = b; }
      if (b.start <= freeStart && freeStart <= b.end) { freeStart = b.end; freeLocation = b.endLocation; source = b; }
    }
    // The next booked interval after freeStart bounds the free window.
    let nextTripStart = null;
    for (const b of merged) {
      if (b.start > freeStart) { nextTripStart = b.start; break; }
    }

    // Apply mandatory rest after finishing a trip (only if they came off one).
    const effFreeStart = source ? freeStart + restMs : freeStart;

    out.push({
      driver: rec.driver,
      lastTripId: source ? source.tripId : null,
      lastTripState: source ? source.state : null,
      lastTripEndTime: source ? new Date(source.end).toISOString() : null,
      freeLocation: freeLocation,
      domicile: source ? source.domicile : null,
      equipment: source ? source.equipment : null,
      freeAt: effFreeStart > now ? new Date(effFreeStart).toISOString() : null,
      freeAtEffective: new Date(effFreeStart).toISOString(),
      alreadyFree: !(effFreeStart > now),
      nextTripStart: nextTripStart != null ? new Date(nextTripStart).toISOString() : null,
      freeWindowHours: nextTripStart != null ? r2((nextTripStart - effFreeStart) / HOUR_MS) : null,
    });
  }
  out.sort((x, y) => Date.parse(x.freeAtEffective) - Date.parse(y.freeAtEffective));
  return out;
}

// Default scoring weights. Components are emitted in the output so ranking is
// transparent and tunable — adjust here (or we can expose them in settings).
// payout = total £ of the run (favours big jobs over tiny shuttles);
// rate = £/mile; deadhead = empty miles to pickup; timing = how soon it starts.
const PLANNER_WEIGHTS = { payout: 0.4, rate: 0.25, deadhead: 0.2, timing: 0.15, reposition: 0.2 };
const HOUR_MS = 3600000;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// Normalise an equipment/trailer type for comparison (uppercase, trimmed).
const normEquip = (x) => (x == null || x === "" ? null : String(x).toUpperCase().trim());

function ratePerMile(wo) {
  const p = wo.payout && wo.payout.value;
  const d = wo.totalDistance && wo.totalDistance.value;
  return p && d ? p / d : 0;
}

// Straight-line (great-circle) distance in miles between two lat/lng points.
function haversineMiles(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Filter loads to (a) within the precise nearby radius of the driver's drop-off
// (computed from lat/lng — the search net is wide, e.g. 50mi), and (b) the
// feasibility window (free+2h … free+48h, fits before next trip). Then score.
function planLoadsForDriver(avail, response, cfg) {
  const freeMs = Date.parse(avail.freeAtEffective);
  const maxWaitH = numOr(cfg && cfg.maxWaitHours, 48);
  const gapBeforeNextH = numOr(cfg && cfg.gapBeforeNextHours, 0);
  const lower = freeMs;
  let upper = freeMs + maxWaitH * HOUR_MS;
  // The next booked trip, minus the required gap before it, is the hard deadline.
  let effNext = null;
  if (avail.nextTripStart) {
    const n = Date.parse(avail.nextTripStart);
    if (!isNaN(n)) effNext = n - gapBeforeNextH * HOUR_MS;
  }
  if (effNext != null && effNext < upper) upper = effNext; // can't start after next commitment
  const wos = response && Array.isArray(response.workOpportunities) ? response.workOpportunities : [];

  const fl = avail.freeLocation || {};
  const dropLat = fl.latitude != null ? fl.latitude : null;
  const dropLng = fl.longitude != null ? fl.longitude : null;
  const nearby = Number(cfg && cfg.nearbyRadius) || 10;
  const minTrip = Number(cfg && cfg.minTripMiles) || 0;
  const mph = numOr(cfg && cfg.deadheadMph, 30);
  const matchEquip = cfg && cfg.matchEquipment !== false;
  const driverEquip = normEquip(avail.equipment);

  let droppedForTiming = 0;
  let droppedForDistance = 0;
  let droppedForShort = 0;
  let droppedForEquipment = 0;
  let droppedForDriveTime = 0;
  const feasible = [];
  for (const wo of wos) {
    const pk = wo.firstPickupTime ? Date.parse(wo.firstPickupTime) : NaN;
    if (isNaN(pk) || pk < lower || pk > upper) { droppedForTiming++; continue; }
    // Must deliver before the next booked trip (minus the required gap).
    if (effNext != null && wo.lastDeliveryTime) {
      const del = Date.parse(wo.lastDeliveryTime);
      if (!isNaN(del) && del > effNext) { droppedForTiming++; continue; }
    }
    // Skip tiny shuttle runs — they look great on £/mile but earn almost nothing.
    const tripMi = wo.totalDistance && wo.totalDistance.value;
    if (minTrip > 0 && tripMi != null && tripMi < minTrip) { droppedForShort++; continue; }
    // Equipment must match the driver's trailer (when both are known).
    const loadEquip = normEquip(wo.loads && wo.loads[0] && wo.loads[0].equipmentType);
    if (matchEquip && driverEquip && loadEquip && driverEquip !== loadEquip) { droppedForEquipment++; continue; }
    // Nearby filter: drop-off → pickup straight-line distance (fall back to
    // Amazon's deadhead when the load has no pickup coordinates).
    const sl = wo.startLocation || {};
    const computedDh = haversineMiles(dropLat, dropLng, sl.latitude, sl.longitude);
    const amazonDh = wo.deadhead && wo.deadhead.value != null ? wo.deadhead.value : null;
    const dhEff = computedDh != null ? computedDh : amazonDh;
    if (dhEff != null && dhEff > nearby) { droppedForDistance++; continue; }
    // Drive-time check: can the driver actually reach the pickup in time?
    // free + (deadhead miles / speed) must not be after the pickup time.
    if (dhEff != null && mph > 0) {
      const arriveMs = freeMs + (dhEff / mph) * HOUR_MS;
      if (arriveMs > pk) { droppedForDriveTime++; continue; }
    }
    // Repositioning: how far the delivery leaves the driver from where they started.
    const el = wo.endLocation || {};
    const returnMi = haversineMiles(dropLat, dropLng, el.latitude, el.longitude);
    feasible.push({ wo: wo, pk: pk, computedDh: computedDh, amazonDh: amazonDh, returnMi: returnMi });
  }

  const enriched = feasible.map((f) => {
    const rpm = ratePerMile(f.wo);
    const dh = f.computedDh != null ? f.computedDh : f.amazonDh; // prefer our computed deadhead
    const gapH = (f.pk - lower) / HOUR_MS;
    const payout = (f.wo.payout && f.wo.payout.value) || 0;
    const driveH = dh != null && mph > 0 ? dh / mph : null;
    return { wo: f.wo, rpm: rpm, dh: dh, amazonDh: f.amazonDh, gapH: gapH, payout: payout, returnMi: f.returnMi, driveH: driveH };
  });

  const maxRpm = Math.max(1e-9, ...enriched.map((e) => e.rpm));
  const maxPayout = Math.max(1e-9, ...enriched.map((e) => e.payout));
  const dhVals = enriched.map((e) => e.dh).filter((v) => v != null);
  const maxDh = dhVals.length ? Math.max(...dhVals) : 0;
  const retVals = enriched.map((e) => e.returnMi).filter((v) => v != null);
  const maxRet = retVals.length ? Math.max(...retVals) : 0;
  const windowH = (upper - lower) / HOUR_MS;

  const W = {
    payout: numOr(cfg && cfg.weightPayout, PLANNER_WEIGHTS.payout),
    rate: numOr(cfg && cfg.weightRate, PLANNER_WEIGHTS.rate),
    deadhead: numOr(cfg && cfg.weightDeadhead, PLANNER_WEIGHTS.deadhead),
    timing: numOr(cfg && cfg.weightTiming, PLANNER_WEIGHTS.timing),
    reposition: numOr(cfg && cfg.weightReposition, PLANNER_WEIGHTS.reposition),
  };
  for (const e of enriched) {
    const payoutScore = e.payout / maxPayout;
    const rateScore = e.rpm / maxRpm;
    const dhScore = e.dh == null || maxDh === 0 ? 0.5 : 1 - e.dh / maxDh;
    const timingScore = windowH > 0 ? 1 - e.gapH / windowH : 0.5;
    const repoScore = e.returnMi == null || maxRet === 0 ? 0.5 : 1 - e.returnMi / maxRet;
    e.score =
      W.payout * payoutScore + W.rate * rateScore + W.deadhead * dhScore +
      W.timing * timingScore + W.reposition * repoScore;
  }
  enriched.sort((a, b) => b.score - a.score);

  function toRec(e) {
    const sl = e.wo.startLocation || {};
    const el = e.wo.endLocation || {};
    return {
      loadId: e.wo.id,
      pickup: {
        city: sl.city || null,
        lat: sl.latitude != null ? sl.latitude : null,
        lng: sl.longitude != null ? sl.longitude : null,
        code: sl.label || sl.stopCode || null,
        time: e.wo.firstPickupTime || null,
      },
      dropoff: { city: el.city || null, domicile: el.domicile || null, time: e.wo.lastDeliveryTime || null },
      deadheadMiles: e.dh != null ? r2(e.dh) : null,
      amazonDeadheadMiles: e.amazonDh != null ? r2(e.amazonDh) : null,
      tripMiles: e.wo.totalDistance && e.wo.totalDistance.value,
      payout: e.wo.payout && e.wo.payout.value,
      payoutUnit: (e.wo.payout && e.wo.payout.unit) || null,
      ratePerMile: r2(e.rpm),
      equipment: (e.wo.loads && e.wo.loads[0] && e.wo.loads[0].equipmentType) || null,
      workType: e.wo.workOpportunityType || null,
      returnMiles: e.returnMi != null ? r2(e.returnMi) : null,
      deadheadDriveHours: e.driveH != null ? r2(e.driveH) : null,
      score: r3(e.score),
      components: {
        ratePerMile: r2(e.rpm),
        deadheadMiles: e.dh != null ? r2(e.dh) : null,
        pickupGapHours: r2(e.gapH),
        returnMiles: e.returnMi != null ? r2(e.returnMi) : null,
      },
    };
  }

  return {
    recommended: enriched.length ? toRec(enriched[0]) : null,
    alternatives: enriched.slice(1, 4).map(toRec),
    feasibleLoads: enriched.map(toRec), // full list, for the load-centric aggregation
    candidatesConsidered: wos.length,
    feasibleCount: feasible.length,
    droppedForTiming: droppedForTiming,
    droppedForDistance: droppedForDistance,
    droppedForShort: droppedForShort,
    droppedForEquipment: droppedForEquipment,
    droppedForDriveTime: droppedForDriveTime,
  };
}

// Aggregate every feasible (driver, load) pair into a load-centric view:
// one entry per unique load, with the list of drivers who can take it
// (best-fit driver first). Loads ranked by their best per-driver score.
function buildTopLoads(perDriverResults, topN) {
  const byLoad = new Map();
  for (const dr of perDriverResults) {
    if (!dr || !Array.isArray(dr.feasibleLoads)) continue;
    for (const rec of dr.feasibleLoads) {
      if (!rec || !rec.loadId) continue;
      let entry = byLoad.get(rec.loadId);
      if (!entry) {
        entry = {
          loadId: rec.loadId,
          pickup: rec.pickup,
          dropoff: rec.dropoff,
          tripMiles: rec.tripMiles,
          payout: rec.payout,
          payoutUnit: rec.payoutUnit,
          ratePerMile: rec.ratePerMile,
          equipment: rec.equipment,
          workType: rec.workType,
          bestScore: rec.score,
          suitableDrivers: [],
        };
        byLoad.set(rec.loadId, entry);
      }
      if (rec.score > entry.bestScore) entry.bestScore = rec.score;
      entry.suitableDrivers.push({
        driver: dr.driver,
        availableFrom: dr.availableFrom,
        nextTripStart: dr.nextTripStart,
        currentDropoff: dr.currentTrip && dr.currentTrip.dropOff ? dr.currentTrip.dropOff.city : null,
        deadheadMiles: rec.deadheadMiles,
        pickupGapHours: rec.components && rec.components.pickupGapHours,
        returnMiles: rec.returnMiles,
        fitScore: rec.score,
      });
    }
  }
  const loads = Array.from(byLoad.values());
  for (const l of loads) {
    l.suitableDrivers.sort((a, b) => b.fitScore - a.fitScore);
    l.driverCount = l.suitableDrivers.length;
  }
  loads.sort((a, b) => b.bestScore - a.bestScore);
  return topN > 0 ? loads.slice(0, topN) : loads;
}

let isPlanning = false;
async function runPlanner() {
  if (isPlanning) { await log("planner", "Planner already running.", "warn"); return; }
  isPlanning = true;
  await resetLog("planner");
  try {
    const cfg = await getConfig();
    const tab = await findRelayTab();
    if (!tab) {
      await log("planner", "No Amazon Relay tab found — open the Relay site (logged in) first.", "error");
      return;
    }
    const csrf = await resolveCsrf(tab.id);
    if (!csrf) {
      await log("planner", "No CSRF token found. Reload the Relay tab, run one search, then retry.", "error");
      return;
    }

    await log("planner", "Fetching in-transit trips…");
    const inTransit = await fetchEntitiesFresh(tab.id, cfg, csrf, self.RLB_PAYLOADS.inTransit);
    await log("planner", "In-transit entities: " + inTransit.length);

    await log("planner", "Fetching upcoming trips…");
    const upcoming = await fetchEntitiesFresh(tab.id, cfg, csrf, self.RLB_PAYLOADS.upcoming);
    await log("planner", "Upcoming entities: " + upcoming.length);

    const availability = buildAvailability(inTransit.concat(upcoming), cfg);
    await chrome.storage.local.set({ plannerAvailability: availability, plannerResults: [] });
    await log("planner", "Built availability for " + availability.length + " driver(s). Searching loads…", "success");

    // Diagnostic: show how each driver's free time was derived, so a wrong
    // "free now" (e.g. in-transit end time not applied) is obvious in the log.
    for (const a of availability) {
      await log(
        "planner",
        "  · " + a.driver.name +
          ": lastTripEnd=" + (a.lastTripEndTime || "—") +
          ", freeAt=" + a.freeAtEffective +
          (a.alreadyFree ? " (already free)" : "") +
          ", nextTrip=" + (a.nextTripStart || "—"),
        "info"
      );
    }

    const base = Math.max(0, Number(cfg.delayMs) || 300);
    const results = [];
    let withRec = 0;

    for (let i = 0; i < availability.length; i++) {
      const a = availability[i];
      const fl = a.freeLocation || {};
      const baseRec = {
        driver: a.driver,
        currentTrip: {
          tripId: a.lastTripId,
          state: a.lastTripState,
          finishAt: a.lastTripEndTime,
          dropOff: fl,
          domicile: a.domicile,
          equipment: a.equipment,
        },
        availableFrom: a.freeAtEffective,
        alreadyFree: a.alreadyFree,
        nextTripStart: a.nextTripStart,
        freeWindowHours: a.freeWindowHours,
        earliestPickupAllowed: new Date(Date.parse(a.freeAtEffective)).toISOString(),
        latestPickupAllowed: (function () {
          let u = Date.parse(a.freeAtEffective) + numOr(cfg.maxWaitHours, 48) * HOUR_MS;
          if (a.nextTripStart) {
            const n = Date.parse(a.nextTripStart) - numOr(cfg.gapBeforeNextHours, 0) * HOUR_MS;
            if (!isNaN(n) && n < u) u = n;
          }
          return new Date(u).toISOString();
        })(),
      };

      if (fl.latitude == null || fl.longitude == null || !fl.city) {
        const note = !a.lastTripId
          ? "Unknown current location — driver has only future trips"
          : "Drop-off location has no coordinates";
        results.push(Object.assign(baseRec, { recommended: null, alternatives: [], note: note }));
        await log("planner", i + 1 + "/" + availability.length + " " + a.driver.name + ": " + note + " — skipped", "warn");
        await chrome.storage.local.set({ plannerResults: results });
        continue;
      }

      try {
        const loc = {
          name: fl.city,
          stateCode: "UK",
          country: "EU",
          latitude: fl.latitude,
          longitude: fl.longitude,
          displayValue: fl.city + ", UK",
        };
        // Search the full board (no date restriction) so near-term loads always
        // show; our own feasibility filter picks what fits each driver's window.
        const payload = buildSearchPayload(loc, cfg);
        const resp = await withRetry(() => searchLoadsInPage(tab.id, cfg, payload, csrf), "search", a.driver.name, 3);
        const plan = planLoadsForDriver(a, resp, cfg);
        results.push(Object.assign(baseRec, plan));
        if (plan.recommended) withRec++;
        await log(
          "planner",
          i + 1 + "/" + availability.length + " " + a.driver.name + " @ " + fl.city + ": " +
            plan.feasibleCount + " feasible / " + plan.candidatesConsidered + " loads → " +
            (plan.recommended
              ? "£" + plan.recommended.payout + " @ " + plan.recommended.ratePerMile + "/mi, " + plan.recommended.deadheadMiles + "mi dh"
              : "no feasible load"),
          plan.recommended ? "success" : "info"
        );
      } catch (e) {
        results.push(Object.assign(baseRec, { recommended: null, alternatives: [], error: e && e.message ? e.message : String(e) }));
        await log("planner", i + 1 + "/" + availability.length + " " + a.driver.name + ": ERROR " + (e.message || e), "error");
        await logError("background/runPlanner/driver", e, { driver: a.driver && a.driver.name, index: i });
      }
      await chrome.storage.local.set({ plannerResults: results });
      await sleep(base + rand(base));
    }

    // Build the load-centric view: top N loads, each with its suitable drivers.
    const topLoads = buildTopLoads(results, Number(cfg.topLoads) || 30);
    // Strip the bulky per-driver feasible lists before persisting the per-driver view.
    const slimResults = results.map((r) => {
      const c = Object.assign({}, r);
      delete c.feasibleLoads;
      return c;
    });
    await chrome.storage.local.set({ plannerResults: slimResults, plannerTopLoads: topLoads });
    await log(
      "planner",
      "Plan complete. " + topLoads.length + " top load(s) across " + withRec + "/" + availability.length +
        " driver(s) with a feasible match.",
      "success"
    );
    if (topLoads.length) {
      const t = topLoads[0];
      await log(
        "planner",
        "Best load: £" + t.payout + " @ " + t.ratePerMile + "/mi, " + t.tripMiles + "mi, " +
          (t.pickup && t.pickup.city) + " → " + (t.dropoff && t.dropoff.city) + " — " +
          t.driverCount + " suitable driver(s).",
        "info"
      );
    }
  } catch (e) {
    await log("planner", "Error: " + (e && e.message ? e.message : String(e)), "error");
    await logError("background/runPlanner", e);
  } finally {
    isPlanning = false;
    await setRunning("planner", false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger handlers run fire-and-forget (the switch doesn't await them), so a
// thrown error inside one would otherwise vanish silently instead of surfacing
// anywhere. Catch and route it into the durable error log.
function safeTrigger(name, fn) {
  Promise.resolve()
    .then(fn)
    .catch((e) => logError("background/trigger/" + name, e));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  switch (msg.type) {
    case "start-harvest":
      safeTrigger("start-harvest", harvest);
      break;
    case "start-find-loads":
      safeTrigger("start-find-loads", startFindLoads);
      break;
    case "stop-find-loads":
      safeTrigger("stop-find-loads", stopFindLoads);
      break;
    case "resume-find-loads":
      safeTrigger("resume-find-loads", resumeFindLoads);
      break;
    case "retry-failed-loads":
      safeTrigger("retry-failed-loads", retryFailed);
      break;
    case "start-sync-trips":
      safeTrigger("start-sync-trips", syncInTransitTrips);
      break;
    case "start-planner":
      safeTrigger("start-planner", runPlanner);
      break;
    default:
      return;
  }
  sendResponse({ ok: true });
});

// ─── Load board highlight support ─────────────────────────────────────────────
// Build driver availability only (no per-driver load search), so the load-board
// content script can score whatever loads the page is showing.

// Turn a fetchEntities() rejection into a message that tells the user what to
// actually do, since "HTTP 500" alone gives no next step.
function describeFetchEntitiesError(e, which) {
  const status = e && e.status;
  const serverMsg = e && e.body ? " Server said: " + e.body : "";
  if (e && e.body && /csrf/i.test(e.body)) {
    return "Relay rejected the " + which + " request (HTTP " + status + ") — the CSRF token was not accepted, and capturing a fresh one from the Trips page also failed. Make sure you're signed in to Relay, let the opened Trips window finish loading, then retry." + serverMsg;
  }
  if (status === 401 || status === 403) {
    return "Relay rejected the request (HTTP " + status + ", " + which + ") — your session token expired. Reload the Relay tab and sign in again, then retry." + serverMsg;
  }
  if (status === 500) {
    return "Relay's server returned HTTP 500 for " + which + " trips, even after retrying with the original page size." + serverMsg;
  }
  if (status) {
    return "Relay returned HTTP " + status + " for " + which + " trips." + serverMsg;
  }
  return (e && e.message) || String(e);
}

async function refreshAvailabilityOnly() {
  const cfg = await getConfig();
  const tab = await findRelayTab();
  if (!tab) return { ok: false, error: "No Amazon Relay tab found." };
  const csrf = await resolveCsrf(tab.id);
  if (!csrf) return { ok: false, error: "No CSRF token — reload the Relay tab." };
  let inTransit, upcoming;
  try {
    inTransit = await fetchEntitiesFresh(tab.id, cfg, csrf, self.RLB_PAYLOADS.inTransit);
  } catch (e) {
    return { ok: false, error: describeFetchEntitiesError(e, "in-transit") };
  }
  try {
    upcoming = await fetchEntitiesFresh(tab.id, cfg, csrf, self.RLB_PAYLOADS.upcoming);
  } catch (e) {
    return { ok: false, error: describeFetchEntitiesError(e, "upcoming") };
  }
  // NOTE: this used to also pop open in-transit/upcoming windows here for the
  // user to see. Removed: entitiesV2 data above is already fetched headlessly
  // via scripting, so those windows were purely cosmetic — but they steal OS
  // focus from the load-board tab, and the very next step (autopilot typing
  // into the origin combobox) would then silently fail because the tab wasn't
  // the focused/active one. That was the cause of "1st run finds 0 loads,
  // origin box empty, 2nd run works" — it only ever happened on a cold run
  // (the one that calls this function) and never on a warm run (which skips
  // straight to searching with cached availability).
  const availability = buildAvailability(inTransit.concat(upcoming), cfg);
  await chrome.storage.local.set({ plannerAvailability: availability, plannerAvailabilityAt: Date.now() });
  return { ok: true, count: availability.length };
}

// Score page-provided loads against stored availability → load-centric list
// (each load with its suitable drivers). No network; pure computation.
async function scoreLoadsForPage(loads) {
  const cfg = await getConfig();
  const stored = await chrome.storage.local.get(["plannerAvailability", "plannerAvailabilityAt"]);
  const availability = stored.plannerAvailability || [];
  if (!availability.length) return { ok: true, drivers: 0, loads: [], availabilityAt: stored.plannerAvailabilityAt || null };
  const response = { workOpportunities: Array.isArray(loads) ? loads : [] };
  const perDriver = [];
  // Aggregate why loads get dropped, so the panel/console can explain "0 matches".
  const diag = {
    driversTotal: availability.length,
    driversUsable: 0,
    driversNoLocation: 0,
    droppedForTiming: 0,
    droppedForDistance: 0,
    droppedForShort: 0,
    droppedForEquipment: 0,
    droppedForDriveTime: 0,
    feasiblePairs: 0,
  };
  for (const a of availability) {
    const fl = a.freeLocation || {};
    if (fl.latitude == null || fl.longitude == null || !fl.city) { diag.driversNoLocation++; continue; }
    diag.driversUsable++;
    const plan = planLoadsForDriver(a, response, cfg);
    diag.droppedForTiming += plan.droppedForTiming || 0;
    diag.droppedForDistance += plan.droppedForDistance || 0;
    diag.droppedForShort += plan.droppedForShort || 0;
    diag.droppedForEquipment += plan.droppedForEquipment || 0;
    diag.droppedForDriveTime += plan.droppedForDriveTime || 0;
    diag.feasiblePairs += plan.feasibleCount || 0;
    perDriver.push(Object.assign(
      { driver: a.driver, availableFrom: a.freeAtEffective, nextTripStart: a.nextTripStart, currentTrip: { dropOff: fl } },
      plan
    ));
  }
  const topLoads = buildTopLoads(perDriver, 0); // 0 = keep every matched load, not just top N
  return { ok: true, drivers: availability.length, loads: topLoads, diag: diag, availabilityAt: stored.plannerAvailabilityAt || null };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "refresh-availability") {
    refreshAvailabilityOnly()
      .then(sendResponse)
      .catch((e) => {
        logError("background/refresh-availability", e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true; // keep the channel open for the async response
  }
  if (msg.type === "score-loads") {
    scoreLoadsForPage(msg.loads || [])
      .then(sendResponse)
      .catch((e) => {
        logError("background/score-loads", e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }
});
