// ─────────────────────────────────────────────────────────────────────────────
// RLB Location harvester
//
// Flow per letter "a".."z":
//   1. Fetch Relay city-search results — runs INSIDE the open Relay tab via
//      chrome.scripting (same-origin, so the user's session cookie is sent
//      regardless of SameSite). Query is `<prefix><letter>`, e.g. ", a".
//   2. Map each result to the OnTrack location payload shape.
//   3. POST that letter's batch to the OnTrack API — runs HERE in the service
//      worker (host_permissions bypass CORS; Bearer-token auth).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  relayBase: "https://relay.amazon.co.uk",
  ontrackUrl: "https://ontrack-api.agilecyber.com/api/v1/rlb-locations",
  token: "",
  letters: "abcdefghijklmnopqrstuvwxyz",
  prefix: ", ",
  delayMs: 500,
};

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      const cfg = Object.assign({}, DEFAULTS, r || {});
      resolve(cfg);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── progress reporting ───────────────────────────────────────────────────────
// Persisted to storage so the popup can show it even after being reopened,
// and also pushed live via runtime messaging while the popup is open.
async function resetLog() {
  await chrome.storage.local.set({ harvestLog: [], harvestRunning: true });
}
async function setRunning(running) {
  await chrome.storage.local.set({ harvestRunning: running });
}
async function log(msg, level) {
  const entry = { ts: Date.now(), msg: msg, level: level || "info" };
  const { harvestLog } = await chrome.storage.local.get(["harvestLog"]);
  const next = (harvestLog || []).concat(entry).slice(-200);
  await chrome.storage.local.set({ harvestLog: next });
  try {
    chrome.runtime.sendMessage({ type: "harvest-progress", entry: entry });
  } catch (e) {
    /* popup not open — ignore */
  }
}

// ── find a Relay tab to run the same-origin fetch in ─────────────────────────
async function findRelayTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://relay.amazon.co.uk/*", "https://relay.amazon.com/*"],
  });
  return tabs && tabs.length ? tabs[0] : null;
}

// Runs in the Relay page. Returns { ok, status, body } (body is raw text).
function pageFetch(url) {
  return fetch(url, { credentials: "include", headers: { Accept: "application/json" } })
    .then(function (r) {
      return r.text().then(function (t) {
        return { ok: r.ok, status: r.status, body: t };
      });
    })
    .catch(function (e) {
      return { ok: false, status: 0, body: String(e) };
    });
}

async function fetchCitiesInPage(tabId, cfg, query) {
  const url =
    cfg.relayBase.replace(/\/+$/, "") +
    "/api/loadboard/filters/cities/search/" +
    encodeURIComponent(query);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: pageFetch,
    args: [url],
    world: "MAIN",
  });
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error("no response from page");
  if (!r.ok) throw new Error("Relay HTTP " + r.status);
  try {
    return JSON.parse(r.body);
  } catch (e) {
    throw new Error("Relay response was not JSON");
  }
}

// ── response → OnTrack payload mapping ───────────────────────────────────────
// Pulls the array of city entries out of whatever shape the response is.
function extractEntries(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const keys = ["cities", "results", "data", "suggestions", "items", "locations"];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  return [];
}

// NOTE: tolerant of several field-name variants. Once we confirm the real
// city-search response shape, tighten this to the exact fields.
function mapCity(entry) {
  if (!entry || typeof entry !== "object") return null;
  const pick = (...names) => {
    for (const n of names) {
      if (entry[n] !== undefined && entry[n] !== null && entry[n] !== "") return entry[n];
    }
    return null;
  };
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

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

// ── main loop ────────────────────────────────────────────────────────────────
let isHarvesting = false;

async function harvest() {
  if (isHarvesting) {
    await log("Harvest already running.", "warn");
    return;
  }
  isHarvesting = true;
  await resetLog();
  try {
    const cfg = await getConfig();
    if (!cfg.token) {
      await log("No OnTrack token set — open Settings, paste the token, and Save.", "error");
      return;
    }
    const tab = await findRelayTab();
    if (!tab) {
      await log("No Amazon Relay tab found — open the Relay load board (and log in) first.", "error");
      return;
    }
    await log("Using Relay tab #" + tab.id + " (" + tab.url + ")");

    const letters = String(cfg.letters).split("").filter((c) => c.trim());
    let totalSaved = 0;

    for (const letter of letters) {
      const query = cfg.prefix + letter;
      try {
        const data = await fetchCitiesInPage(tab.id, cfg, query);
        const entries = extractEntries(data);
        const locations = entries.map(mapCity).filter(Boolean);

        if (locations.length === 0) {
          await log("'" + query + "': 0 mappable locations (raw entries: " + entries.length + ")", "warn");
        } else {
          await postLocations(cfg, locations);
          totalSaved += locations.length;
          await log("'" + query + "': saved " + locations.length + " locations", "success");
        }
      } catch (e) {
        await log("'" + query + "': " + (e && e.message ? e.message : String(e)), "error");
      }
      await sleep(cfg.delayMs);
    }

    await log("Done. Total locations saved: " + totalSaved, "success");
  } finally {
    isHarvesting = false;
    await setRunning(false);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "start-harvest") {
    harvest();
    sendResponse({ ok: true });
    return; // not async
  }
});
