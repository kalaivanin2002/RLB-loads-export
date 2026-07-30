// ─────────────────────────────────────────────────────────────────────────────
// RLB background worker. Serves four requests from the load-board content
// script (loadboard.js) — it owns no jobs of its own:
//
//   sync-rlb-settings          → GET this carrier's planning rules / scoring
//                                weights from FleetYes, merge into storage.
//   refresh-availability       → build per-driver availability (FleetYes shifts
//                                API, falling back to Relay trips) and cache it.
//   refresh-unassigned-drivers → same, but unassigned drivers only, under its
//                                own storage key.
//   score-loads                → score the loads the board is showing against
//                                the cached availability. Pure computation.
//
// Relay calls run INSIDE the open Relay tab via chrome.scripting (same-origin,
// so the session cookie is sent). FleetYes calls run HERE in the service worker
// (host_permissions bypass CORS, Bearer-token auth).
// ─────────────────────────────────────────────────────────────────────────────

importScripts("payloads.js"); // provides self.RLB_PAYLOADS (entitiesV2 request bodies)

const DEFAULTS = {
  relayBase: "https://relay.amazon.co.uk",
  // Bare host base. Each endpoint appends its own path: shifts → /api/v1/…,
  // rlb-settings → /v1/… (see activeDriverShiftsUrl / rlbSettingsUrl).
  ontrackUrl: "https://afp-api.fleetyes.com",
  // RSP carriers (isAFPCarrier meta on the Relay page === "false") hit this host
  // instead — see resolveOntrackUrl / refreshAvailabilityOnly etc.
  rspUrl: "https://rsp-api.fleetyes.com",
  token: "",
  tokenHost: "", // origin the cached token was minted for — see ensureToken
  carrierCode: "", // e.g. "AMRTL" — used for the FleetYes approved-places lookup
  useFleetyesPlaces: false, // ON → unassigned drivers searched from FleetYes approved places; OFF → Relay domicile
  nearbyRadius: 10,
  minTripMiles: 25,
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

// Hosts that older builds of this extension persisted into storage back when the
// popup still let you edit the OnTrack base URL. The popup is info-only now and
// the AFP/RSP hosts come from DEFAULTS, but a stored value still wins in the
// Object.assign below — so an upgraded install keeps calling the legacy host and
// RSP carriers never reach rsp-api. Treat these as unset so DEFAULTS applies.
const LEGACY_ONTRACK_HOSTS = ["ontrack-api.agilecyber.com"];

function isLegacyOntrackUrl(v) {
  if (!v) return false;
  const raw = String(v).trim();
  if (!raw) return false;
  let host;
  try { host = new URL(raw).hostname; }
  catch (e) { host = raw.replace(/^https?:\/\//i, "").split("/")[0]; }
  return LEGACY_ONTRACK_HOSTS.indexOf(host.toLowerCase()) !== -1;
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      const stored = Object.assign({}, r || {});
      // A blank or legacy ontrackUrl/rspUrl must fall through to DEFAULTS rather
      // than override it (Object.assign only skips `undefined`, not "" or stale).
      if (!stored.ontrackUrl || isLegacyOntrackUrl(stored.ontrackUrl)) delete stored.ontrackUrl;
      if (!stored.rspUrl || isLegacyOntrackUrl(stored.rspUrl)) delete stored.rspUrl;
      resolve(Object.assign({}, DEFAULTS, stored));
    });
  });
}

// Scrub the legacy host out of storage once, so it stops shadowing DEFAULTS and
// no longer shows up in the popup/debug views. getConfig already ignores it at
// read time — this just stops the dead value being carried around forever. Any
// cached Bearer token minted against that host is dropped with it, since a token
// is only valid for the origin it was issued by (see ensureToken).
(function migrateLegacyOntrackUrl() {
  try {
    chrome.storage.local.get(["ontrackUrl", "rspUrl", "token", "tokenHost"], (r) => {
      if (chrome.runtime.lastError || !r) return;
      const patch = {};
      if (isLegacyOntrackUrl(r.ontrackUrl)) patch.ontrackUrl = DEFAULTS.ontrackUrl;
      if (isLegacyOntrackUrl(r.rspUrl)) patch.rspUrl = DEFAULTS.rspUrl;
      if (isLegacyOntrackUrl(r.tokenHost)) { patch.token = ""; patch.tokenHost = ""; }
      if (Object.keys(patch).length) {
        chrome.storage.local.set(patch, () => {
          console.log("[RLB] migrated legacy ontrackUrl out of storage:", Object.keys(patch).join(", "));
        });
      }
    });
  } catch (e) { /* worker torn down mid-migration — retried on next startup */ }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
// Numeric config value with a fallback when blank/invalid (allows 0).
const numOr = (v, d) => {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return isNaN(n) ? d : n;
};

// ── progress reporting ───────────────────────────────────────────────────────
// Persisted to storage (so the popup can show it after being reopened) and also
// pushed live via runtime messaging while the popup is open.
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
// Separate from the per-job progress logs (which rotate at 300 entries).
// Survives across runs/service-worker restarts so a transient failure
// (e.g. an intermittent 500) can still be diagnosed after the fact. Capped to
// avoid unbounded storage growth.
const ERROR_LOG_MAX = 200;

async function logError(source, err, context) {
  const message = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? String(err.stack) : null;
  const entry = {
    ts: Date.now(),
    source: source, // e.g. "background/fetchEntities" or "hook/entitiesV2"
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
// Relay cities lookup — resolve a city NAME to coordinates via Relay's own
// autocomplete endpoint. Used by lookupCityCoords to place the configured
// Search Location and any driver domicile.
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
      // The driver's real drop-off from the trip they came off. The search origin
      // (freeLocation) gets overridden to the Search Location downstream, so keep the
      // true drop-off here — it's shown in the drivers panel and is what deadhead /
      // return / drive-time are measured from.
      apiLocation: freeLocation,
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
// AFP vs RSP: Relay's page carries a meta tag (isAFPCarrier === "true"/"false")
// that loadboard.js reads and passes through as carrierType ("afp"/"rsp"/null).
// "afp" and null (tag missing/carrier type unknown) both use the default
// ontrackUrl — null falling through here means the existing init rejection
// (fetchInitToken) surfaces the "not registered" error exactly as before.
function resolveOntrackUrl(cfg, carrierType) {
  console.log("[RLB] resolveOntrackUrl: carrierType=" + carrierType + ", cfg.ontrackUrl=" + cfg.ontrackUrl + ", cfg.rspUrl=" + cfg.rspUrl);
  return carrierType === "rsp" ? cfg.rspUrl : cfg.ontrackUrl;
}
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
// carrierCode, etc.) are left untouched.
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
    // FleetYes returns this specific 404 when the carrier has no FleetYes
    // account at all — flag it so the UI can show a plain "you're not
    // registered" message instead of the generic technical failure text.
    if (res.status === 404 && /company not found for carrier/i.test(text)) {
      err.notRegistered = true;
    }
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
  const host = ontrackOrigin(cfg);
  // A token minted for one host (AFP) must never be reused against the other
  // (RSP) — only trust the cache when it was minted for the host we're about
  // to call.
  if (cfg.token && cfg.tokenHost === host) return cfg.token;
  if (!carrierCode) {
    const err = new Error("Carrier code not found on the Relay page — open a Relay Load Board page and try again.");
    err.config = true;
    throw err;
  }
  const key = await fetchInitToken(cfg, carrierCode);
  cfg.token = key;
  cfg.tokenHost = host;
  await chrome.storage.local.set({ token: key, tokenHost: host });
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
async function syncRlbSettings(carrierCode, carrierType) {
  const cfg = await getConfig();
  cfg.ontrackUrl = resolveOntrackUrl(cfg, carrierType);
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
  // meta.timezone tells us what zone start_date/start_time/end_date/end_time are
  // expressed in (see parseLocalMsInZone below). Older API responses without a
  // meta block fall back to Europe/London, the zone this was always written for.
  const timezone = (data && data.meta && data.meta.timezone) || "Europe/London";
  return { rows: Array.isArray(rows) ? rows : [], timezone: timezone };
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
  // shift.end_location_name is the server-resolved place name (from the driver's
  // matched clock-in/out place or reverse geocode) — prefer it over the flatter
  // end_city/city fallbacks, and over our own reverseGeocode() call below.
  const city = (r.shift && r.shift.end_location_name) || r.end_city || r.city || (r.location && r.location.city) || null;
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

// Parse "YYYY-MM-DD" + "HH:MM" as wall-clock time IN THE GIVEN IANA ZONE →
// epoch ms. The schedule API reports which zone its date/time fields are
// expressed in via meta.timezone (see fetchDriverSchedule) — that's the value
// callers should pass here, NOT a hardcoded zone. Handles DST correctly for
// any zone Intl knows about, not just Europe/London.
function parseLocalMsInZone(dateStr, timeStr, tz) {
  if (!dateStr || !timeStr) return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr).trim());
  if (!dm || !tm) return null;
  const y = +dm[1], mo = +dm[2], d = +dm[3], hh = +tm[1], mi = +tm[2];
  // Start from the UTC interpretation, then correct by that zone's offset at
  // this instant (e.g. BST = +1, GMT = 0 for Europe/London; UTC is always 0)
  // so the wall-clock time lands correctly regardless of DST.
  const naiveUtc = Date.UTC(y, mo - 1, d, hh, mi, 0);
  const offsetMin = zoneOffsetMinutes(naiveUtc, tz || "Europe/London");
  return naiveUtc - offsetMin * 60000;
}

// UTC offset (in minutes) for a given instant in a given IANA zone, via Intl —
// avoids hardcoding DST switch dates for any specific zone.
function zoneOffsetMinutes(ms, tz) {
  try {
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour12: false,
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
    const err = new Error("No Search Location set.");
    err.config = true;
    throw err;
  }
  const c = await lookupCityCoords(tabId, cfg, searchLoc);
  if (!c) {
    const err = new Error('Could not resolve Search Location "' + searchLoc + '" to coordinates.');
    err.config = true;
    throw err;
  }
  // Origin of last resort: used for drivers whose shift row carries no end location.
  const searchLocation = { city: c.name, country: c.country || null, latitude: c.latitude, longitude: c.longitude };

  // Then fetch the shifts (also throws config errors for missing carrier/token).
  const { rows, timezone } = await fetchDriverSchedule(cfg);

  const out = [];
  let noEnd = 0;
  for (const r of rows) {
    const name = (r && r.driver_name) ? String(r.driver_name).trim() : null;
    if (!name) continue;
    const endMs = parseLocalMsInZone(r.end_date, r.end_time, timezone);
    if (endMs == null) { noEnd++; continue; }

    // The driver's OWN end location (drop-off) from the API — shown in the drivers
    // panel's "Free city" column. NOT used to search (that's freeLocation below).
    // City name is reverse-geocoded from lat/lng below if the API didn't supply one.
    const rowLoc = scheduleRowCoords(r);
    const apiLocation = rowLoc ? { city: rowLoc.city || null, latitude: rowLoc.latitude, longitude: rowLoc.longitude } : null;

    // Free AFTER the shift ends. If the shift already ended, they're free now —
    // clamp to `now`, NOT to 0: an epoch timestamp is always greater than 0, so
    // Math.max(endMs, 0) never clamped anything. That left a driver whose shift
    // ended days ago anchored to that stale time, making their latest-pickup bound
    // (free + maxWaitHours) sit in the past, so every current load was dropped for
    // timing and the driver silently matched nothing.
    const effFreeStart = Math.max(endMs, now);
    out.push({
      driver: { id: null, staticDriverId: null, name: name, phoneNumber: null, email: null },
      lastTripId: null,
      lastTripState: null,
      lastTripEndTime: new Date(endMs).toISOString(),
      freeLocation: searchLocation, // search FROM the configured Search Location
      apiLocation: apiLocation,     // the driver's own drop-off — displayed, and what distances measure from
      domicile: null,
      equipment: null,
      freeAt: effFreeStart > now ? new Date(effFreeStart).toISOString() : null,
      freeAtEffective: new Date(effFreeStart).toISOString(),
      alreadyFree: !(effFreeStart > now),
      nextTripStart: null,
      freeWindowHours: null,
      scheduleShift: { start: parseLocalMsInZone(r.start_date, r.start_time, timezone), end: endMs },
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

  // Distances (deadhead, return, drive time) measure from where the driver ACTUALLY
  // is — their own drop-off on apiLocation — not from freeLocation, which is the
  // shared Search Location every driver is searched from. Using freeLocation here
  // would give every driver the same deadhead. Falls back to freeLocation for
  // drivers with no known drop-off (e.g. unassigned drivers with no domicile).
  const fl = (avail.apiLocation && avail.apiLocation.latitude != null && avail.apiLocation.longitude != null)
    ? avail.apiLocation
    : (avail.freeLocation || {});
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

// Resolve a city NAME to coordinates via Relay's cities/search endpoint.
// Best-effort: returns null (never throws) so one
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
    // No trip → no real drop-off. The domicile stands in for it in the drivers panel;
    // null coords simply render as "—". The search origin is overridden downstream.
    apiLocation: coords.latitude != null && coords.longitude != null
      ? { city: coords.name, latitude: coords.latitude, longitude: coords.longitude }
      : null,
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
  // Unassigned drivers have no trip and therefore no drop-off. A driver with no
  // domicile on file still gets a record: the search origin is overridden to the
  // Search Location downstream anyway, so there's nothing to resolve here — their
  // drop-off simply shows as unknown in the panel.
  let viaDomicile = 0, noDomicile = 0;
  const out = [];
  for (const d of unassigned) {
    const dom = d.domiciles && d.domiciles[0];
    const cityName = dom && dom.domicileName;
    const coords = cityName ? await coordsFor(cityName) : null;
    if (coords) { out.push(record(d, coords, dom.domicileCode || null)); viaDomicile++; continue; }
    out.push(record(d, { name: null, country: null, latitude: null, longitude: null }, dom && dom.domicileCode));
    noDomicile++;
  }
  console.log(
    "[RLB unassigned] " + out.length + " driver(s): " + viaDomicile + " with a domicile drop-off, " +
    noDomicile + " with none (searched from the Search Location either way)"
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

  // Search origin = the single configured Search Location (from rlb-settings), for
  // EVERY driver — so buildCityList produces one search city. Each driver's real
  // drop-off is preserved separately on apiLocation (set above for trip-based
  // drivers) and is what the drivers panel displays. Timing/identity are untouched.
  await applySearchLocation(tab.id, cfg, combined);
  return combined;
}

// Resolve cfg.searchLocation → coords and overwrite freeLocation on the records
// passed in. Applied ONLY to drivers with no trip of their own to derive a dropoff
// from (unassigned drivers) — trip-based drivers keep their real final dropoff.
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
  // Search origin = the Search Location from rlb-settings, same as the trips
  // fallback. Each driver's domicile stand-in for a drop-off stays on apiLocation
  // for display.
  await applySearchLocation(tab.id, cfg, unassigned);
  console.log("[RLB availability] FALLBACK unassigned-only — " + unassigned.length + " driver(s).");
  return unassigned;
}

async function refreshAvailabilityOnly(carrierCode, carrierType) {
  const cfg = await getConfig();
  // Carrier code comes from Relay's page (#case-carrier-scac), passed in by the
  // content script — NOT the popup. Inject it into cfg so every downstream call
  // (shifts API, approved-places) reads cfg.carrierCode as before.
  cfg.carrierCode = (carrierCode || "").trim();
  // AFP vs RSP host — see resolveOntrackUrl.
  cfg.ontrackUrl = resolveOntrackUrl(cfg, carrierType);
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
  // The fallback triggers on NO DRIVERS, not just on a failed call: FleetYes can
  // answer 200 with an empty shift list (carrier registered but nobody scheduled),
  // which is just as unusable as an error. Either way we fall back to Relay for the
  // driver list — while the search PLACE still comes from rlb-settings.
  let availability, source = "schedule-api", apiError = null, notRegistered = false;
  try {
    availability = await buildScheduleAvailability(tab.id, cfg);
    if (!availability.length) throw new Error("API returned no drivers");
    console.log("[RLB availability] ✓ shifts API OK — " + availability.length + " driver(s) via schedule-api.");
  } catch (e) {
    await logError("background/refreshAvailabilityOnly/schedule", e);
    // Config errors (e.g. no Search Location) surface directly — no Relay fallback.
    if (e && e.config) return { ok: false, config: true, error: (e && e.message) || String(e) };
    apiError = (e && e.message) || String(e);
    notRegistered = !!(e && e.notRegistered);
    console.warn("[RLB availability] ✗ shifts API unusable (" + apiError + ") — falling back to Relay trips.");
    await log(
      "loads",
      "No drivers from the FleetYes shifts API (" + apiError + "). This usually means no drivers are set up for this " +
      "carrier in FleetYes, or the carrier isn't registered yet. Falling back to reading drivers from Relay " +
      "trips, searched from the Search Location configured in FleetYes.",
      "warn"
    );
    try {
      availability = await buildRelayTripsAvailability(tab, cfg);
      source = "relay-trips-fallback";
    } catch (e2) {
      await logError("background/refreshAvailabilityOnly/fallback", e2);
      return {
        ok: false,
        notRegistered: notRegistered,
        error: "Shifts API failed (" + apiError + ") and Relay-trips fallback also failed: " + ((e2 && e2.message) || e2),
      };
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
  return { ok: true, count: availability.length, source: source, apiError: apiError, notRegistered: notRegistered };
}

// Unassigned-drivers-ONLY refresh, for the dedicated "Find loads for
// unassigned drivers" button. Stored under its OWN key
// (plannerAvailabilityUnassigned / plannerAvailabilityUnassignedAt) — kept
// separate from plannerAvailability (the trip-based+unassigned merged list
// refreshAvailabilityOnly builds) so the two launcher buttons never clobber
// each other's cached data, each can be reused/refreshed independently, and
// scoring/highlighting driven by plannerAvailability is unaffected by this
// flow running.
async function refreshUnassignedDriversOnly(carrierCode, carrierType) {
  const cfg = await getConfig();
  cfg.carrierCode = (carrierCode || "").trim(); // from Relay's page, not the popup
  cfg.ontrackUrl = resolveOntrackUrl(cfg, carrierType); // AFP vs RSP host — see resolveOntrackUrl
  const tab = await findRelayTab();
  if (!tab) return { ok: false, error: "No Amazon Relay tab found." };
  // Primary: shifts API. Fallback: the original Relay unassigned-drivers flow.
  // Writes to its own storage key so the two buttons stay independent (see
  // scoreLoadsForPage, which reads plannerAvailabilityUnassigned in "unassigned" mode).
  // As in refreshAvailabilityOnly: an empty driver list counts as a miss, so a 200
  // with no scheduled drivers falls back to Relay rather than caching nothing.
  let availability, source = "schedule-api", apiError = null, notRegistered = false;
  try {
    availability = await buildScheduleAvailability(tab.id, cfg);
    if (!availability.length) throw new Error("API returned no drivers");
    console.log("[RLB availability] ✓ shifts API OK (unassigned) — " + availability.length + " driver(s) via schedule-api.");
  } catch (e) {
    await logError("background/refreshUnassignedDriversOnly/schedule", e);
    // Config errors (e.g. no Search Location) surface directly — no Relay fallback.
    if (e && e.config) return { ok: false, config: true, error: (e && e.message) || String(e) };
    apiError = (e && e.message) || String(e);
    notRegistered = !!(e && e.notRegistered);
    console.warn("[RLB availability] ✗ shifts API unusable (" + apiError + ") — falling back to Relay unassigned.");
    await log("loads", "No drivers from the FleetYes shifts API (" + apiError + ") — using Relay drivers, searched from the FleetYes Search Location.", "warn");
    try {
      availability = await buildRelayUnassignedAvailability(tab, cfg);
      source = "relay-unassigned-fallback";
    } catch (e2) {
      await logError("background/refreshUnassignedDriversOnly/fallback", e2);
      return {
        ok: false,
        notRegistered: notRegistered,
        error: "Shifts API failed (" + apiError + ") and Relay unassigned fallback also failed: " + ((e2 && e2.message) || e2),
      };
    }
  }
  console.log("[RLB availability] unassigned source=" + source + ", " + availability.length + " driver(s). JSON:", JSON.stringify(availability, null, 2));
  await chrome.storage.local.set({
    plannerAvailabilityUnassigned: availability,
    plannerAvailabilityUnassignedAt: Date.now(),
    plannerAvailabilityUnassignedSource: source,
  });
  return { ok: true, count: availability.length, source: source, apiError: apiError, notRegistered: notRegistered };
}

// Score page-provided loads against stored availability → load-centric list
// (each load with its suitable drivers). No network; pure computation.
// `driverNames` scopes the scoring to one group of drivers (see buildRoundPlan in
// loadboard.js). Overflow rounds search FROM an out-of-range driver location, so
// their loads are hundreds of miles from the configured Search Location — scoring
// them against the whole fleet would match drivers who could never reach them.
// null/absent means "score every driver", which is what the main round does.
async function scoreLoadsForPage(loads, mode, driverNames) {
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
  const fullList = useUnassigned ? (stored.plannerAvailabilityUnassigned || []) : (stored.plannerAvailability || []);
  const availabilityAt = useUnassigned ? (stored.plannerAvailabilityUnassignedAt || null) : (stored.plannerAvailabilityAt || null);
  // Restrict to this round's driver group when the caller named one. Matching is by
  // driver name because that's the only identifier the schedule API supplies
  // (buildScheduleAvailability leaves driver.id null), and it's what the round plan
  // carries. An unrecognised name simply drops out — a group that matches nobody
  // yields 0 matches rather than silently widening back to the whole fleet.
  const wanted = Array.isArray(driverNames) && driverNames.length
    ? new Set(driverNames.map((n) => String(n || "").toLowerCase().trim()).filter(Boolean))
    : null;
  const availability = wanted
    ? fullList.filter((a) => wanted.has(String((a.driver && a.driver.name) || "").toLowerCase().trim()))
    : fullList;
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
    refreshAvailabilityOnly(msg.carrierCode, msg.carrierType)
      .then(sendResponse)
      .catch((e) => {
        logError("background/refresh-availability", e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true; // keep the channel open for the async response
  }
  if (msg.type === "score-loads") {
    scoreLoadsForPage(msg.loads || [], msg.mode, msg.driverNames || null)
      .then(sendResponse)
      .catch((e) => {
        logError("background/score-loads", e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }
  if (msg.type === "refresh-unassigned-drivers") {
    refreshUnassignedDriversOnly(msg.carrierCode, msg.carrierType)
      .then(sendResponse)
      .catch((e) => {
        logError("background/refresh-unassigned-drivers", e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }
  if (msg.type === "sync-rlb-settings") {
    syncRlbSettings(msg.carrierCode, msg.carrierType)
      .then(sendResponse)
      .catch((e) => {
        logError("background/sync-rlb-settings", e);
        sendResponse({ ok: false, error: String((e && e.message) || e), config: !!(e && e.config) });
      });
    return true;
  }
});
