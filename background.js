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
  // Bare host base. Each endpoint appends its own path: shifts → /api/v1/…,
  // rlb-settings → /v1/… (see activeDriverShiftsUrl / rlbSettingsUrl).
  ontrackUrl: "https://afp-api.fleetyes.com",
  ingestUrl: "",
  token: "",
  carrierCode: "", // e.g. "AMRTL" — used for the FleetYes approved-places lookup
  useFleetyesPlaces: false, // ON → unassigned drivers searched from FleetYes approved places; OFF → Relay domicile
  letters: "abcdefghijklmnopqrstuvwxyz",
  prefix: ", ",
  delayMs: 500,
  searchRadius: 250,
  nearbyRadius: 10,
  resultSize: 50,
  maxLocations: 2,
  minTripMiles: 25,
  topLoads: 30,
  searchLocation: "", // the city all scheduled drivers are searched FROM (Planning rules)
  // Planner timing rules (hours).
  restHours: 0, // rest after finishing a trip before the driver is available
  availabilityLeadHours: 2, // treat a driver as free this long before the trip ends (earliest pickup = tripEnd − this)
  maxWaitHours: 48, // latest pickup = free + this
  gapBeforeNextHours: 2, // load must deliver this long before the next booked trip
  deadheadMph: 30, // effective speed over straight-line deadhead miles (road-time check)
  matchEquipment: true, // only recommend loads whose trailer matches the driver's
  // Planner scoring weights, as percentages (need not sum to exactly 100 —
  // they're normalised by their sum in planLoadsForDriver either way).
  weightPayout: 40,
  weightRate: 25,
  weightDeadhead: 20,
  weightTiming: 15,
  weightReposition: 20, // favours loads that finish near where the driver started
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
  const keys = ["entities", "cities", "results", "data", "suggestions", "items", "locations", "drivers"];
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
            endTime: e.endTime || e.lastPickupTime || e.lastDeliveryTime || null,
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

// ── schedule-based availability (active-driver-shifts API) ───────────────────
// Availability comes from the shift schedule API instead of Relay trips. Each
// driver has a shift window (working hours); they're FREE AFTER the shift ends.
// All drivers are searched FROM one configured Search Location (cfg.searchLocation,
// set in Planning rules) — not the driver's own location. The API's per-driver
// location is still parsed and kept (apiLocation) for other uses. Equipment stays
// null (the equipment filter skips loads only when both sides are known → no filter).

// The OnTrack base URL is now a bare host (https://afp-api.fleetyes.com/).
// Each endpoint appends its own path prefix onto the scheme+host origin, so a
// stray path on the setting (e.g. a legacy …/api/v1) never doubles up.
function ontrackOrigin(cfg) {
  const raw = (cfg.ontrackUrl || "").replace(/\/+$/, "");
  try { return new URL(raw).origin; }                    // scheme + host only
  catch (e) { return raw.replace(/(\/\/[^/]+).*$/, "$1"); } // fallback: keep up to host
}
// Legacy /api/vN root used only by approved-places (left unchanged for now).
function ontrackApiRoot(cfg) {
  const raw = (cfg.ontrackUrl || "").replace(/\/+$/, "");
  const m = raw.match(/^(.*\/api\/v\d+)(?:\/|$)/i);
  if (m) return m[1];
  return ontrackOrigin(cfg) + "/api/v1"; // bare host → assume /api/v1
}
// active-driver-shifts: {{base}}/api/v1/active-driver-shifts
function activeDriverShiftsUrl(cfg) {
  return ontrackOrigin(cfg) + "/api/v1/active-driver-shifts";
}
// rlb-settings: {{base}}/v1/rlb-settings
function rlbSettingsUrl(cfg) {
  return ontrackOrigin(cfg) + "/v1/rlb-settings";
}
// init: {{base}}/api/v1/init?carrier=… — issues the Bearer token for a carrier.
function initUrl(cfg) {
  return ontrackOrigin(cfg) + "/api/v1/init";
}

// ── RLB settings sync ─────────────────────────────────────────────────────────
// The FleetYes dashboard is the editor for the planning rules + developer
// settings; the backend is the source of truth. Here we GET them for this
// carrier and MERGE the two groups into chrome.storage.local, so the rest of the
// workflow (getConfig) picks them up unchanged. The popup no longer edits these
// keys — they come from the server.
//
// The carrier code is read off the Relay page (#case-carrier-scac) and passed in
// by loadboard.js. Missing carrier code / token are CONFIG errors so the caller
// can surface them instead of silently running on stale local values.
//
// Only the keys the server owns are written; local-only keys (token, ontrackUrl,
// carrierCode, the harvest knobs, etc.) are left untouched.
// searchLocation now comes FROM the server (rlb-settings response) — it's the
// single origin all loads are searched from. All planning rules are server-owned.
const RLB_SERVER_PLANNING_KEYS = [
  "searchLocation", "nearbyRadius", "minTripMiles", "restHours",
  "availabilityLeadHours", "maxWaitHours", "gapBeforeNextHours",
  "deadheadMph", "matchEquipment",
];
const RLB_SERVER_DEVELOPER_KEYS = [
  "useFleetyesPlaces", "arEnabled", "arMin", "arMax",
  "weightPayout", "weightRate", "weightDeadhead", "weightTiming", "weightReposition",
];

// Issue a fresh Bearer token for this carrier via /api/v1/init and cache it
// in chrome.storage.local (both on the returned cfg and persisted), so
// subsequent calls in this session and future ones reuse it without prompting
// the user. The popup no longer collects a token manually — this is the only
// place a token is minted.
async function fetchInitToken(cfg, carrierCode) {
  const url = initUrl(cfg) + "?carrier=" + encodeURIComponent(carrierCode);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("init HTTP " + res.status + ": " + text.slice(0, 200));
    await logError("background/fetchInitToken", err, { url: url, status: res.status });
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("init response was not JSON"); }
  const key = data && data.key;
  if (!key) throw new Error("init response did not include a key");
  return key;
}

// Make sure cfg.token is populated, fetching+caching one via /api/v1/init when
// missing. Mutates cfg.token in place and persists it, so every downstream call
// (rlb-settings, active-driver-shifts, approved-places) keeps reading cfg.token
// exactly as before. refreshAvailabilityOnly clears cfg.token before each
// "Find my best loads" run, so this always re-inits on that path.
async function ensureToken(cfg, carrierCode) {
  if (cfg.token) return cfg.token;
  if (!carrierCode) {
    const err = new Error("Carrier code not found on the Relay page — open a Relay Load Board page and try again.");
    err.config = true;
    throw err;
  }
  const key = await fetchInitToken(cfg, carrierCode);
  cfg.token = key;
  await chrome.storage.local.set({ token: key });
  return key;
}

async function fetchRlbSettings(cfg, carrierCode) {
  if (!carrierCode) {
    const err = new Error("No carrier code found on the Relay page (#case-carrier-scac).");
    err.config = true;
    throw err;
  }
  await ensureToken(cfg, carrierCode);
  const url = rlbSettingsUrl(cfg) + "?carrier_code=" + encodeURIComponent(carrierCode);
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + cfg.token } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("rlb-settings HTTP " + res.status + ": " + text.slice(0, 200));
    await logError("background/fetchRlbSettings", err, { url: url, status: res.status });
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("rlb-settings response was not JSON"); }
  return data && typeof data === "object" ? data : {};
}

// GET the server settings for this carrier and merge them into storage.
// Returns { ok, applied } where `applied` is the count of keys written.
async function syncRlbSettings(carrierCode) {
  const cfg = await getConfig();
  const data = await fetchRlbSettings(cfg, carrierCode);
  const planning = (data && data.planningRules)     || {};
  const developer = (data && data.developerSettings) || {};

  const patch = {};
  for (const k of RLB_SERVER_PLANNING_KEYS)  { if (k in planning)  patch[k] = planning[k]; }
  for (const k of RLB_SERVER_DEVELOPER_KEYS) { if (k in developer) patch[k] = developer[k]; }

  // arEnabled is only safe with a valid interval range — mirror the dashboard guard.
  if ("arMin" in patch && "arMax" in patch && numOr(patch.arMin, 0) > numOr(patch.arMax, 0)) {
    patch.arEnabled = false;
  }

  const applied = Object.keys(patch).length;
  if (applied > 0) await chrome.storage.local.set(patch);
  return { ok: true, applied: applied };
}

// Fetch the carrier's active driver shifts. Uses the same auth as the other
// OnTrack/FleetYes calls (carrier_code query + Bearer token from settings).
// Missing carrier code / token are CONFIG errors (config: true) so the caller
// surfaces them to the user instead of quietly falling back to Relay trips.
async function fetchDriverSchedule(cfg) {
  if (!cfg.carrierCode) {
    const err = new Error("Carrier code not found on the Relay page — open a Relay Load Board page and try again.");
    err.config = true;
    throw err;
  }
  await ensureToken(cfg, cfg.carrierCode);
  const url = activeDriverShiftsUrl(cfg) + "?carrier_code=" + encodeURIComponent(cfg.carrierCode);
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + cfg.token } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("active-driver-shifts HTTP " + res.status + ": " + text.slice(0, 200));
    await logError("background/fetchDriverSchedule", err, { url: url, status: res.status });
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("active-driver-shifts response was not JSON"); }
  // Tolerant to the top-level array key (drivers / shifts / data / …).
  const rows = extractEntries(data);
  return Array.isArray(rows) ? rows : [];
}

// Pull a driver's END location { latitude, longitude } out of a schedule row —
// where they finish their shift (their real drop-off). The API uses
// end_location_lat / end_location_lng; we stay tolerant to a few other shapes
// as a fallback. Returns null if absent.
function scheduleRowCoords(r) {
  if (!r || typeof r !== "object") return null;
  const firstNum = (...vals) => {
    for (const v of vals) { const n = num(v); if (n != null) return n; }
    return null;
  };
  // Primary: the driver's shift END location (drop-off).
  let lat = firstNum(r.end_location_lat, r.endLocationLat, r.latitude, r.lat, r.Latitude);
  let lon = firstNum(r.end_location_lng, r.end_location_lon, r.endLocationLng, r.longitude, r.lng, r.lon, r.Longitude);
  // Or a nested location/coords object, e.g. { location: { latitude, longitude } }.
  if (lat == null || lon == null) {
    const nested = r.location || r.coords || r.coordinates || r.home || r.homeLocation || null;
    if (nested && typeof nested === "object") {
      lat = firstNum(nested.latitude, nested.lat);
      lon = firstNum(nested.longitude, nested.lng, nested.lon);
    }
  }
  if (lat == null || lon == null) return null;
  const city = r.end_city || r.city || (r.location && r.location.city) || null;
  return { latitude: lat, longitude: lon, city: city };
}

// Reverse-geocode lat/lng → a human-readable place name via OpenStreetMap
// Nominatim (free, no key). Results are cached in storage keyed by rounded
// coords so we never hit the API twice for the same place (Nominatim asks for
// ≤1 req/sec — caching keeps us well under that). Returns a city-ish string or null.
async function reverseGeocode(lat, lon) {
  if (lat == null || lon == null) return null;
  const key = "rg:" + Number(lat).toFixed(4) + "," + Number(lon).toFixed(4);
  try {
    const cached = await chrome.storage.local.get([key]);
    if (cached[key] !== undefined) return cached[key];
  } catch (e) { /* ignore */ }

  try {
    const url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=" +
      encodeURIComponent(lat) + "&lon=" + encodeURIComponent(lon);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Nominatim HTTP " + res.status);
    const data = await res.json();
    const a = (data && data.address) || {};
    const name =
      a.city || a.town || a.village || a.suburb || a.county ||
      a.state_district || a.state || (data && data.name) || null;
    const label = name ? (a.country_code ? name + ", " + String(a.country_code).toUpperCase() : name) : null;
    try { await chrome.storage.local.set({ [key]: label }); } catch (e) { /* ignore */ }
    return label;
  } catch (e) {
    await logError("background/reverseGeocode", e, { lat: lat, lon: lon });
    try { await chrome.storage.local.set({ [key]: null }); } catch (e2) { /* ignore */ }
    return null;
  }
}

// Parse "YYYY-MM-DD" + "HH:MM" as UK local time → epoch ms. Relay/UK operates in
// Europe/London, and the schedule times are wall-clock UK, so we anchor them to
// that zone (handles BST/GMT) rather than the worker's own timezone.
function parseUkLocalMs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr).trim());
  if (!dm || !tm) return null;
  const y = +dm[1], mo = +dm[2], d = +dm[3], hh = +tm[1], mi = +tm[2];
  // Start from the UTC interpretation, then correct by the Europe/London offset
  // at that instant (BST = +1, GMT = 0) so the wall-clock time lands correctly.
  const naiveUtc = Date.UTC(y, mo - 1, d, hh, mi, 0);
  const offsetMin = londonOffsetMinutes(naiveUtc);
  return naiveUtc - offsetMin * 60000;
}

// Europe/London UTC offset (in minutes) for a given instant, via Intl — avoids
// hardcoding BST/GMT switch dates.
function londonOffsetMinutes(ms) {
  try {
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(ms));
    const get = (t) => +parts.find((p) => p.type === t).value;
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - ms) / 60000);
  } catch (e) {
    return 0; // fall back to UTC if Intl/timezone data is unavailable
  }
}

// Build availability records from the shifts API. Every scheduled driver is
// searched FROM the single configured Search Location (cfg.searchLocation, set in
// Planning rules) — this is the freeLocation the load search/scoring uses. The
// API's own per-driver location is still parsed and kept (apiLocation) for other
// purposes, but is NOT used for the search. tabId resolves the Search Location
// city to coordinates via the Relay cities endpoint — no trips are read.
async function buildScheduleAvailability(tabId, cfg) {
  const now = Date.now();

  // Validate config BEFORE hitting the API, so a missing Search Location fails
  // fast (no wasted request) with a clear message. These are CONFIG errors
  // (config: true) so the caller surfaces them instead of falling back to Relay.
  const searchLoc = (cfg.searchLocation || "").trim();
  if (!searchLoc) {
    const err = new Error("No Search Location set — enter one in Planning rules (settings).");
    err.config = true;
    throw err;
  }
  const c = await lookupCityCoords(tabId, cfg, searchLoc);
  if (!c) {
    const err = new Error('Could not resolve Search Location "' + searchLoc + '" to coordinates.');
    err.config = true;
    throw err;
  }
  const freeLocation = { city: c.name, country: c.country || null, latitude: c.latitude, longitude: c.longitude };

  // Then fetch the shifts (also throws config errors for missing carrier/token).
  const rows = await fetchDriverSchedule(cfg);

  const out = [];
  let noEnd = 0;
  for (const r of rows) {
    const name = (r && r.driver_name) ? String(r.driver_name).trim() : null;
    if (!name) continue;
    const endMs = parseUkLocalMs(r.end_date, r.end_time);
    if (endMs == null) { noEnd++; continue; }

    // The driver's OWN end location (drop-off) from the API — shown in the drivers
    // panel's "Free city" column. NOT used to search (that's freeLocation above).
    // City name is reverse-geocoded from lat/lng below if the API didn't supply one.
    const rowLoc = scheduleRowCoords(r);
    const apiLocation = rowLoc ? { city: rowLoc.city || null, latitude: rowLoc.latitude, longitude: rowLoc.longitude } : null;

    // Free AFTER the shift ends. If the shift already ended, they're free now.
    const effFreeStart = Math.max(endMs, 0);
    out.push({
      driver: { id: null, staticDriverId: null, name: name, phoneNumber: null, email: null },
      lastTripId: null,
      lastTripState: null,
      lastTripEndTime: new Date(endMs).toISOString(),
      freeLocation: freeLocation, // search FROM the configured Search Location
      apiLocation: apiLocation,   // the driver's own location from the API (kept, unused for search)
      domicile: null,
      equipment: null,
      freeAt: effFreeStart > now ? new Date(effFreeStart).toISOString() : null,
      freeAtEffective: new Date(effFreeStart).toISOString(),
      alreadyFree: !(effFreeStart > now),
      nextTripStart: null,
      freeWindowHours: null,
      scheduleShift: { start: parseUkLocalMs(r.start_date, r.start_time), end: endMs },
    });
  }
  // Reverse-geocode each driver's END location (drop-off) to a city name for the
  // drivers panel. Dedupe by rounded coords so identical locations resolve once,
  // and only for rows the API didn't already name. reverseGeocode caches results.
  const rgCache = new Map();
  for (const rec of out) {
    const al = rec.apiLocation;
    if (!al || al.city || al.latitude == null || al.longitude == null) continue;
    const k = Number(al.latitude).toFixed(4) + "," + Number(al.longitude).toFixed(4);
    let cityName;
    if (rgCache.has(k)) { cityName = rgCache.get(k); }
    else { cityName = await reverseGeocode(al.latitude, al.longitude); rgCache.set(k, cityName); }
    al.city = cityName || null;
  }

  out.sort((x, y) => Date.parse(x.freeAtEffective) - Date.parse(y.freeAtEffective));
  console.log(
    "[RLB availability] built " + out.length + ' schedule-based driver(s) searching from "' + searchLoc +
    '"; dropped ' + noEnd + " (no/invalid shift end)."
  );
  return out;
}

// Default scoring weights, as percentages (normalised by their sum before use,
// so they don't need to add up to exactly 100). Components are emitted in the
// output so ranking is transparent and tunable — adjust here (or in FleetYes).
// payout = total £ of the run (favours big jobs over tiny shuttles);
// rate = £/mile; deadhead = empty miles to pickup; timing = how soon it starts.
const PLANNER_WEIGHTS = { payout: 40, rate: 25, deadhead: 20, timing: 15, reposition: 20 };
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
  // Availability lead: treat the driver as free this long BEFORE the trip
  // formally ends, so loads picking up slightly before tripEnd still match.
  // Widens the window on the early side only — latest pickup is unchanged.
  const matchFromMs = freeMs - numOr(cfg && cfg.availabilityLeadHours, 0) * HOUR_MS;
  const lower = matchFromMs;
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
    // Departing at the lead-adjusted availability (matchFromMs), deadhead/speed
    // must get them there by the pickup time.
    if (dhEff != null && mph > 0) {
      const arriveMs = matchFromMs + (dhEff / mph) * HOUR_MS;
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

  // Weights may arrive as raw fractions (0.4) or as percentages (40) — either
  // way we normalise by their sum so the combined score always lands on 0..1,
  // regardless of what scale FleetYes sends them on.
  const Wraw = {
    payout: numOr(cfg && cfg.weightPayout, PLANNER_WEIGHTS.payout),
    rate: numOr(cfg && cfg.weightRate, PLANNER_WEIGHTS.rate),
    deadhead: numOr(cfg && cfg.weightDeadhead, PLANNER_WEIGHTS.deadhead),
    timing: numOr(cfg && cfg.weightTiming, PLANNER_WEIGHTS.timing),
    reposition: numOr(cfg && cfg.weightReposition, PLANNER_WEIGHTS.reposition),
  };
  const Wsum = Wraw.payout + Wraw.rate + Wraw.deadhead + Wraw.timing + Wraw.reposition || 1;
  const W = {
    payout: Wraw.payout / Wsum,
    rate: Wraw.rate / Wsum,
    deadhead: Wraw.deadhead / Wsum,
    timing: Wraw.timing / Wsum,
    reposition: Wraw.reposition / Wsum,
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

// ─── Unassigned drivers ─────────────────────────────────────────────────────
// entitiesV2 (in-transit/upcoming) only ever returns drivers who ARE on a
// trip — a driver with no trip at all is invisible to buildAvailability().
// /api/hos/drivers returns EVERY driver on the account; a driver from that
// list whose id isn't covered by any trip is unassigned right now. Compare
// ids via entities[].drivers[].id (e.g. "amzn1.relay.d.v1.T-41b3QuD71yHLso8Bt")
// vs the drivers API's latestTransientDriverId — same id space, different field name.
async function fetchAllDrivers(tabId, cfg) {
  const url = cfg.relayBase.replace(/\/+$/, "") + "/api/hos/drivers";
  const r = await runInPage(tabId, url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) {
    const err = new Error("Relay drivers HTTP " + r.status);
    await logError("background/fetchAllDrivers", err, { url: url, status: r.status, body: (r.body || "").slice(0, 300) });
    throw err;
  }
  let data;
  try {
    data = JSON.parse(r.body);
  } catch (e) {
    await logError("background/fetchAllDrivers/parse", e, { url: url, body: (r.body || "").slice(0, 300) });
    throw new Error("Relay drivers response was not JSON");
  }
  const entries = extractEntries(data);
  console.log("[RLB drivers] fetched " + entries.length + " total driver(s) from /api/hos/drivers:", entries);
  return entries;
}

// The set of driver ids already covered by an in-transit/upcoming trip.
function assignedDriverIds(entities) {
  const ids = new Set();
  for (const e of entities) {
    for (const d of e.drivers || []) {
      if (d && d.id) ids.add(d.id);
    }
  }
  return ids;
}

// Resolve a city NAME to coordinates via the same cities/search endpoint the
// harvest job already uses. Best-effort: returns null (never throws) so one
// bad domicile name can't take down the whole unassigned-drivers fetch.
async function lookupCityCoords(tabId, cfg, cityName) {
  try {
    const data = await fetchCitiesInPage(tabId, cfg, cityName);
    const mapped = extractEntries(data).map(mapCity).filter(Boolean);
    return mapped[0] || null; // the endpoint already ranks by relevance
  } catch (e) {
    await logError("background/lookupCityCoords", e, { cityName: cityName });
    return null;
  }
}

// Derive the approved-places endpoint from the configured OnTrack base URL
// (…/api/v1/rlb-locations → …/api/v1/approved-places), so there's no extra URL
// setting to keep in sync.
function approvedPlacesUrl(cfg) {
  return ontrackApiRoot(cfg) + "/approved-places";
}

// Fetch the carrier's approved places from FleetYes/OnTrack. Returns a slim list
// of { name, city, latitude, longitude }. lat/lng are often 0 (not yet populated)
// — callers must resolve the city to coordinates in that case.
async function fetchApprovedPlaces(cfg) {
  if (!cfg.carrierCode) {
    const err = new Error("Carrier code not found on the Relay page — open a Relay Load Board page and try again.");
    err.config = true;
    throw err;
  }
  await ensureToken(cfg, cfg.carrierCode);
  const url = approvedPlacesUrl(cfg) + "?carrier_code=" + encodeURIComponent(cfg.carrierCode);
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + cfg.token } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("approved-places HTTP " + res.status + ": " + text.slice(0, 200));
    await logError("background/fetchApprovedPlaces", err, { url: url, status: res.status });
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("approved-places response was not JSON"); }
  const rows = Array.isArray(data && data.data) ? data.data : [];
  return rows.map((row) => {
    const p = (row && row.place) || {};
    return { name: p.name || null, city: p.city || null, latitude: num(p.latitude), longitude: num(p.longitude) };
  }).filter((p) => p.city || (p.latitude && p.longitude));
}

// A driver is only worth searching for if they're actually eligible to
// work — active, identity-verified, and background-check cleared —
// regardless of whether they currently have a trip.
function isEligibleDriver(d) {
  return (
    d.status === "Active" &&
    d.identityStatus === "VERIFIED" &&
    !!d.backgroundCheck && d.backgroundCheck.status === "ELIGIBLE"
  );
}

// Shape unassigned drivers into the same availability record shape
// buildAvailability() produces, so they flow through buildCityList/scoring
// exactly like a trip-based driver. Location source depends on cfg.useFleetyesPlaces:
//   ON  → the carrier's FleetYes approved places (pool: every unassigned driver is
//         searched from every approved-place city).
//   OFF → each driver's Relay home domicile (the original behaviour).
// Either way we resolve each UNIQUE city to coordinates once (cached), preferring
// any real lat/lng the API already provides.
async function buildUnassignedDriverAvailability(tabId, cfg, allDrivers, assignedIds) {
  const noId = allDrivers.filter((d) => !(d && d.latestTransientDriverId)).length;
  const candidates = allDrivers.filter((d) => d && d.latestTransientDriverId && !assignedIds.has(d.latestTransientDriverId));
  const notEligible = candidates.filter((d) => !isEligibleDriver(d)).length;
  const unassigned = candidates.filter(isEligibleDriver);
  console.log(
    "[RLB unassigned] " + allDrivers.length + " total driver(s), " + assignedIds.size + " assigned id(s) from trips, " +
    noId + " driver(s) with no latestTransientDriverId, " + candidates.length + " candidate unassigned driver(s), " +
    notEligible + " dropped (not Active/VERIFIED/ELIGIBLE), " + unassigned.length + " eligible unassigned driver(s)"
  );
  if (!unassigned.length) return [];

  const cityCache = new Map();
  async function coordsFor(cityName) {
    const key = String(cityName).toLowerCase().trim();
    if (cityCache.has(key)) return cityCache.get(key);
    const coords = await lookupCityCoords(tabId, cfg, cityName);
    cityCache.set(key, coords);
    return coords;
  }

  const driverRec = (d) => ({
    id: d.latestTransientDriverId,
    staticDriverId: d.integerDriverId || null,
    name: ((d.firstName || "") + " " + (d.lastName || "")).trim() || "Unknown",
    phoneNumber: d.phoneNumber || null,
    email: d.emailId || null,
  });
  const record = (d, coords, domicileCode) => ({
    driver: driverRec(d),
    lastTripId: null,
    lastTripState: null,
    lastTripEndTime: null,
    freeLocation: { city: coords.name, country: coords.country || null, latitude: coords.latitude, longitude: coords.longitude },
    domicile: domicileCode || null,
    equipment: null,
    freeAt: null,
    freeAtEffective: new Date().toISOString(),
    alreadyFree: true,
    nextTripStart: null,
    freeWindowHours: null,
    unassigned: true, // lets the UI/scoring tell an unassigned driver apart from a trip-based one
  });

  // ── ON: FleetYes approved places (shared pool for all unassigned drivers) ──────
  if (cfg.useFleetyesPlaces) {
    try {
      const approved = await fetchApprovedPlaces(cfg);
      const placeCoords = [];
      for (const p of approved) {
        let coords = null;
        if (p.latitude && p.longitude) coords = { name: p.city || p.name, country: null, latitude: p.latitude, longitude: p.longitude };
        else if (p.city) coords = await coordsFor(p.city);
        if (coords) placeCoords.push(coords);
      }
      if (placeCoords.length) {
        const out = [];
        for (const d of unassigned) {
          for (const loc of placeCoords) out.push(record(d, loc, null)); // each driver × each place
        }
        console.log("[RLB availability] unassigned via FleetYes places: " + unassigned.length + " driver(s) × " + placeCoords.length + " place(s)");
        return out;
      }
      // approved-places empty → fall through to the domicile source below.
      console.log("[RLB availability] FleetYes approved-places empty — falling back to Relay domicile.");
    } catch (e) {
      await logError("background/buildUnassignedDriverAvailability/fleetyes", e);
      // fall through to domicile
    }
  }

  // ── OFF / fallback: each driver's Relay home domicile ──────────────────────────
  let noDomicile = 0, unresolvedCity = 0;
  const out = [];
  for (const d of unassigned) {
    const dom = d.domiciles && d.domiciles[0];
    const cityName = dom && dom.domicileName;
    if (!cityName) { noDomicile++; continue; } // no domicile on file — nothing to search from
    const coords = await coordsFor(cityName);
    if (!coords) { unresolvedCity++; continue; } // couldn't resolve a location — skip rather than guess
    out.push(record(d, coords, dom.domicileCode || null));
  }
  console.log(
    "[RLB unassigned] via Relay domicile: resolved " + out.length + " driver(s), dropped " + noDomicile +
    " (no domicile) and " + unresolvedCity + " (couldn't resolve domicile city to coordinates)"
  );
  return out;
}

// ── FALLBACK: original Relay-trips availability ──────────────────────────────
// Used only when the shifts API fails. Builds the merged trip-based + unassigned
// availability exactly as the extension did before the schedule API was added.
async function buildRelayTripsAvailability(tab, cfg) {
  const csrf = await resolveCsrf(tab.id);
  if (!csrf) throw new Error("No CSRF token — reload the Relay tab.");
  let inTransit, upcoming;
  try {
    inTransit = await fetchEntitiesFresh(tab.id, cfg, csrf, self.RLB_PAYLOADS.inTransit);
  } catch (e) {
    throw new Error(describeFetchEntitiesError(e, "in-transit"));
  }
  try {
    upcoming = await fetchEntitiesFresh(tab.id, cfg, csrf, self.RLB_PAYLOADS.upcoming);
  } catch (e) {
    throw new Error(describeFetchEntitiesError(e, "upcoming"));
  }
  const entities = inTransit.concat(upcoming);
  const availability = buildAvailability(entities, cfg);
  console.log("[RLB availability] built " + availability.length + " trip-based driver(s).");

  // Fold in unassigned drivers too — non-fatal if this leg fails.
  let combined = availability;
  try {
    const allDrivers = await fetchAllDrivers(tab.id, cfg);
    const unassigned = await buildUnassignedDriverAvailability(tab.id, cfg, allDrivers, assignedDriverIds(entities));
    console.log("[RLB availability] " + unassigned.length + " unassigned driver(s).");
    combined = availability.concat(unassigned);
  } catch (e) {
    await logError("background/buildRelayTripsAvailability/unassignedDrivers", e);
  }

  // Search origin = the single configured Search Location (from rlb-settings),
  // NOT each driver's own drop-off. Resolve it once and stamp it on every driver's
  // freeLocation, so buildCityList produces ONE search city (all drivers matched
  // from that location). Driver timing/identity is preserved.
  await applySearchLocation(tab.id, cfg, combined);
  return combined;
}

// Resolve cfg.searchLocation → coords and overwrite freeLocation on every record.
// Required: with no Search Location there's no origin to search from → config error.
async function applySearchLocation(tabId, cfg, records) {
  const searchLoc = (cfg.searchLocation || "").trim();
  if (!searchLoc) {
    const err = new Error("No Search Location set for this carrier (rlb-settings). Set it in FleetYes.");
    err.config = true;
    throw err;
  }
  const c = await lookupCityCoords(tabId, cfg, searchLoc);
  if (!c) {
    const err = new Error('Could not resolve Search Location "' + searchLoc + '" to coordinates.');
    err.config = true;
    throw err;
  }
  const loc = { city: c.name, country: c.country || null, latitude: c.latitude, longitude: c.longitude };
  for (const r of records) { r.freeLocation = loc; }
  console.log('[RLB availability] search origin overridden to Search Location "' + searchLoc + '" for ' + records.length + " driver(s).");
}

// ── FALLBACK: original Relay unassigned-only availability ────────────────────
async function buildRelayUnassignedAvailability(tab, cfg) {
  const csrf = await resolveCsrf(tab.id);
  if (!csrf) throw new Error("No CSRF token — reload the Relay tab.");
  let inTransit, upcoming;
  try {
    inTransit = await fetchEntitiesFresh(tab.id, cfg, csrf, self.RLB_PAYLOADS.inTransit);
  } catch (e) {
    throw new Error(describeFetchEntitiesError(e, "in-transit"));
  }
  try {
    upcoming = await fetchEntitiesFresh(tab.id, cfg, csrf, self.RLB_PAYLOADS.upcoming);
  } catch (e) {
    throw new Error(describeFetchEntitiesError(e, "upcoming"));
  }
  const entities = inTransit.concat(upcoming);
  let allDrivers;
  try {
    allDrivers = await fetchAllDrivers(tab.id, cfg);
  } catch (e) {
    throw new Error("Couldn't fetch the drivers list: " + ((e && e.message) || e));
  }
  const unassigned = await buildUnassignedDriverAvailability(tab.id, cfg, allDrivers, assignedDriverIds(entities));
  console.log("[RLB availability] FALLBACK unassigned-only — " + unassigned.length + " driver(s).");
  return unassigned;
}

async function refreshAvailabilityOnly(carrierCode) {
  const cfg = await getConfig();
  // Carrier code comes from Relay's page (#case-carrier-scac), passed in by the
  // content script — NOT the popup. Inject it into cfg so every downstream call
  // (shifts API, approved-places) reads cfg.carrierCode as before.
  cfg.carrierCode = (carrierCode || "").trim();
  const tab = await findRelayTab();
  if (!tab) return { ok: false, error: "No Amazon Relay tab found." };

  // Force a fresh /api/v1/init on every "Find my best loads" click, rather than
  // reusing a cached token — guarantees the schedule-api call always uses a
  // token minted for whichever ontrackUrl is currently configured.
  cfg.token = "";
  await chrome.storage.local.set({ token: "" });

  // Primary: shifts API (active-driver-shifts). A Relay tab is still needed to
  // resolve any missing home city to coordinates via the cities endpoint.
  // Fallback: the original Relay-trips availability when the API fails.
  let availability, source = "schedule-api", apiError = null;
  try {
    availability = await buildScheduleAvailability(tab.id, cfg);
    console.log("[RLB availability] ✓ shifts API OK — " + availability.length + " driver(s) via schedule-api.");
  } catch (e) {
    await logError("background/refreshAvailabilityOnly/schedule", e);
    // Config errors (e.g. no Search Location) surface directly — no Relay fallback.
    if (e && e.config) return { ok: false, config: true, error: (e && e.message) || String(e) };
    apiError = (e && e.message) || String(e);
    console.warn("[RLB availability] ✗ shifts API FAILED (" + apiError + ") — falling back to Relay trips.");
    await log(
      "loads",
      "Driver shifts API unavailable (" + apiError + "). This usually means no drivers are set up for this " +
      "carrier in FleetYes, or the carrier isn't registered yet. Falling back to reading drivers from Relay " +
      "trips and searching each driver's location in its own tab.",
      "warn"
    );
    try {
      availability = await buildRelayTripsAvailability(tab, cfg);
      source = "relay-trips-fallback";
    } catch (e2) {
      await logError("background/refreshAvailabilityOnly/fallback", e2);
      return { ok: false, error: "Shifts API failed (" + apiError + ") and Relay-trips fallback also failed: " + ((e2 && e2.message) || e2) };
    }
  }
  console.log("[RLB availability] source=" + source + ", " + availability.length + " driver(s). JSON:", JSON.stringify(availability, null, 2));
  await chrome.storage.local.set({
    plannerAvailability: availability,
    plannerAvailabilityAt: Date.now(),
    plannerAvailabilitySource: source, // "schedule-api" | "relay-trips-fallback" — for the on-page log
    // Record the Search Location this cache was built with, so the on-page reuse
    // check can force a refresh when the user changes it (see ensureDrivers).
    plannerAvailabilitySearchLocation: (cfg.searchLocation || "").trim(),
  });
  return { ok: true, count: availability.length, source: source, apiError: apiError };
}

// Unassigned-drivers-ONLY refresh, for the dedicated "Find loads for
// unassigned drivers" button. Stored under its OWN key
// (plannerAvailabilityUnassigned / plannerAvailabilityUnassignedAt) — kept
// separate from plannerAvailability (the trip-based+unassigned merged list
// refreshAvailabilityOnly builds) so the two launcher buttons never clobber
// each other's cached data, each can be reused/refreshed independently, and
// scoring/highlighting driven by plannerAvailability is unaffected by this
// flow running.
async function refreshUnassignedDriversOnly(carrierCode) {
  const cfg = await getConfig();
  cfg.carrierCode = (carrierCode || "").trim(); // from Relay's page, not the popup
  const tab = await findRelayTab();
  if (!tab) return { ok: false, error: "No Amazon Relay tab found." };
  // Primary: shifts API. Fallback: the original Relay unassigned-drivers flow.
  // Writes to its own storage key so the two buttons stay independent (see
  // scoreLoadsForPage, which reads plannerAvailabilityUnassigned in "unassigned" mode).
  let availability, source = "schedule-api", apiError = null;
  try {
    availability = await buildScheduleAvailability(tab.id, cfg);
    console.log("[RLB availability] ✓ shifts API OK (unassigned) — " + availability.length + " driver(s) via schedule-api.");
  } catch (e) {
    await logError("background/refreshUnassignedDriversOnly/schedule", e);
    // Config errors (e.g. no Search Location) surface directly — no Relay fallback.
    if (e && e.config) return { ok: false, config: true, error: (e && e.message) || String(e) };
    apiError = (e && e.message) || String(e);
    console.warn("[RLB availability] ✗ shifts API FAILED (" + apiError + ") — falling back to Relay unassigned.");
    await log("loads", "Shifts API failed (" + apiError + ") — using Relay drivers instead.", "warn");
    try {
      availability = await buildRelayUnassignedAvailability(tab, cfg);
      source = "relay-unassigned-fallback";
    } catch (e2) {
      await logError("background/refreshUnassignedDriversOnly/fallback", e2);
      return { ok: false, error: "Shifts API failed (" + apiError + ") and Relay unassigned fallback also failed: " + ((e2 && e2.message) || e2) };
    }
  }
  console.log("[RLB availability] unassigned source=" + source + ", " + availability.length + " driver(s). JSON:", JSON.stringify(availability, null, 2));
  await chrome.storage.local.set({
    plannerAvailabilityUnassigned: availability,
    plannerAvailabilityUnassignedAt: Date.now(),
    plannerAvailabilityUnassignedSource: source,
  });
  return { ok: true, count: availability.length, source: source, apiError: apiError };
}

// Score page-provided loads against stored availability → load-centric list
// (each load with its suitable drivers). No network; pure computation.
async function scoreLoadsForPage(loads, mode) {
  const cfg = await getConfig();
  // "unassigned" mode (the U launcher) must score against the unassigned-only
  // list, not the merged assigned+unassigned plannerAvailability the ⚡ button
  // writes — otherwise assigned drivers leak into the highlight/tooltip.
  const stored = await chrome.storage.local.get([
    "plannerAvailability", "plannerAvailabilityAt",
    "plannerAvailabilityUnassigned", "plannerAvailabilityUnassignedAt",
  ]);
  // In "unassigned" mode we commit to the unassigned-only list even when it's
  // empty — no fallback to the merged list, so assigned drivers can never leak
  // in. An empty list simply yields 0 matches ("no unassigned drivers").
  const useUnassigned = mode === "unassigned";
  const availability = useUnassigned ? (stored.plannerAvailabilityUnassigned || []) : (stored.plannerAvailability || []);
  const availabilityAt = useUnassigned ? (stored.plannerAvailabilityUnassignedAt || null) : (stored.plannerAvailabilityAt || null);
  if (!availability.length) return { ok: true, drivers: 0, loads: [], availabilityAt: availabilityAt };
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
  return { ok: true, drivers: availability.length, loads: topLoads, diag: diag, availabilityAt: availabilityAt };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "refresh-availability") {
    refreshAvailabilityOnly(msg.carrierCode)
      .then(sendResponse)
      .catch((e) => {
        logError("background/refresh-availability", e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true; // keep the channel open for the async response
  }
  if (msg.type === "score-loads") {
    scoreLoadsForPage(msg.loads || [], msg.mode)
      .then(sendResponse)
      .catch((e) => {
        logError("background/score-loads", e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }
  if (msg.type === "refresh-unassigned-drivers") {
    refreshUnassignedDriversOnly(msg.carrierCode)
      .then(sendResponse)
      .catch((e) => {
        logError("background/refresh-unassigned-drivers", e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }
  if (msg.type === "sync-rlb-settings") {
    syncRlbSettings(msg.carrierCode)
      .then(sendResponse)
      .catch((e) => {
        logError("background/sync-rlb-settings", e);
        sendResponse({ ok: false, error: String((e && e.message) || e), config: !!(e && e.config) });
      });
    return true;
  }
});
