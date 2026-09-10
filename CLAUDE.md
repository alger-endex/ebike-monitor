# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

No build step, no package.json, no tests. Open `index.html` directly in Chrome or Edge. Web Bluetooth requires a **secure context**: either `localhost` or HTTPS. Opening as a `file://` URL will not work.

A simple local server works:
```
npx serve .
# or
python -m http.server 8080
```
Then navigate to `http://localhost:8080`.

There is no lint/test/build tooling in this repo — verify changes by loading the page and exercising the BLE flow against real hardware (or by reading through the event handlers, since there's no mock device).

## Architecture

Single-page vanilla JS app with no framework or bundler. Three script files load in order via `<script>` tags at the bottom of [index.html](index.html):

1. **[js/ble.js](js/ble.js)** — `BleManager` class. Owns the Web Bluetooth connection lifecycle. On `open()`, it scans for any BLE device, then auto-detects the UART bridge profile by trying ESP_GATTS → NUS → HM10 → SPP in order (first service exposing both a write and notify characteristic wins). All inbound data flows through one path: the `characteristicvaluechanged` listener pushes bytes into `_rxBuf` and calls `_dispatchFrames()`, which parses complete frames out of the buffer and invokes a callback — **the app is event-driven, not polling**; nothing calls `readCanFrame()` in normal operation (it exists as a lower-level helper for one-off waits).

2. **[js/protocol.js](js/protocol.js)** — Stateless packet builders, CAN ID constants, and batch-frame parsers. Two independent wire formats live here (see below).

3. **[js/app.js](js/app.js)** — All UI logic and state. Runs `setTimeout`-based polling loops that write CAN requests on an interval; replies arrive later via `ble.onCanFrame`/`ble.onRecordingBatch` and update DOM elements directly by ID. Also owns Drive Current / Recording Mode CSV logging and the SetBit / Battery Info modals (read-only bit viewers).

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

Toggled with `buildRecordingModeCmd(enable)` (`0xFD` command byte). Once enabled, the controller **stops** sending Tool_R frames and instead streams fixed 242-byte batches: `command(1) + length(1) + payload(240)`. There is no magic/sync byte in this format, so `_dispatchRecordingFrames()` just slices off complete 242-byte chunks — if the stream desyncs there is no recovery.

- `REC_BATCH_VEHICLE` (`0xFD`) → `parseVehicleStatusBatch`: 6 samples × 35 bytes of vehicle/driver/battery state per batch.
- `REC_BATCH_MOTOR` (`0xFE`) → `parseMotorIdIqBatch`: 24 samples × 10 bytes of motor Id/Iq per batch.
- Note the deliberate collision: `REC_CMD_BYTE` (mobile→device, enable/disable) and `REC_BATCH_VEHICLE` (device→mobile, batch tag) are both `0xFD` — same value, opposite direction, unrelated meaning. Don't conflate them when tracing traffic.
- Because the controller can't do both at once, `app.js` freezes a snapshot of the last live CAN values the instant recording starts (`captureRecBaseline`) and renders a before/after diff table (`renderRecCompareTable`) against the incoming batch data — there's no way to cross-validate the two formats in real time otherwise.
- Recorded samples accumulate in memory (`recVehicleLog`/`recMotorLog`) and export to CSV. `chkRecAutoSave` enables periodic auto-export + buffer rotation (`recAutoSaveTick`/`autoSaveAndRotate`) so long recordings don't grow unbounded.

## Key Protocol Details

- Register bit indicators use two CSS states: default `.on` = red (error), `.drv-ok.on` = green (normal/active). This distinction is set in the HTML, not in JS.
- `drvUpdateFault()` / `drvUpdateRecordingVehicle()` set `_regDRV = _regFault` — Fault and DRV share the same response frame; the DRV 5-bit register is the lower byte of the Fault register.
- Battery fault/status registers exist per-battery (`_bat1FaultReg`/`_bat2FaultReg`, etc.) and are updated from either live CAN battery frames or Recording Mode batches — same registers, two transport paths, bit tables in `REG_DEFS` (CAN) and `BATTERY_FAULT_BIT_LABELS` (Recording Mode modal) are kept in sync manually.
- The params/tick panel (`#paramsPanel`) is collapsible via `btnToggleParams`; StartCmd controls and per-request tick checkboxes live there so the top bar stays compact.

## BLE UART Profiles

| Profile   | Service UUID      | Write        | Notify       | Config       |
|-----------|-------------------|--------------|--------------|--------------|
| ESP_GATTS | `0x00ff`          | `0xff01`     | `0xff01`     | —            |
| NUS       | `6e400001-...`    | `6e400002-…` | `6e400003-…` | `6e400004-…` |
| HM10      | `0xffe0`          | `0xffe1`     | `0xffe1`     | —            |
| SPP       | `0xabf0`          | `0xabf1`     | `0xabf2`     | —            |

The NUS profile has an optional cfg characteristic used to set baud rate (default 460800, sent as a 5-byte `0x01` + LE uint32 packet on `open()`).
