/**
 * protocol.js — CAN / Tool_R packet builders & parsers
 *
 * CAN wrapper (Tool_R): 0xFA 0x0D + ID(4B LE) + Len(1B) + Data(8B) = 15 bytes
 */

function buildToolRPacket(canId, dataBytes) {
  const p = new Uint8Array(15);
  p[0] = 0xFA; p[1] = 0x0D;
  p[2] =  canId        & 0xFF;
  p[3] = (canId >>  8) & 0xFF;
  p[4] = (canId >> 16) & 0xFF;
  p[5] = (canId >> 24) & 0xFF;
  p[6] = dataBytes.length;
  for (let i = 0; i < dataBytes.length && i < 8; i++) p[7 + i] = dataBytes[i];
  return p;
}

/** Parse 13 bytes that follow 0xFA 0x0D. Returns { id, len, data } or null. */
function parseCanResponse(bytes) {
  if (!bytes || bytes.length < 13) return null;
  const id  = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  const len = bytes[4];
  const data = bytes.slice(5, 5 + Math.min(len, 8));
  return { id, len, data };
}

// ── Driver Status CAN builders ────────────────────────────────

// Start command — data[1]: 0x00=normal, 0xA5=push assist
function buildDrvStartCmd(pushAssist) {
  return buildToolRPacket(0x141030FF, [0x01, pushAssist ? 0xA5 : 0x00, 0x00, 0x5A, 0, 0, 0, 0]);
}

// Fault Register request  → RX ID 0x10235030  6 bytes
function buildDrvFaultReq()    { return buildToolRPacket(0x12233050, [0x06, 0, 0, 0, 0, 0, 0, 0]); }

// Status + Speed/Current/Voltage → RX ID 0x10205030  8 bytes
function buildDrvStatusReq()   { return buildToolRPacket(0x12203050, [0x08, 0, 0, 0, 0, 0, 0, 0]); }

// Assist / Pedal data → RX ID 0x10215030  8 bytes
function buildDrvAssistReq()   { return buildToolRPacket(0x12213050, [0x08, 0, 0, 0, 0, 0, 0, 0]); }

// Trip / Distance data → RX ID 0x10225030  6 bytes
function buildDrvDistanceReq() { return buildToolRPacket(0x12223050, [0x06, 0, 0, 0, 0, 0, 0, 0]); }

const DRV_RX_FAULT    = 0x10235030;
const DRV_RX_STATUS   = 0x10205030;
const DRV_RX_ASSIST   = 0x10215030;
const DRV_RX_DISTANCE = 0x10225030;
