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
  const dropOff = driver.tripDetails.dropOffLocation.name;
  const loadBoardUrl = "https://relay.amazon.co.uk/loadboard/search";

  btn.disabled = true;
  setStatus("Searching...", "");

  try {
    const [existingTab] = await chrome.tabs.query({ url: loadBoardUrl + "*" });

    if (existingTab) {
      await chrome.tabs.update(existingTab.id, { active: true });
      await runInject(existingTab.id, dropOff);
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
      await runInject(newTab.id, dropOff);
      await exportLoads(newTab.id, dropOff);
    }
  } catch (err) {
    setStatus("Error: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

async function runInject(tabId, dropOff) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: pageInject,
    args: [dropOff],
  });
}

async function exportLoads(tabId, dropOff) {
  // Wait for search results to render after pageInject clicks "Search loads"
  setStatus("Waiting for results...", "");
  await new Promise((r) => setTimeout(r, 5000));

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapeLoads,
  });

  const loads = results?.[0]?.result;
  if (!loads || loads.length === 0) {
    setStatus("No loads found.", "error");
    return;
  }

  const headers = [
    "Load ID", "Deadhead (mi)",
    "Pickup Location", "Pickup Time",
    "Dropoff Location", "Dropoff Time",
    "Trip Distance (mi)", "Duration",
    "Equipment", "Trailer Type", "Loading Type",
    "Total Payout (£)", "Rate (£/mi)",
  ];
  const rows = loads.map((l) => [
    l.loadId, l.deadhead,
    l.pickupLocation, l.pickupTime,
    l.dropoffLocation, l.dropoffTime,
    l.tripDistance, l.duration,
    l.equipment, l.trailerType, l.loadingType,
    l.totalPayout, l.ratePerMile,
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `loads_${dropOff.replace(/[^a-z0-9]/gi, "_")}_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  setStatus(`Done — exported ${loads.length} load(s).`, "success");
}

// ─── Runs inside the page ─────────────────────────────────────────────────────
function pageInject(dropOffName) {
  const INJECT_VERSION = "2026-06-17b";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  console.log("[RLB] injector version:", INJECT_VERSION);

  async function waitFor(getValue, { timeout = 6000, interval = 150 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = getValue();
      if (value) return value;
      await wait(interval);
    }
    return null;
  }

  function clickElement(el) {
    if (!el) return;
    const pointerTypes = ["pointerdown", "mousedown", "pointerup", "mouseup"];
    pointerTypes.forEach((type) => {
      const EventCtor = window.PointerEvent || window.MouseEvent;
      el.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true }));
    });
    el.click();
  }

  function getSelectedText(container) {
    const selected = container?.querySelector("[mdn-select-value]")?.textContent?.trim();
    const inputValue = container?.querySelector('input')?.value?.trim();
    return selected || inputValue || "";
  }

  function typeInto(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    nativeSetter.call(input, value);
    ["focus", "input", "change"].forEach((name) =>
      input.dispatchEvent(new Event(name, { bubbles: true }))
    );
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keyup",   { bubbles: true, cancelable: true }));
  }

  async function clearInput(input) {
    input.focus();
    await wait(100);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true }));
    typeInto(input, "");
    await wait(120);
  }

  async function typeLikeUser(input, value) {
    await clearInput(input);
    for (const char of value) {
      const nextValue = `${input.value || ""}${char}`;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true, cancelable: true }));
      typeInto(input, nextValue);
      input.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true, cancelable: true }));
      await wait(60);
    }
  }

  async function chooseOptionFromOverlay({ query, matchers, exactValue }) {
    const overlay = await waitFor(() => {
      const candidates = [
        ...document.querySelectorAll('[role="listbox"]'),
        ...document.querySelectorAll('[id^="options-list-"]'),
        ...document.querySelectorAll('[role="dialog"]'),
      ];
      return candidates.find((candidate) => {
        const text = normalize(candidate.textContent);
        return text && (text.includes(normalize(query)) || matchers.some((matcher) => text.includes(matcher)));
      });
    }, { timeout: 7000, interval: 200 });

    if (!overlay) return null;

    const options = [
      ...overlay.querySelectorAll('[role="option"]'),
      ...overlay.querySelectorAll('button'),
      ...overlay.querySelectorAll('[role="checkbox"]'),
      ...overlay.querySelectorAll('input[type="checkbox"]'),
    ];

    return options.find((option) => {
      const text = normalize([
        option.getAttribute("aria-label"),
        option.textContent,
        option.closest("label")?.textContent,
        option.parentElement?.textContent,
      ].filter(Boolean).join(" "));
      return exactValue ? text === exactValue : matchers.some((matcher) => text.includes(matcher));
    }) || null;
  }

  async function setDestination() {
    const input = document.querySelector('#rlb-origin-city-filter input[role="combobox"]') ||
                  document.querySelector('input[placeholder="Start typing to search"]');
    if (!input) { console.error("[RLB] origin input not found"); return; }

    const wrapper = document.querySelector("#rlb-origin-city-filter");
    clickElement(wrapper || input);
    await wait(200);

    const normalizedDropOff = normalize(dropOffName);
    const cityOnly = normalize(dropOffName.split(",")[0]);
    await typeLikeUser(input, dropOffName);
    await wait(1200);

    const match = await chooseOptionFromOverlay({
      query: dropOffName,
      matchers: [normalizedDropOff, cityOnly],
      exactValue: normalizedDropOff,
    });

    if (match) {
      clickElement(match);
      await wait(400);
      clickElement(document.body);
      const committed = await waitFor(() => {
        const visibleValue = getSelectedText(wrapper);
        const chipText = normalize(document.body.innerText);
        if (normalize(visibleValue).includes(cityOnly)) return visibleValue;
        if (chipText.includes(normalizedDropOff)) return dropOffName;
        return null;
      }, { timeout: 4000, interval: 200 });

      if (!committed) {
        console.warn("[RLB] origin did not commit via click, trying Enter");
        input.focus();
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        await wait(500);
      }

      console.log("[RLB] origin committed value:", getSelectedText(wrapper) || input.value || dropOffName);
    } else {
      console.warn("[RLB] no suggestion matched:", dropOffName);
    }
  }

  async function setEquipment() {
    const equipContainer = document.getElementById("equipment-trailer-filter");
    if (!equipContainer) { console.error("[RLB] equipment-trailer-filter not found"); return; }

    const inputBox = equipContainer.querySelector('[mdn-input-box]');
    const equipInput = equipContainer.querySelector('input');
    if (!equipInput) {
      console.error("[RLB] equipment input not found");
      return;
    }

    clickElement(inputBox || equipInput || equipContainer);
    await wait(200);
    await typeLikeUser(equipInput, "required");
    await wait(800);

    const option = await chooseOptionFromOverlay({
      query: "required",
      matchers: ["required", "required trailer", "required equipment"],
      exactValue: null,
    });

    if (option) {
      clickElement(option.closest("label") || option);
      await wait(400);
    } else {
      console.warn("[RLB] REQUIRED option not found in overlay, trying Enter from input");
      equipInput.focus();
      equipInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true }));
      equipInput.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true }));
      await wait(200);
      equipInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      equipInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      await wait(400);
    }

    const selectedEquipment = await waitFor(() => {
      const value = getSelectedText(equipContainer) || equipInput.value;
      return normalize(value).includes("required") ? value : null;
    }, { timeout: 4000, interval: 200 });

    if (!selectedEquipment) {
      console.error("[RLB] equipment selection did not commit");
      return;
    }

    console.log("[RLB] equipment selected value:", selectedEquipment);

    clickElement(document.body);
    await wait(400);
  }

  async function clickSearchLoads() {
    const btn = [...document.querySelectorAll('button[type="button"]')].find(
      (b) => b.textContent.trim().toLowerCase() === "search loads"
    );
    if (!btn) { console.error("[RLB] Search loads button not found"); return; }
    btn.click();
    await wait(300);
  }

  (async () => {
    await wait(800);
    await setDestination();
    await wait(1200);
    await setEquipment();
    await wait(800);
    await clickSearchLoads();
  })();
}

// ─── Runs inside the page ─────────────────────────────────────────────────────
function scrapeLoads() {
  const cards = [...document.querySelectorAll(".load-card > div")];

  return cards.map((card) => {
    const text = (el) => el?.textContent?.trim() ?? "";

    const loadId = card.id ?? "";
    const deadhead = text(card.querySelector(".css-8a5j1c .css-1maqsxd"));

    const stopDetails = [...card.querySelectorAll(".css-soq2b7 > div")].filter(
      (d) => d.querySelector("span[tabindex]")
    );

    const pickupLocation  = text(stopDetails[0]?.querySelector(".wo-card-header__components"));
    const pickupTime      = text(stopDetails[0]?.querySelectorAll(".wo-card-header__components")?.[1]);
    const dropoffLocation = text(stopDetails[1]?.querySelector(".wo-card-header__components"));
    const dropoffTime     = text(stopDetails[1]?.querySelectorAll(".wo-card-header__components")?.[1]);

    const tripBlock    = [...card.querySelectorAll(".css-8a5j1c")][1];
    const tripDistance = text(tripBlock?.querySelector(".css-1xm8gt .wo-card-header__components"));
    const duration     = text(tripBlock?.querySelector(".css-fnc3ff .wo-card-header__components"));

    const equipment   = text(card.querySelector(".equipment-type-text span"));
    const trailerType = text(card.querySelector(".trailer-type-circle p"));
    const loadingType = card.querySelector(".loading-type")?.getAttribute("title")
                      ?? text(card.querySelector(".loading-type"));

    const totalPayout = text(card.querySelector(".wo-total_payout"));
    const ratePerMile = text(card.querySelector('[class*="n4zms0"] .wo-card-header__components'));

    return { loadId, deadhead, pickupLocation, pickupTime, dropoffLocation, dropoffTime, tripDistance, duration, equipment, trailerType, loadingType, totalPayout, ratePerMile };
  }).filter((l) => l.loadId);
}

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + (type || "");
}
