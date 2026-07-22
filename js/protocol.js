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

// Start command — data8: [D0 AssistLevel, D1 PushAssist, D2 Light, D3 Switch,
//                          D4 Operation,  D5 Broadcast,  D6 BatLock, D7 Gear]
function buildDrvStartCmd(data8) {
  return buildToolRPacket(0x141030FF, data8);
}

// Fault Register request  → RX ID 0x10235030  6 bytes
function buildDrvFaultReq()    { return buildToolRPacket(0x12233050, [0x06]); }

// Status + Speed/Current/Voltage → RX ID 0x10205030  8 bytes
function buildDrvStatusReq()   { return buildToolRPacket(0x12203050, [0x08]); }

// Assist / Pedal data → RX ID 0x10215030  8 bytes
function buildDrvAssistReq()   { return buildToolRPacket(0x12213050, [0x08]); }

// Trip / Distance data → RX ID 0x10225030  6 bytes
function buildDrvDistanceReq() { return buildToolRPacket(0x12223050, [0x06]); }

// Motor vector data → RX ID 0x10255030  8 bytes
// Rotor Angle(d[0..1]) / Id(d[2..3]) / Iq(d[4..5]) / Vd_cmd(d[6]) / Vq_cmd(d[7])
function buildDrvMotorVectorReq() { return buildToolRPacket(0x12253050, [0x08]); }

const DRV_RX_FAULT        = 0x10235030;
const DRV_RX_FAULT_ALT    = 0x142350FF;
const DRV_RX_STATUS       = 0x10205030;
const DRV_RX_STATUS_ALT   = 0x142050FF;
const DRV_RX_ASSIST       = 0x10215030;
const DRV_RX_ASSIST_ALT   = 0x142150FF;
const DRV_RX_DISTANCE     = 0x10225030;
const DRV_RX_DISTANCE_ALT = 0x142250FF;
const DRV_RX_MOTOR_VECTOR = 0x10255030;
