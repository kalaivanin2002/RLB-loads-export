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
        errors++;
      }
    }

    await chrome.storage.local.set({ tripsResults: trips });
    await log("trips", "Done. Captured " + trips.length + " trip(s)" + (errors > 0 ? " with " + errors + " error(s)" : "") + ".", trips.length > 0 ? "success" : "warn");
  } catch (e) {
    await log("trips", "Error: " + (e.message || String(e)), "error");
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
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (csrf && csrf.token) {
    headers[csrf.headerName || "anti-csrftoken-a2z"] = csrf.token;
  }
  const r = await runInPage(tabId, url, {
    method: "POST",
    credentials: "include",
    headers: headers,
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
      if (attempt > maxRetries || !transient) throw e;
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

// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  switch (msg.type) {
    case "start-harvest":
      harvest();
      break;
    case "start-find-loads":
      startFindLoads();
      break;
    case "stop-find-loads":
      stopFindLoads();
      break;
    case "resume-find-loads":
      resumeFindLoads();
      break;
    case "retry-failed-loads":
      retryFailed();
      break;
    case "start-sync-trips":
      syncInTransitTrips();
      break;
    default:
      return;
  }
  sendResponse({ ok: true });
});
