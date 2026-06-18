// ─────────────────────────────────────────────────────────────────────────────
// RLB background worker — two jobs:
//
//   "harvest" (Phase 1): loop ", a".." , z" on Relay cities/search, POST each
//     batch to the OnTrack rlb-locations endpoint.
//
//   "loads" (Phase 2): GET all saved locations from OnTrack, then for each one
//     drive the Relay load board UI inside the page, scrape the rendered
//     results, and POST the captured loads to the OnTrack ingest endpoint.
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

async function runDomInPage(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: func,
    args: args,
    world: "MAIN",
  });
  const r = results && results[0] && results[0].result;
  if (r === undefined || r === null) throw new Error("no response from page");
  return r;
}

// Runs in the Relay page. It fills the origin search, selects the first
// matching location suggestion, opens Equipment, chooses Tractor and trailer
// plus All, clicks Search loads, then scrapes the rendered load cards.
function pageSearchAndScrape(loc, cfg) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const trace = [];

  function step(msg) {
    trace.push({ ts: Date.now(), msg: msg });
  }

  function typeInto(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    nativeSetter.call(input, value);
    ["focus", "input", "change"].forEach((name) =>
      input.dispatchEvent(new Event(name, { bubbles: true }))
    );
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
  }

  function clickText(root, text) {
    const needle = String(text).trim().toLowerCase();
    const nodes = [...root.querySelectorAll("button, [role='button'], [role='option'], [role='checkbox'], label, div, span")];
    const match = nodes.find((node) => {
      const t = (node.textContent || "").trim().toLowerCase();
      return t === needle || t.includes(needle);
    });
    if (match) {
      match.click();
      return true;
    }
    return false;
  }

  function scrapeLoads() {
    const cards = [...document.querySelectorAll(".load-card > div")];
    return cards
      .map((card) => {
        const text = (el) => el?.textContent?.trim() ?? "";

        const loadId = card.id ?? "";
        const deadhead = text(card.querySelector(".css-8a5j1c .css-1maqsxd"));

        const stopDetails = [...card.querySelectorAll(".css-soq2b7 > div")].filter(
          (d) => d.querySelector("span[tabindex]")
        );

        const pickupLocation = text(stopDetails[0]?.querySelector(".wo-card-header__components"));
        const pickupTime = text(stopDetails[0]?.querySelectorAll(".wo-card-header__components")?.[1]);
        const dropoffLocation = text(stopDetails[1]?.querySelector(".wo-card-header__components"));
        const dropoffTime = text(stopDetails[1]?.querySelectorAll(".wo-card-header__components")?.[1]);

        const tripBlock = [...card.querySelectorAll(".css-8a5j1c")][1];
        const tripDistance = text(tripBlock?.querySelector(".css-1xm8gt .wo-card-header__components"));
        const duration = text(tripBlock?.querySelector(".css-fnc3ff .wo-card-header__components"));

        const equipment = text(card.querySelector(".equipment-type-text span"));
        const trailerType = text(card.querySelector(".trailer-type-circle p"));
        const loadingType =
          card.querySelector(".loading-type")?.getAttribute("title") ?? text(card.querySelector(".loading-type"));

        const totalPayout = text(card.querySelector(".wo-total_payout"));
        const ratePerMile = text(card.querySelector('[class*="n4zms0"] .wo-card-header__components'));

        return {
          loadId,
          deadhead,
          pickupLocation,
          pickupTime,
          dropoffLocation,
          dropoffTime,
          tripDistance,
          duration,
          equipment,
          trailerType,
          loadingType,
          totalPayout,
          ratePerMile,
        };
      })
      .filter((l) => l.loadId);
  }

  async function setOrigin() {
    const originText =
      (loc && (loc.displayValue || loc.display_value || loc.name || loc.cityName)) ||
      "";
    step("Origin target: " + originText);
    const input =
      document.querySelector("#rlb-origin-city-filter input[role='combobox']") ||
      document.querySelector("#rlb-origin-city-filter input") ||
      document.querySelector('input[placeholder="Start typing to search"]');
    if (!input) throw new Error("origin input not found");

    const wrapper = document.querySelector("#rlb-origin-city-filter");
    if (wrapper) wrapper.click();
    await wait(200);

    input.focus();
    await wait(150);
    typeInto(input, "");
    await wait(100);
    typeInto(input, originText);
    await wait(1800);

    const listboxId = input.getAttribute("aria-controls");
    const listbox = listboxId ? document.getElementById(listboxId) : document.querySelector('[role="listbox"]');
    if (!listbox) throw new Error("origin listbox not found");

    const normalized = originText.toLowerCase().split(",")[0].trim();
    const options = [...listbox.querySelectorAll('[role="option"]')];
    const match =
      options.find((o) => {
        const t = (o.textContent || "").trim().toLowerCase();
        const a = (o.getAttribute("aria-label") || "").trim().toLowerCase();
        return t.includes(normalized) || a.includes(normalized);
      }) ||
      options.find((o) => !/your location/i.test(o.textContent || "")) ||
      options[0];

    if (!match) throw new Error("no origin suggestion found");
    step("Origin suggestion selected: " + ((match.textContent || "").trim() || "(empty)"));
    match.click();
    await wait(600);
    document.body.click();
    await wait(300);
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await wait(400);
  }

  async function setEquipment() {
    step("Opening equipment selector");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(300);
    document.body.click();
    await wait(400);

    const equipInput =
      document.querySelector("#equipment-trailer-filter input[aria-label='Equipment*']") ||
      document.querySelector("#equipment-trailer-filter input") ||
      document.querySelector('input[aria-label="Equipment*"]');
    if (!equipInput) throw new Error("equipment input not found");

    equipInput.focus();
    await wait(200);
    equipInput.click();
    await wait(1200);

    const dropdown =
      document.querySelector("#equipment-type-filter-dropdown") ||
      document.querySelector("#equipment-trailer-filter") ||
      document.body;
    const tractorClicked = clickText(dropdown, "Tractor and trailer");
    if (!tractorClicked) throw new Error("tractor and trailer option not found");
    step("Equipment selected: Tractor and trailer");
    await wait(500);

    const allClicked = clickText(dropdown, "All");
    if (!allClicked) {
      // Some builds render "All" as a checkbox inside a card instead of a direct button.
      const allNode = [...dropdown.querySelectorAll("[role='checkbox'], [role='button'], button, label, div")].find((node) =>
        (node.textContent || "").trim().toLowerCase() === "all"
      );
      if (allNode) allNode.click();
    }
    step("Equipment selected: All");
    await wait(500);

    document.body.click();
    await wait(300);
  }

  async function clickSearchLoads() {
    step("Waiting for Search loads button");
    let btn = null;
    for (let i = 0; i < 20; i++) {
      btn = [...document.querySelectorAll('button[type="button"]')].find(
        (b) => (b.textContent || "").trim().toLowerCase() === "search loads"
      );
      if (btn && !btn.disabled) break;
      await wait(250);
    }
    if (!btn) throw new Error("Search loads button not found");
    if (btn.disabled) throw new Error("Search loads button stayed disabled");
    step("Clicking Search loads");
    btn.click();
    await wait(300);
  }

  async function waitForLoads() {
    step("Waiting for rendered load cards");
    const timeoutAt = Date.now() + 15000;
    while (Date.now() < timeoutAt) {
      const loads = scrapeLoads();
      if (loads.length) {
        step("Loaded " + loads.length + " card(s)");
        return loads;
      }
      await wait(500);
    }
    step("Timed out waiting for load cards");
    return scrapeLoads();
  }

  return (async () => {
    await wait(800);
    await setOrigin();
    await wait(1200);
    await setEquipment();
    await wait(800);
    await clickSearchLoads();
    const loads = await waitForLoads();
    return {
      loads: loads,
      workOpportunities: loads,
      trace: trace,
      search: {
        origin: (loc && (loc.displayValue || loc.display_value || loc.name || loc.cityName)) || "",
        equipment: ["Tractor and trailer", "All"],
      },
    };
  })();
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
// PHASE 2 — for each saved location, drive Relay search UI → ingest response
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

function countWorkOpportunities(data) {
  if (!data || typeof data !== "object") return 0;
  if (Array.isArray(data.workOpportunities)) return data.workOpportunities.length;
  if (Array.isArray(data.loads)) return data.loads.length;
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
        await log("loads", label + ": starting DOM search");
        const data = await runDomInPage(tab.id, pageSearchAndScrape, [loc, cfg]);
        const n = countWorkOpportunities(data);
        const trace = data && Array.isArray(data.trace) ? data.trace : [];
        for (const entry of trace) {
          await log("loads", label + " | " + entry.msg);
        }

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
        await log("loads", label + ": " + (e && e.message ? e.message : String(e)), "error");
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
