# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

No build step. Open `index.html` directly in Chrome or Edge. Web Bluetooth requires a **secure context**: either `localhost` or HTTPS. Opening as a `file://` URL will not work.

A simple local server works:
```
npx serve .
# or
python -m http.server 8080
```
Then navigate to `http://localhost:8080`.

## Architecture

Single-page vanilla JS app with no framework or build tooling. Three script files are loaded in order via `<script>` tags at the bottom of `index.html`:

1. **[js/ble.js](js/ble.js)** — `BleManager` class. Owns the Web Bluetooth connection lifecycle. On `open()`, it scans for any BLE device, then auto-detects the UART bridge profile by trying ESP_GATTS → NUS → HM10 → SPP in order. Incoming BLE notification bytes are pushed into `_rxBuf`. `readCanFrame()` polls `_rxBuf` for a complete 15-byte Tool_R packet (starts with `0xFA 0x0D`).

2. **[js/protocol.js](js/protocol.js)** — Stateless packet builders and CAN ID constants. The wire format ("Tool_R") is: `0xFA 0x0D` + CAN ID (4 bytes LE) + length (1 byte) + data (8 bytes) = 15 bytes total. The four request/response pairs map to Fault, Status, Assist, and Distance data from the motor controller.

3. **[js/app.js](js/app.js)** — All UI logic. Runs a `setTimeout`-based polling loop at 300 ms intervals that sends four sequential CAN requests per tick and updates DOM elements directly by ID. Also manages Drive Current logging (in-memory array → CSV download) and the SetBit modal (read-only bit viewer for the four register values).

## Key Protocol Details

- CAN requests are fire-and-response: write a request packet, wait ~10 ms, then call `ble.readCanFrame(300)` to collect the reply.
- `buildDrvStartCmd()` must be sent first each tick before the data queries; `pushAssist=true` sends `0xA5` in `data[1]`.
- Register bit indicators use two CSS states: default `.on` = red (error), `.drv-ok.on` = green (normal/active). This distinction is set in the HTML, not in JS.
- `drvUpdateFault()` currently sets `_regDRV = _regFault` — both share the same response frame; the DRV 5-bit register is the lower byte of the Fault response.

## BLE UART Profiles

| Profile   | Service UUID      | Write        | Notify       | Config       |
|-----------|-------------------|--------------|--------------|--------------|
| ESP_GATTS | `0x00ff`          | `0xff01`     | `0xff01`     | —            |
| NUS       | `6e400001-...`    | `6e400002-…` | `6e400003-…` | `6e400004-…` |
| HM10      | `0xffe0`          | `0xffe1`     | `0xffe1`     | —            |
| SPP       | `0xabf0`          | `0xabf1`     | `0xabf2`     | —            |

The NUS profile has an optional cfg characteristic used to set baud rate (default 460800).
