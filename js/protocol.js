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

// ── Battery Info（裝置主動週期廣播，不需送請求） ─────────────────
const DRV_RX_BATTERY1_CAP    = 0x146011FF; // FullChargeCap/RemainCap/RSOC/ASOC/SOH，7 bytes
const DRV_RX_BATTERY1_STATUS = 0x146111FF; // Voltage/Current/FaultReg/StatusReg/Temp，8 bytes
const DRV_RX_BATTERY2_CAP    = 0x146012FF; // FullChargeCap/RemainCap/RSOC/ASOC/SOH，7 bytes
const DRV_RX_BATTERY2_STATUS = 0x146112FF; // Voltage/Current/FaultReg/StatusReg/Temp，8 bytes
// 單電池車型只裝一顆電池時，改用這組 ID 廣播（跟電池1同格式，車上沒有電池2）
const DRV_RX_BATTERY_SINGLE_CAP    = 0x146010FF;
const DRV_RX_BATTERY_SINGLE_STATUS = 0x146110FF;

// ── Recording Mode ────────────────────────────────────────────
// 開啟後裝置停止逐筆 0xFA CAN frame notify，改送批次封包：
// command[1] + length[1] + payload[length]。兩種批次型別長度不同
// （車輛 212 bytes 總長 / 馬達 242 bytes 總長），依 length byte 動態切幀。
// 見 recording_mode_protocol.md。

// Recording mode control（手機 → 裝置，write 方向）
const REC_CMD_BYTE = 0xFD;

// Recording batch tags（裝置 → 手機，notify 方向）
// 注意：REC_BATCH_VEHICLE 跟 REC_CMD_BYTE 數值相同(0xFD)但意義相反，方向不同，勿混淆
const REC_BATCH_VEHICLE = 0xFD; // 車輛狀態批次，6 筆 x 35 bytes
const REC_BATCH_MOTOR   = 0xFE; // 馬達 Id/Iq 批次，24 筆 x 10 bytes

function buildRecordingModeCmd(enable) {
  const p = new Uint8Array(15);
  p[0] = REC_CMD_BYTE;
  p[1] = 0x01;
  p[2] = enable ? 0x01 : 0x00;
  return p;
}

// payload: Uint8Array(length)，length: 有效 byte 數（恆 210，6 筆 x 35 bytes）
function parseVehicleStatusBatch(payload, length) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const samples = [];
  for (let off = 0; off + 35 <= length; off += 35) {
    samples.push({
      timeMs:     view.getUint16(off + 0,  true),
      speed:      view.getUint16(off + 2,  true),
      current:    view.getUint16(off + 4,  true),
      voltage:    view.getUint16(off + 6,  true),
      drvFault:   view.getUint16(off + 8,  true),
      drvWarn:    view.getUint16(off + 10, true),
      pedTorq:    view.getUint16(off + 12, true),
      pedPower:   view.getUint16(off + 14, true),
      batFault1:  view.getUint16(off + 16, true),
      batFault2:  view.getUint16(off + 18, true),
      simualRSOC: view.getUint16(off + 20, true),
      drvStatus:  view.getUint8(off + 22),
      drvPep:     view.getUint8(off + 23),
      drvTemp:    view.getUint8(off + 24),
      motoTemp:   view.getUint8(off + 25),
      assLevel:   view.getUint8(off + 26),
      pedCade:    view.getUint8(off + 27),
      rsoc1:      view.getUint8(off + 28),
      rsoc2:      view.getUint8(off + 29),
      batStatus1: view.getUint8(off + 30),
      batStatus2: view.getUint8(off + 31),
      batTemp1:   view.getUint8(off + 32),
      batTemp2:   view.getUint8(off + 33),
      mpCur:      view.getUint8(off + 34),
    });
  }
  return samples;
}

// payload: Uint8Array(length)，length: 恆 240，24 筆 x 10 bytes
function parseMotorIdIqBatch(payload, length) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const samples = [];
  for (let off = 0; off + 10 <= length; off += 10) {
    samples.push({
      count: view.getUint16(off + 0, true),
      angle: view.getUint16(off + 2, true),
      id:    view.getUint16(off + 4, true),
      iq:    view.getUint16(off + 6, true),
      vdCmd: view.getUint8(off + 8),
      vqCmd: view.getUint8(off + 9),
    });
  }
  return samples;
}
