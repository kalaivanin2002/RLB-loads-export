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

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      resolve(Object.assign({}, DEFAULTS, r || {}));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

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
  if (!r) throw new Error("no response from page");
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
  if (!r.ok) throw new Error("Relay HTTP " + r.status);
  try {
    return JSON.parse(r.body);
  } catch (e) {
    throw new Error("Relay response was not JSON");
  }
}

function extractEntries(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const keys = ["cities", "results", "data", "suggestions", "items", "locations"];
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
  if (!res.ok) throw new Error("OnTrack HTTP " + res.status + ": " + text.slice(0, 300));
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
// PHASE 2 — for each saved location, search Relay loads → ingest the response
// ═════════════════════════════════════════════════════════════════════════════
async function getLocations(cfg) {
  const res = await fetch(cfg.ontrackUrl, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer " + cfg.token },
  });
  const text = await res.text();
  if (!res.ok) throw new Error("OnTrack GET HTTP " + res.status + ": " + text.slice(0, 200));
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
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
function buildSearchPayload(loc, cfg) {
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
    startDate: null,
    endDate: null,
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
    isAutoRefreshCall: true,
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

async function searchLoadsInPage(tabId, cfg, payload) {
  const url = cfg.relayBase.replace(/\/+$/, "") + "/api/loadboard/search";
  const r = await runInPage(tabId, url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("Relay search HTTP " + r.status);
  try {
    return JSON.parse(r.body);
  } catch (e) {
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
  if (!res.ok) throw new Error("Ingest HTTP " + res.status + ": " + text.slice(0, 200));
  return text;
}

let isFindingLoads = false;

async function findLoads() {
  if (isFindingLoads) {
    await log("loads", "Find loads already running.", "warn");
    return;
  }
  isFindingLoads = true;
  await resetLog("loads");
  try {
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
      return;
    }
    if (!locations.length) {
      await log("loads", "No saved locations returned from the API.", "warn");
      return;
    }
    const radius = Number(cfg.searchRadius) || 5;
    const max = Number(cfg.maxLocations) || 0;
    const toSearch = max > 0 ? locations.slice(0, max) : locations;
    await log(
      "loads",
      "Fetched " + locations.length + " locations" +
        (max > 0 ? " — testing first " + toSearch.length : "") +
        ". Searching loads (radius " + radius + " mi)…"
    );

    const results = [];
    await chrome.storage.local.set({ loadsResults: [] });
    let totalOpps = 0;

    for (let i = 0; i < toSearch.length; i++) {
      const loc = toSearch[i];
      const label = loc.displayValue || loc.name || "#" + i;
      try {
        const payload = buildSearchPayload(loc, cfg);
        const data = await searchLoadsInPage(tab.id, cfg, payload);
        const n = countWorkOpportunities(data);

        results.push({ location: loc, capturedAt: new Date().toISOString(), count: n, response: data });
        await chrome.storage.local.set({ loadsResults: results });

        let suffix = " (stored)";
        if (cfg.ingestUrl) {
          await postIngest(cfg, data);
          suffix = " → ingested + stored";
        }
        totalOpps += n;
        await log("loads", label + ": " + n + " loads" + suffix, n > 0 ? "success" : "info");
      } catch (e) {
        await log("loads", label + ": " + (e.message || String(e)), "error");
      }
      await sleep(cfg.delayMs);
    }
    await log(
      "loads",
      "Done. " + results.length + " searches stored, " + totalOpps + " loads total. Use “Download results”.",
      "success"
    );
  } finally {
    isFindingLoads = false;
    await setRunning("loads", false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "start-harvest") {
    harvest();
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "start-find-loads") {
    findLoads();
    sendResponse({ ok: true });
    return;
  }
});
