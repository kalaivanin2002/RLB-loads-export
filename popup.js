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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function typeInto(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    nativeSetter.call(input, value);
    ["focus", "input", "change"].forEach((name) =>
      input.dispatchEvent(new Event(name, { bubbles: true }))
    );
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keyup",   { bubbles: true, cancelable: true }));
  }

  async function setDestination() {
    const input = document.querySelector('#rlb-origin-city-filter input[role="combobox"]') ||
                  document.querySelector('input[placeholder="Start typing to search"]');
    if (!input) { console.error("[RLB] origin input not found"); return; }

    const wrapper = document.querySelector("#rlb-origin-city-filter");
    if (wrapper) wrapper.click();
    await wait(200);

    input.focus();
    await wait(150);
    typeInto(input, "");
    await wait(100);
    typeInto(input, dropOffName);
    await wait(1800);

    const listboxId = input.getAttribute("aria-controls");
    const listbox = listboxId
      ? document.getElementById(listboxId)
      : document.querySelector('[role="listbox"]');

    if (!listbox) { console.warn("[RLB] origin listbox not found"); return; }

    const options = [...listbox.querySelectorAll('[role="option"]')];
    const match = options.find(
      (o) => o.textContent.trim().toLowerCase().includes(dropOffName.toLowerCase().split(",")[0])
    ) || options[0];

    if (match) {
      match.click();
      await wait(600);
      // Click outside to confirm the selection and close the dropdown
      document.body.click();
      await wait(300);
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      await wait(400);
    } else {
      console.warn("[RLB] no suggestion matched:", dropOffName);
    }
  }

  async function setEquipment() {
    // Close any open dropdown (origin listbox) with Escape then a body click
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(300);
    document.body.click();
    await wait(600);

    const equipInput =
      document.querySelector('input[aria-label="Equipment*"]') ||
      document.querySelector('#equipment-trailer-filter input');

    if (!equipInput) { console.error("[RLB] equipment input not found"); return; }

    // Open the equipment dropdown
    equipInput.focus();
    await wait(200);
    equipInput.click();
    await wait(1200);

    // The dropdown div is always in DOM with id="equipment-type-filter-dropdown"
    const dropdown = document.querySelector("#equipment-type-filter-dropdown");
    if (!dropdown) { console.error("[RLB] equipment dropdown not found"); return; }

    // The checkboxes are custom React divs with role="checkbox" and id="REQUIRED"/"PROVIDED"/"OTHER"
    // "Tractor and trailer" maps to id="REQUIRED"
    const checkbox = dropdown.querySelector('[role="checkbox"][id="REQUIRED"]');

    if (checkbox) {
      checkbox.click();
      await wait(500);
    } else {
      // Fallback: find by searching for a region containing "tractor and trailer" text
      // and click the [role="checkbox"] inside it
      const regions = [...dropdown.querySelectorAll('[role="region"]')];
      const tractorRegion = regions.find((r) =>
        r.textContent.trim().toLowerCase().includes("tractor and trailer")
      );
      const fallbackCheckbox = tractorRegion?.querySelector('[role="checkbox"]');
      if (fallbackCheckbox) {
        fallbackCheckbox.click();
        await wait(500);
      } else {
        console.warn("[RLB] Tractor and trailer checkbox not found");
      }
    }

    // Close the equipment dropdown by clicking outside
    await wait(200);
    document.body.click();
    await wait(300);
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
