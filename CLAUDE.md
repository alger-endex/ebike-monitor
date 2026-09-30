# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

No build step, no package.json, no tests. Serve the folder and open `index.html` in Chrome or Edge. Web Bluetooth requires a **secure context**: either `localhost` or HTTPS. Opening as a `file://` URL will not work.

A simple local server works:
```
npx serve .
# or
python -m http.server 8080
```
Then navigate to `http://localhost:8080`.

There is no lint/test/build tooling in this repo — verify changes by loading the page and exercising the BLE flow against real hardware (or by reading through the event handlers, since there's no mock device).

`manual.html` is a self-contained user manual (no shared CSS/JS with the app) linked from the "📖 操作說明書" button in `index.html`. It has no Web Bluetooth dependency, so unlike `index.html` it can be opened directly via `file://`. Keep it in sync by hand when app behavior changes — nothing regenerates it automatically.

`testlog/` (untracked) holds real CSV exports from Recording Mode (`vehicle_status_*.csv`, `motor_idiq_*.csv`; `_segN_` files come from auto-save rotation). They're useful as reference data for the CSV column layout and realistic value ranges.

## Versioning

There are two independent version numbers:
- **App version** is `APP_VERSION` at the top of [js/app.js](js/app.js), and it's rendered into the `#appVersion` header badge. Bumps get their own `chore: 進版至 vX.Y.Z` commit.
- **Manual version** is the `手冊版本` pill in `manual.html`'s masthead, and it goes up on every manual edit. Each change gets a new `.change-entry` at the top of the changelog section (currently §14). An app version bump also means updating the `程式版本` pill in the manual and adding a changelog entry for it.

Commit messages are written in Traditional Chinese with conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `style:`).

## Layout / CSS

All styling lives in [style.css](style.css). On desktop the page is a fixed-viewport-height `body` flex column, and `.main-area` scrolls internally. At the mobile breakpoint (`@media (max-width: 768px)`) it switches to natural whole-page scrolling: `body` gets `height:auto`, and `.main-area` gets `overflow-y:visible`. Because `body` is a flex column, every direct child needs `min-width:0` (and `min-height:0` where it applies). Otherwise one long non-wrapping line, like the StartCmd hex preview, stretches the whole page wider than the screen. Earlier mobile bugs came from this, so check it whenever you add a new top-level row or long inline content.

## Architecture

Single-page vanilla JS app with no framework or bundler. Four script files load in order via `<script>` tags at the bottom of [index.html](index.html):

1. **[js/ble.js](js/ble.js)** — `BleManager` class. Owns the Web Bluetooth connection lifecycle. On `open()`, it scans for any BLE device, then auto-detects the UART bridge profile by trying ESP_GATTS → NUS → HM10 → SPP in order (first service exposing both a write and notify characteristic wins). All inbound data flows through one path: the `characteristicvaluechanged` listener pushes bytes into `_rxBuf` and calls `_dispatchFrames()`, which parses complete frames out of the buffer and invokes a callback — **the app is event-driven, not polling**; nothing calls `readCanFrame()` in normal operation (it exists as a lower-level helper for one-off waits).

2. **[js/protocol.js](js/protocol.js)** — Stateless packet builders, CAN ID constants, and batch-frame parsers. Two independent wire formats live here (see below).

3. **[js/app.js](js/app.js)** — All UI logic and state. Runs `setTimeout`-based polling loops that write CAN requests on an interval; replies arrive later via `ble.onCanFrame`/`ble.onRecordingBatch` and update DOM elements directly by ID. Also owns Drive Current / Recording Mode CSV logging and the SetBit / Battery Info modals (read-only bit viewers).

4. **[js/param.js](js/param.js)** — Parameter Read/Write page (`#pageParam`: single read/write, device SIG, `.txt` batch). It uses app.js globals (`ble`, `sleep`, `recordingModeActive`), so it must load after app.js. Unlike the fire-and-forget monitor loops, this is **request/response**: `app.js`'s `onCanFrame` forwards `CAN_CMD_RX` frames to `paramOnCanFrame()`, and only one request is outstanding at a time (`paramPending` + `paramBusy`). A reply is accepted only if its FC and address match the request, or if it's the matching error FC (`0x83`/`0x86`). Anything else is logged as `[RX SKIP]` and ignored, so a late reply to an earlier timed-out request can't be mistaken for the current one. Frames that no `onCanFrame` branch handles (unknown ID, or `CAN_CMD_RX` shorter than 6 bytes) fall through to `paramOnUnhandledFrame()`, which logs them as `[RX ID?]` only while a request is pending. This is how you tell a reply on the wrong CAN ID apart from no reply at all. Addresses `0x0000~0x0003` hold the 8-char ASCII SIG. Batch write refuses to run if the file SIG doesn't match the device SIG, and it never writes addresses ≤ `0x0020`.

## Two Wire Formats

`BleManager` switches between two mutually exclusive framing modes via `setRecordingMode()`. Only one is active at a time; toggling clears `_rxBuf` to avoid misparsing stale bytes as the other format.

### 1. Tool_R CAN frames (default mode)

Fire-and-forget request/notify: write a request packet, the controller replies asynchronously as a BLE notification, `_dispatchFrames()` picks the 15-byte frame out of `_rxBuf` and fires `ble.onCanFrame(id, len, data)`.

Format: `0xFA 0x0D` + CAN ID (4 bytes LE) + length (1 byte) + data (8 bytes) = 15 bytes total.

- `buildDrvStartCmd(data8)` must be written first each tick before data queries — it both keeps the controller's watchdog alive and carries all rider-facing controls (assist level, lights, switch, operation mode, broadcast, battery lock, gear) packed into its 8 data bytes. `getStartCmdData()` in app.js assembles this array from the params panel UI.
- Request/response pairs: Fault, Status, Assist, Distance, and Motor Vector (rotor angle / Id / Iq / Vd_cmd / Vq_cmd). Each has a primary CAN ID and an `_ALT` fallback ID that the controller also replies on.
- Battery 1/2 telemetry (`DRV_RX_BATTERY*_CAP`/`_STATUS`) is **not requested** — the controller broadcasts it periodically on its own; `ble.onCanFrame` just needs to recognize the IDs. Single-battery vehicles broadcast on the `_SINGLE_*` IDs instead of the battery-1 IDs.
- Two independent monitor loops write requests on their own `setTimeout` cadence: `drvMonitorLoop` (1000 ms, Fault/Status/Assist/Distance/StartCmd — each gated by a checkbox in the tick bar) and `motorVectorMonitorLoop` (interval set by `#mvInterval`, only StartCmd + Motor Vector request — kept separate because vector data is wanted at a much higher rate without flooding the other queries).

### 2. Recording Mode batch frames

Toggled with `buildRecordingModeCmd(enable)` (`0xFD` command byte). Once enabled, the controller **stops** sending Tool_R frames and instead streams batches: `command(1) + length(1) + payload(length)`. The two batch types are **not** the same size on the wire — vehicle batches are 212 bytes total (210-byte payload), motor batches are 242 bytes total (240-byte payload) — so `_dispatchRecordingFrames()` reads the length byte per frame to determine how many bytes to slice, rather than assuming a fixed size. There is no magic/sync byte in this format, so if the stream desyncs (e.g. a dropped byte) there is no recovery.

- `REC_BATCH_VEHICLE` (`0xFD`) → `parseVehicleStatusBatch`: 6 samples × 35 bytes of vehicle/driver/battery state per batch.
- `REC_BATCH_MOTOR` (`0xFE`) → `parseMotorIdIqBatch`: 24 samples × 10 bytes of motor Id/Iq per batch.
- Note the deliberate collision: `REC_CMD_BYTE` (mobile→device, enable/disable) and `REC_BATCH_VEHICLE` (device→mobile, batch tag) are both `0xFD` — same value, opposite direction, unrelated meaning. Don't conflate them when tracing traffic.
- Because the controller can't do both at once, `app.js` freezes a snapshot of the last live CAN values the instant recording starts (`captureRecBaseline`) and renders a before/after diff table (`renderRecCompareTable`) against the incoming batch data — there's no way to cross-validate the two formats in real time otherwise.
- Recorded samples accumulate in memory (`recVehicleLog`/`recMotorLog`) and export to CSV. `chkRecAutoSave` enables periodic auto-export + buffer rotation (`recAutoSaveTick`/`autoSaveAndRotate`) so long recordings don't grow unbounded.

## Key Protocol Details

- Register bit indicators use two CSS states: default `.on` = red (error), `.drv-ok.on` = green (normal/active). This distinction is set in the HTML, not in JS.
- `drvUpdateFault()` / `drvUpdateRecordingVehicle()` set `_regDRV = _regFault` — Fault and DRV share the same response frame; the DRV 5-bit register is the lower byte of the Fault register.
- Battery fault/status registers exist per-battery (`_bat1FaultReg`/`_bat2FaultReg`, etc.) and are updated from either live CAN battery frames or Recording Mode batches — same registers, two transport paths, bit tables in `REG_DEFS` (CAN) and `BATTERY_FAULT_BIT_LABELS` (Recording Mode modal) are kept in sync manually.
- `<main>` holds two pages, `#pageMonitor` and `#pageParam`, switched by the `.page-tabs` bar under the top bar (handler in app.js). Switching tabs only toggles visibility. The monitor loops and the BLE connection keep running, and the function-key bar/params panel are shared by both pages.
- The params/tick panel (`#paramsPanel`) is collapsible via `btnToggleParams`; StartCmd controls and per-request tick checkboxes live there so the top bar stays compact.

## BLE UART Profiles

| Profile   | Service UUID      | Write        | Notify       | Config       |
|-----------|-------------------|--------------|--------------|--------------|
| ESP_GATTS | `0x00ff`          | `0xff01`     | `0xff01`     | —            |
| NUS       | `6e400001-...`    | `6e400002-…` | `6e400003-…` | `6e400004-…` |
| HM10      | `0xffe0`          | `0xffe1`     | `0xffe1`     | —            |
| SPP       | `0xabf0`          | `0xabf1`     | `0xabf2`     | —            |

The NUS profile has an optional cfg characteristic used to set baud rate (default 460800, sent as a 5-byte `0x01` + LE uint32 packet on `open()`).
