const btn = document.getElementById("searchLoadsBtn");
const driverList = document.getElementById("driverList");
const statusEl = document.getElementById("status");

let driversWithTrips = [];

fetch(chrome.runtime.getURL("drivers.json"))
  .then((r) => r.json())
  .then((data) => {
    driversWithTrips = data.drivers.filter(
      (d) => d.tripAssigned && d.tripDetails && d.tripDetails.dropOffLocation
    );

    if (driversWithTrips.length === 0) {
      driverList.innerHTML = '<p class="no-drivers">No drivers with an active drop-off.</p>';
      btn.disabled = true;
      return;
    }

    driversWithTrips.forEach((driver, index) => {
      const dropOff = driver.tripDetails.dropOffLocation.name;
      const tripStatus = driver.tripDetails.tripStatus;
      const statusClass = tripStatus === "IN_PROGRESS" ? "status-in-progress" : "status-completed";
      const statusLabel = tripStatus === "IN_PROGRESS" ? "In Progress" : "Completed";

      const item = document.createElement("label");
      item.className = "driver-item" + (index === 0 ? " selected" : "");
      item.innerHTML = `
        <input type="radio" name="driver" value="${index}" ${index === 0 ? "checked" : ""} />
        <div class="driver-info">
          <span class="driver-name">${driver.driverName}</span>
          <span class="driver-dropoff">Drop-off: ${dropOff}</span>
          <span class="driver-status ${statusClass}">${statusLabel}</span>
        </div>
      `;
      item.addEventListener("change", () => {
        document.querySelectorAll(".driver-item").forEach((el) => el.classList.remove("selected"));
        item.classList.add("selected");
      });
      driverList.appendChild(item);
    });
  })
  .catch(() => {
    driverList.innerHTML = '<p class="no-drivers">Failed to load drivers.json.</p>';
    btn.disabled = true;
  });

btn.addEventListener("click", async () => {
  const selected = document.querySelector('input[name="driver"]:checked');
  if (!selected) { setStatus("Please select a driver.", "error"); return; }

  const driver = driversWithTrips[parseInt(selected.value)];
  const dropOff = driver.tripDetails.dropOffLocation;
  const loadBoardUrl = "https://relay.amazon.co.uk/loadboard/search";

  btn.disabled = true;
  setStatus("Searching...", "");

  try {
    const [existingTab] = await chrome.tabs.query({ url: loadBoardUrl + "*" });

    if (existingTab) {
      await chrome.tabs.update(existingTab.id, { active: true });
      await exportLoads(existingTab.id, dropOff);
    } else {
      const newTab = await chrome.tabs.create({ url: loadBoardUrl, active: true });
      await new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tid, info) {
          if (tid === newTab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        });
      });
      await exportLoads(newTab.id, dropOff);
    }
  } catch (err) {
    setStatus("Error: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

async function exportLoads(tabId, dropOff) {
  setStatus("Resolving city from Relay...", "");
  const csrfInfo = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "get-relay-csrf-token" }, (response) => {
      resolve(response || { ok: false, token: "" });
    });
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: fetchLoadsViaApi,
    args: ["https://relay.amazon.co.uk", dropOff, csrfInfo?.token || ""],
    world: "MAIN",
  });

  const apiResult = results?.[0]?.result;
  if (!apiResult?.ok) {
    throw new Error(apiResult?.error || "Relay API request failed.");
  }

  const rawResponse = apiResult.rawResponse;
  if (!rawResponse) {
    throw new Error("Relay API response body was empty.");
  }

  const json = JSON.stringify(rawResponse, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `loads_${(dropOff?.name || "search").replace(/[^a-z0-9]/gi, "_")}_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);

  setStatus("Done — exported Relay search response JSON.", "success");
}

// ─── Runs inside the page ─────────────────────────────────────────────────────
async function fetchLoadsViaApi(relayBase, dropOff, storedCsrfToken) {
  const base = String(relayBase || "https://relay.amazon.co.uk").replace(/\/+$/, "");

  const readCookie = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp("(?:^|; )" + escaped + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  };

  const readCsrfToken = () => {
    const metaSelectors = [
      'meta[name="csrf-token"]',
      'meta[name="csrfToken"]',
      'meta[name="_csrf"]',
      'meta[name="x-csrf-token"]',
    ];
    for (const selector of metaSelectors) {
      const value = document.querySelector(selector)?.getAttribute("content")?.trim();
      if (value) return value;
    }

    const inputSelectors = [
      'input[name="_csrf"]',
      'input[name="csrf"]',
      'input[name="csrf-token"]',
    ];
    for (const selector of inputSelectors) {
      const value = document.querySelector(selector)?.value?.trim();
      if (value) return value;
    }

    const cookieNames = [
      "csrf-token",
      "csrfToken",
      "_csrf",
      "XSRF-TOKEN",
      "CSRF-TOKEN",
    ];
    for (const name of cookieNames) {
      const value = readCookie(name);
      if (value) return value;
    }

    const globals = [
      window.__CSRF_TOKEN__,
      window.__csrfToken,
      window.csrfToken,
      window._csrf,
    ];
    for (const value of globals) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }

    const storageKeys = [
      "csrf-token",
      "csrfToken",
      "_csrf",
      "x-csrf-token",
      "X-CSRF-Token",
      "XSRF-TOKEN",
    ];
    for (const store of [window.sessionStorage, window.localStorage]) {
      try {
        for (const key of storageKeys) {
          const value = store.getItem(key);
          if (typeof value === "string" && value.trim()) return value.trim();
        }

        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (!key || !/csrf|xsrf/i.test(key)) continue;
          const value = store.getItem(key);
          if (typeof value === "string" && value.trim()) return value.trim();
        }
      } catch (error) {
        // Ignore storage access issues.
      }
    }

    try {
      const html = document.documentElement?.outerHTML || "";
      const patterns = [
        /x-csrf-token["'\s:=>]+([A-Za-z0-9+/=:_-]{20,})/i,
        /csrf-token["'\s:=>]+([A-Za-z0-9+/=:_-]{20,})/i,
        /csrfToken["'\s:=>]+([A-Za-z0-9+/=:_-]{20,})/i,
        /_csrf["'\s:=>]+([A-Za-z0-9+/=:_-]{20,})/i,
      ];
      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) return match[1].trim();
      }
    } catch (error) {
      // Ignore HTML parsing issues.
    }

    return "";
  };

  const csrfToken = (storedCsrfToken && String(storedCsrfToken).trim()) || readCsrfToken();

  const fetchJson = async (url, options) => {
    const baseHeaders = {
      Accept: "application/json",
    };
    if (csrfToken) {
      baseHeaders["X-CSRF-Token"] = csrfToken;
    }

    const response = await fetch(url, Object.assign({
      credentials: "include",
      headers: Object.assign(baseHeaders, options?.headers || {}),
    }, options || {}));

    const text = await response.text();
    if (!response.ok) {
      throw new Error("Relay HTTP " + response.status + ": " + text.slice(0, 300));
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("Relay response was not JSON.");
    }
  };

  const textValue = (value) => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return String(value);
    if (typeof value === "object") {
      return textValue(
        value.displayValue || value.name || value.label || value.value || value.text || value.amount
      );
    }
    return String(value).trim();
  };

  const numberValue = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^0-9.-]/g, ""));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === "object") {
      return numberValue(value.value ?? value.amount ?? value.distance ?? value.miles);
    }
    return null;
  };

  const pick = (obj, names) => {
    if (!obj || typeof obj !== "object") return null;
    for (const name of names) {
      if (obj[name] !== undefined && obj[name] !== null) return obj[name];
    }
    return null;
  };

  const normalizeCity = (entry) => {
    if (!entry || typeof entry !== "object") return null;

    const latitude = numberValue(pick(entry, ["latitude", "lat", "latitudeValue"]));
    const longitude = numberValue(pick(entry, ["longitude", "lng", "lon", "longitudeValue"]));
    const name = textValue(pick(entry, ["name", "city", "cityName", "label", "displayName"]));

    if (!name || latitude === null || longitude === null) return null;

    const displayValue =
      textValue(pick(entry, ["displayValue", "label", "displayName"])) ||
      name;

    const stateCode = textValue(pick(entry, ["stateCode", "stateProvinceCode", "state", "region"])) || null;
    const country = textValue(pick(entry, ["country", "countryCode", "countryName"])) || null;

    return {
      name: name,
      stateCode: stateCode,
      country: country,
      latitude: latitude,
      longitude: longitude,
      displayValue: displayValue,
      isCityLive: Boolean(pick(entry, ["isCityLive"])),
      isAnywhere: Boolean(pick(entry, ["isAnywhere"])),
      uniqueKey: textValue(pick(entry, ["uniqueKey"])) || String(latitude) + displayValue,
    };
  };

  const extractCityEntries = (data) => {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];

    const keys = ["cities", "results", "data", "suggestions", "items", "locations"];
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key];
    }

    return [];
  };

  const normalizeName = (value) =>
    textValue(value)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/,+/g, ",")
      .trim();

  const cityMatches = (city, targetName) => {
    const target = normalizeName(targetName);
    const variants = [
      city.name,
      city.displayValue,
      [city.name, city.stateCode].filter(Boolean).join(", "),
      [city.name, city.country].filter(Boolean).join(", "),
    ].map(normalizeName).filter(Boolean);

    return variants.some((variant) =>
      variant === target ||
      variant.startsWith(target) ||
      target.startsWith(variant)
    );
  };

  const pickBestCity = (cities, targetName, fallbackLocation) => {
    const normalizedCities = cities.map(normalizeCity).filter(Boolean);
    const exact = normalizedCities.find((city) => cityMatches(city, targetName));
    if (exact) return exact;
    if (normalizedCities.length > 0) return normalizedCities[0];

    const fallbackLatitude = numberValue(fallbackLocation?.latitude);
    const fallbackLongitude = numberValue(fallbackLocation?.longitude);
    const fallbackName = textValue(fallbackLocation?.name || targetName);
    if (!fallbackName || fallbackLatitude === null || fallbackLongitude === null) return null;

    return {
      name: fallbackName.split(",")[0].trim(),
      stateCode: "UK",
      country: "EU",
      latitude: fallbackLatitude,
      longitude: fallbackLongitude,
      displayValue: fallbackName,
      isCityLive: false,
      isAnywhere: false,
      uniqueKey: String(fallbackLatitude) + fallbackName,
    };
  };

  const formatMoney = (value) => {
    const amount = numberValue(value);
    return amount === null ? "" : amount.toFixed(2);
  };

  const formatDistance = (value) => {
    const distance = numberValue(value);
    return distance === null ? "" : String(distance);
  };

  const formatDuration = (value) => {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "string") return value.trim();

    const millis = numberValue(
      typeof value === "object"
        ? (value.durationInMillis ?? value.millis ?? value.value)
        : value
    );
    if (millis === null) return textValue(value);

    const totalMinutes = Math.round(millis / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours && minutes) return hours + "h " + minutes + "m";
    if (hours) return hours + "h";
    return minutes + "m";
  };

  const formatStopTime = (stop) => {
    if (!stop || typeof stop !== "object") return "";
    return textValue(
      pick(stop, [
        "displayTime",
        "timeRangeDisplayValue",
        "appointmentTimeDisplayValue",
        "localTimeWindowDisplayValue",
        "timeDisplayValue",
        "appointmentTime",
        "windowStartTime",
        "arrivalTime",
      ])
    );
  };

  const formatLocation = (location) => {
    if (!location || typeof location !== "object") return "";
    return textValue(
      pick(location, [
        "displayValue",
        "cityDisplayValue",
        "label",
        "name",
        "cityName",
      ])
    );
  };

  const findArrayByKeys = (root, keys) => {
    const seen = new Set();
    const stack = [root];

    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);

      if (Array.isArray(value) && value.length > 0) {
        const hasKey = value.some((item) =>
          item && typeof item === "object" && keys.some((key) => key in item)
        );
        if (hasKey) return value;
      }

      if (Array.isArray(value)) {
        for (const item of value) stack.push(item);
      } else {
        for (const child of Object.values(value)) stack.push(child);
      }
    }

    return [];
  };

  const extractLoadEntries = (data) =>
    findArrayByKeys(data, [
      "workOpportunityId",
      "loadId",
      "loadNumber",
      "stops",
      "tripStops",
      "pickupStop",
      "dropoffStop",
    ]);

  const normalizeLoad = (item) => {
    if (!item || typeof item !== "object") return null;

    const stops = pick(item, ["stops", "tripStops", "stopDetails"]) || [];
    const pickupStop =
      pick(item, ["pickupStop", "originStop"]) ||
      (Array.isArray(stops) ? stops[0] : null);
    const dropoffStop =
      pick(item, ["dropoffStop", "destinationStop"]) ||
      (Array.isArray(stops) && stops.length ? stops[stops.length - 1] : null);
    const pickupLocationObj = pick(pickupStop, ["location", "city"]) || pickupStop;
    const dropoffLocationObj = pick(dropoffStop, ["location", "city"]) || dropoffStop;

    const loadId = textValue(
      pick(item, ["loadId", "workOpportunityId", "loadNumber", "id"])
    );
    if (!loadId) return null;

    const tripDistanceNumber = numberValue(
      pick(item, ["tripDistance", "distance", "loadedDistance", "distanceInMiles"])
    );
    const totalPayoutNumber = numberValue(
      pick(item, ["totalPayout", "payout", "price", "totalAmount"])
    );
    const rateNumber =
      numberValue(pick(item, ["ratePerMile", "ratePerDistance", "pricePerDistance"])) ||
      (tripDistanceNumber && totalPayoutNumber
        ? totalPayoutNumber / tripDistanceNumber
        : null);

    return {
      loadId: loadId,
      deadhead: formatDistance(pick(item, ["deadhead", "deadheadDistance", "deadheadDistanceInMiles"])),
      pickupLocation: formatLocation(pickupLocationObj),
      pickupTime: formatStopTime(pickupStop),
      dropoffLocation: formatLocation(dropoffLocationObj),
      dropoffTime: formatStopTime(dropoffStop),
      tripDistance: formatDistance(tripDistanceNumber),
      duration: formatDuration(pick(item, ["duration", "durationInMillis", "tripDuration"])),
      equipment: textValue(pick(item, ["equipment", "equipmentType", "equipmentCategory"])),
      trailerType: textValue(pick(item, ["trailerType", "trailerTypeDisplayValue", "trailerRequirement"])),
      loadingType: textValue(pick(item, ["loadingType", "loadingTypeDisplayValue", "loadingCategory"])),
      totalPayout: formatMoney(totalPayoutNumber),
      ratePerMile: rateNumber === null ? "" : rateNumber.toFixed(2),
    };
  };

  try {
    const cityResponse = await fetchJson(
      base + "/api/loadboard/filters/cities/search/" + encodeURIComponent(dropOff?.name || "")
    );
    const city = pickBestCity(extractCityEntries(cityResponse), dropOff?.name || "", dropOff);
    if (!city) {
      throw new Error("No Relay city match found for " + (dropOff?.name || "selected location") + ".");
    }
    if (!csrfToken) {
      throw new Error("No x-csrf-token available yet. Run one manual Relay search in that tab so the extension can capture it, then try again.");
    }

    const payload = {
      workOpportunityTypeList: ["ROUND_TRIP", "ONE_WAY"],
      originCity: null,
      liveCity: null,
      originCities: [city],
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
          cityLatitude: city.latitude,
          cityLongitude: city.longitude,
          cityName: city.name,
          cityStateCode: city.stateCode,
          cityDisplayValue: city.displayValue,
          radius: 50,
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
      categorizedEquipmentTypeList: [
        {
          equipmentCategory: "REQUIRED",
          equipmentsList: null,
        },
      ],
      categorizedEquipmentTypeListForFilterPills: [
        {
          equipmentCategory: "REQUIRED",
          equipmentsList: null,
        },
      ],
      eligibleFeaturesExclusionFilter: ["UNANCHORED_NEGO"],
      nextItemToken: 0,
      resultSize: 50,
      searchURL: "",
      isAutoRefreshCall: false,
      notificationId: "",
      auditContextMap: JSON.stringify({
        rlbChannel: "EXACT_MATCH",
        isOriginCityLive: String(city.isCityLive),
        isDestinationCityLive: "false",
        userAgent: navigator.userAgent,
        source: "AVAILABLE_WORK",
      }),
    };

    const searchResponse = await fetchJson(base + "/api/loadboard/search", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const loads = extractLoadEntries(searchResponse).map(normalizeLoad).filter(Boolean);
    return {
      ok: true,
      city: city,
      csrfTokenFound: true,
      rawResponse: searchResponse,
      loads: loads,
      total: loads.length,
    };
  } catch (error) {
    return {
      ok: false,
      csrfTokenFound: Boolean(csrfToken),
      error: error && error.message ? error.message : String(error),
    };
  }
}

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + (type || "");
}

// ─── RLB Location Sync ────────────────────────────────────────────────────────
(function () {
  const DEFAULTS = {
    relayBase: "https://relay.amazon.co.uk",
    ontrackUrl: "https://ontrack-api.agilecyber.com/api/v1/rlb-locations",
    token: "",
    letters: "abcdefghijklmnopqrstuvwxyz",
    prefix: ", ",
    delayMs: 500,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    toggle: $("toggleSettings"),
    settings: $("settings"),
    ontrackUrl: $("ontrackUrl"),
    token: $("token"),
    relayBase: $("relayBase"),
    prefix: $("prefix"),
    letters: $("letters"),
    delayMs: $("delayMs"),
    save: $("saveSettings"),
    sync: $("syncBtn"),
    log: $("syncLog"),
  };

  function loadSettings() {
    chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
      const cfg = Object.assign({}, DEFAULTS, r || {});
      els.ontrackUrl.value = cfg.ontrackUrl;
      els.token.value = cfg.token;
      els.relayBase.value = cfg.relayBase;
      els.prefix.value = cfg.prefix;
      els.letters.value = cfg.letters;
      els.delayMs.value = cfg.delayMs;
    });
  }

  els.toggle.addEventListener("click", () => {
    els.settings.classList.toggle("hidden");
  });

  els.save.addEventListener("click", () => {
    const cfg = {
      ontrackUrl: els.ontrackUrl.value.trim() || DEFAULTS.ontrackUrl,
      token: els.token.value.trim(),
      relayBase: els.relayBase.value.trim() || DEFAULTS.relayBase,
      prefix: els.prefix.value,
      letters: els.letters.value.trim() || DEFAULTS.letters,
      delayMs: Math.max(0, parseInt(els.delayMs.value, 10) || DEFAULTS.delayMs),
    };
    chrome.storage.local.set(cfg, () => appendLog({ msg: "Settings saved.", level: "success", ts: Date.now() }));
  });

  els.sync.addEventListener("click", () => {
    els.log.innerHTML = "";
    chrome.runtime.sendMessage({ type: "start-harvest" }, () => {
      if (chrome.runtime.lastError) {
        appendLog({ msg: "Error: " + chrome.runtime.lastError.message, level: "error", ts: Date.now() });
      }
    });
  });

  function appendLog(entry) {
    const line = document.createElement("div");
    line.className = "log-line log-" + (entry.level || "info");
    const t = new Date(entry.ts || Date.now()).toLocaleTimeString();
    line.textContent = "[" + t + "] " + entry.msg;
    els.log.appendChild(line);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function renderLog(entries) {
    els.log.innerHTML = "";
    (entries || []).forEach(appendLog);
  }

  // Live updates while harvesting.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "harvest-progress" && msg.entry) appendLog(msg.entry);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.harvestRunning) {
      els.sync.disabled = changes.harvestRunning.newValue === true;
      els.sync.textContent = changes.harvestRunning.newValue ? "Syncing…" : "Sync RLB Locations (a–z)";
    }
  });

  // On open, restore settings + the last run's log.
  loadSettings();
  chrome.storage.local.get(["harvestLog", "harvestRunning"], (r) => {
    renderLog(r.harvestLog);
    if (r.harvestRunning) {
      els.sync.disabled = true;
      els.sync.textContent = "Syncing…";
    }
  });
})();
