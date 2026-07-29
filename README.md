# RLB Load Search

Chrome extension (Manifest V3) that highlights which loads on the **Amazon Relay
load board** match the carrier's available drivers.

When you click **⚡ Find my best loads** on the load board, it reads the carrier's
driver shift schedule from FleetYes, works out when and where each driver becomes
free, scores every load the board is showing against those drivers, and highlights
the matches in place with a badge and a hover panel.

It only ever **reads** the board and highlights it. It never books, accepts or
declines a load, and never changes anything in the Amazon Relay account.

---

## Requirements

To actually use the extension you need **both**:

- an **Amazon Relay** carrier account (signed in, on `relay.amazon.co.uk` or `relay.amazon.com`)
- a **FleetYes** account for that same carrier

Without the FleetYes side you'll get a "not registered with FleetYes" message and
the extension falls back to reading drivers from Relay trips. Without the Relay
side, nothing runs at all — the load board is the only page it acts on.

---

## Install it for testing

No build step. Nothing to unzip.

```bash
git clone https://github.com/acsdeveloper/RLB-loads-export.git
```

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **cloned folder itself**

"Load unpacked" means *load from a folder* — there is no archive involved. Chrome
reads `manifest.json` and loads only the files it lists, ignoring everything else
in the repo (`scripts/`, `brand/`, docs, `.git/`).

Then open the Amazon Relay load board and click **⚡ Find my best loads**.

---

## Development loop

Edit the source files in the repo root, then:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

Then click **Reload** ↻ on the extension card in `chrome://extensions`.

If you loaded the repo root (above), you can skip the packaging step entirely for
day-to-day work — just edit and hit Reload. Run the packaging script when you want
to verify the real shipping artifact, or before uploading.

---

## Building the Web Store package

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

Produces two things, every run:

| Output | Purpose |
|---|---|
| `dist/` | the 13 files that ship — load this to test the exact artifact |
| `rlb-load-search.zip` | upload this to the Chrome Web Store, as-is |

`SHIP` in `scripts/package.ps1` is an explicit **allowlist**. A file you add later
cannot leak into the package by accident — a denylist fails open, which is how
internal docs and a driver-schedule export once ended up in the folder being zipped.

> **Never edit anything inside `dist/`.** It is deleted and rebuilt on every run.
> Always edit the source files in the repo root.

For a Store **update**, bump `"version"` in `manifest.json` first — the Store
rejects a re-upload with an unchanged version number.

---

## Regenerating the icons

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
```

Rasterizes `brand/fleetyes_logo.svg` into `icons/icon{16,32,48,128}.png` using
headless Chrome, auto-cropping to the mark's real alpha bounds before downsampling
(the source viewBox has uneven margins, so a naive resize leaves the mark
off-centre and undersized at 16px).

For a light tile behind the mark — the green reads at only ~2:1 contrast on
Chrome's dark toolbar:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1 -Background "#FFFFFF"
```

---

## Project layout

| File | World | What it does |
|---|---|---|
| `manifest.json` | — | MV3 manifest |
| `background.js` | service worker | Serves four messages from the content script: `sync-rlb-settings`, `refresh-availability`, `refresh-unassigned-drivers`, `score-loads`. Owns no jobs of its own. |
| `payloads.js` | service worker | Captured `entitiesV2` request bodies; date bounds are freshened at runtime |
| `hook.js` | **MAIN** | Intercepts the page's own `fetch`/XHR to capture load-board search responses and the anti-CSRF token |
| `bridge.js` | ISOLATED | Relays `hook.js` messages into `chrome.storage` (the MAIN world has no extension APIs) |
| `loadboard.js` | ISOLATED | All on-page UI: launcher button, highlighting, tooltip, drivers panel, result card |
| `popup.*` | popup | Information only — every setting comes from FleetYes |
| `brand/`, `scripts/` | — | Logo source and build tooling. Not shipped. |

**Availability sources.** The FleetYes shifts API is primary. If it fails *or
returns an empty driver list*, the extension falls back to reading drivers from
Relay directly — both in-transit/upcoming trips and the `/api/hos/drivers` roster.
Missing configuration (no Search Location or carrier code) is treated differently:
it surfaces as a setup error rather than falling back, since there would be no
origin to search from.

---

## Development notes

- **Never interact with any "Book" control.** If a Book button, link or action
  appears anywhere in a workflow, skip it — the extension must never book a load.
- **Keep the `.ps1` scripts ASCII-only.** Windows PowerShell 5.1 reads a BOM-less
  `.ps1` as ANSI, so a UTF-8 em dash decodes into bytes containing a quote
  character and breaks the parser.
- **Never commit driver exports.** `.gitignore` blocks `drivers.json`,
  `driver_schedule.json` and `*_schedule.json`. A published extension package is
  world-readable, so real driver data must never reach the shipping folder.
- The extension has **no third-party libraries** and executes **no remote code** —
  no `eval`, no `new Function`, no remotely loaded scripts.
