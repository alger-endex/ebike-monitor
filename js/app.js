/**
 * app.js — Endex eBike Monitor
 * BLE/CAN 即時監控：Driver Status + SetBit 位元檢視
 */

const APP_VERSION = 'v1.3.2';

// ── State ──────────────────────────────────────────────────────

const ble = new BleManager();

ble.onDisconnect = () => {
  stopDrvMonitor();
  stopMotorVectorMonitor();
  resetRecordingModeUi();
  setDot(false);
  log('BLE 連線中斷');
};

let rxTotalCount      = 0;
let rxLastTime        = 0;
let rxIntervalSamples = [];
let rxMinInterval     = Infinity;
const RX_AVG_SAMPLES  = 10;

let recordingModeActive  = false;
let recVehicleBatchCount = 0;
let recMotorBatchCount   = 0;
let recVehicleLog        = []; // CSV 用，累積直到手動清除或自動儲存輪替
let recMotorLog          = [];
let recAutoSaveTimer     = null;
let recLastSaveAt        = 0;
let recSegmentIndex      = 1;
const REC_AUTO_SAVE_CHECK_MS = 30000; // 每 30 秒檢查一次是否到達自動儲存間隔

// 記錄模式與一般 CAN 輪詢互斥（韌體開啟記錄後停送 0xFA），
// 所以只能在「進入記錄模式那一刻」凍結最後一筆 CAN 值當基準，事後跟記錄批次比對。
let recBaseline = null;
const REC_COMPARE_FIELDS = [
  { id: 'drvBikeSpeed',      label: 'Bike Speed' },
  { id: 'drvDriveCurrent',   label: 'Drive Current' },
  { id: 'drvDriveVoltage',   label: 'Drive Voltage' },
  { id: 'drvDriverTemp',     label: 'Driver Temp' },
  { id: 'drvMotorTemp',      label: 'Motor Temp' },
  { id: 'drvAssistLevel',    label: 'Assist Level' },
  { id: 'drvPedalTorque',    label: 'Pedal Torque' },
  { id: 'drvPedalCadence',   label: 'Pedal Cadence' },
  { id: 'drvPedalPower',     label: 'Pedal Power' },
  { id: 'drvMotorPhaseCurr', label: 'Motor Ph.Curr' },
  { id: 'drvRotorAngle',     label: 'Rotor Angle' },
  { id: 'drvId',             label: 'Id' },
  { id: 'drvIq',             label: 'Iq' },
  { id: 'drvVdCmd',          label: 'Vd Cmd' },
  { id: 'drvVqCmd',          label: 'Vq Cmd' },
];

document.getElementById('btnRxTotalReset').addEventListener('click', () => {
  rxTotalCount      = 0;
  rxLastTime        = 0;
  rxIntervalSamples = [];
  rxMinInterval     = Infinity;
  document.getElementById('rxTotalCount').textContent  = 0;
  document.getElementById('rxInterval').textContent    = '— ms';
  document.getElementById('rxMinInterval').textContent = '— ms';
});

ble.onCanFrame = (id, len, data) => {
  const now = Date.now();
  rxTotalCount++;
  document.getElementById('rxTotalCount').textContent = rxTotalCount;
  if (rxLastTime > 0) {
    const delta = now - rxLastTime;
    rxIntervalSamples.push(delta);
    if (rxIntervalSamples.length > RX_AVG_SAMPLES) rxIntervalSamples.shift();
    const avg = Math.round(rxIntervalSamples.reduce((a, b) => a + b, 0) / rxIntervalSamples.length);
    document.getElementById('rxInterval').textContent = avg + ' ms';
    if (delta > 0 && delta < rxMinInterval) {
      rxMinInterval = delta;
      document.getElementById('rxMinInterval').textContent = rxMinInterval + ' ms';
    }
  }
  rxLastTime = now;
  if      ((id === DRV_RX_FAULT     || id === DRV_RX_FAULT_ALT)    && len >= 6) drvUpdateFault(data);
  else if ((id === DRV_RX_STATUS    || id === DRV_RX_STATUS_ALT)   && len >= 8) drvUpdateStatus(data);
  else if ((id === DRV_RX_ASSIST    || id === DRV_RX_ASSIST_ALT)   && len >= 8) drvUpdateAssist(data);
  else if ((id === DRV_RX_DISTANCE  || id === DRV_RX_DISTANCE_ALT) && len >= 6) drvUpdateDistance(data);
  else if  (id === DRV_RX_MOTOR_VECTOR                             && len >= 8) { mvRxCount++; mvUpdateCounters(); drvUpdateMotorVector(data); }
  else if ((id === DRV_RX_BATTERY1_CAP    || id === DRV_RX_BATTERY_SINGLE_CAP)    && len >= 7) drvUpdateBattery1Cap(data);
  else if ((id === DRV_RX_BATTERY1_STATUS || id === DRV_RX_BATTERY_SINGLE_STATUS) && len >= 8) drvUpdateBattery1Status(data);
  else if  (id === DRV_RX_BATTERY2_CAP                             && len >= 7) drvUpdateBattery2Cap(data);
  else if  (id === DRV_RX_BATTERY2_STATUS                          && len >= 8) drvUpdateBattery2Status(data);
};

ble.onRecordingBatch = (command, length, payload) => {
  if (command === REC_BATCH_VEHICLE) {
    const samples = parseVehicleStatusBatch(payload, length);
    recVehicleBatchCount++;
    recVehicleLog.push(...samples);
    if (samples.length) drvUpdateRecordingVehicle(samples[samples.length - 1]);
    updateRecDebug('Vehicle', command, length, payload, samples[0]);
  } else if (command === REC_BATCH_MOTOR) {
    const samples = parseMotorIdIqBatch(payload, length);
    recMotorBatchCount++;
    recMotorLog.push(...samples);
    if (samples.length) drvUpdateRecordingMotor(samples[samples.length - 1]);
    updateRecDebug('Motor', command, length, payload, samples[0]);
  }
  document.getElementById('recVehicleBatchCount').textContent = '車輛: ' + recVehicleBatchCount;
  document.getElementById('recMotorBatchCount').textContent   = '馬達: ' + recMotorBatchCount;
  renderRecCompareTable();
};

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

// kind: 'Vehicle' | 'Motor' — 對應 recDebug{kind}Raw / recDebug{kind}Parsed 的 DOM id
function updateRecDebug(kind, command, length, payload, firstSample) {
  const rawEl    = document.getElementById('recDebug' + kind + 'Raw');
  const parsedEl = document.getElementById('recDebug' + kind + 'Parsed');
  rawEl.textContent =
    'CMD:0x' + command.toString(16).toUpperCase().padStart(2, '0') + '  LEN:' + length + '\n' +
    bytesToHex(payload);
  parsedEl.textContent = firstSample
    ? Object.entries(firstSample).map(([k, v]) => k + '=' + v).join('  ')
    : '(無有效樣本)';
}

// ── Utilities ──────────────────────────────────────────────────

function log(msg) {
  const el = document.getElementById('statusLog');
  el.value += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── BLE Connection ─────────────────────────────────────────────

document.getElementById('btnBleToggle').addEventListener('click', async () => {
  if (ble.isOpen) {
    stopDrvMonitor();
    stopMotorVectorMonitor();
    await ble.close();
    setDot(false);
    log('BLE 連線已關閉');
    return;
  }
  try {
    await ble.open({ baudRate: 460800 });
    setDot(true);
    const info = ble.deviceInfo;
    log('BLE CAN 連線成功！  ' + (info.name || '') + (info.profile ? '  [' + info.profile + ']' : ''));
  } catch (e) {
    const msg = e.message || String(e);
    log('❌ ' + msg);
    alert(msg);
  }
});

function setDot(connected) {
  const dot     = document.getElementById('statusDot');
  const bleInfo = document.getElementById('bleInfo');
  const btn     = document.getElementById('btnBleToggle');
  dot.classList.toggle('connected',    connected);
  dot.classList.toggle('disconnected', !connected);
  if (connected) {
    const info = ble.deviceInfo;
    bleInfo.textContent = (info.name || 'BLE') + (info.profile ? '  [' + info.profile + ']' : '');
    bleInfo.style.display = '';
    btn.textContent = '關閉連線';
    btn.classList.replace('btn-primary', 'btn-danger');
  } else {
    bleInfo.style.display = 'none';
    btn.textContent = 'BLE 連線';
    btn.classList.replace('btn-danger', 'btn-primary');
  }
}

// ── Driver Status monitoring ───────────────────────────────────

let drvMonitorActive = false;
let drvMonitorTimer  = null;

// last register values — kept for SetBit modal
let _regFault = 0, _regDRV = 0, _regStatus = 0, _regPeriph = 0;
let _bat1FaultReg = 0, _bat1StatusReg = 0;
let _bat2FaultReg = 0, _bat2StatusReg = 0;

document.getElementById('btnDrvMonitor').addEventListener('click', () => {
  if (!ble.isOpen) { alert('請先開啟 BLE 連線'); return; }
  drvMonitorActive ? stopDrvMonitor() : startDrvMonitor();
});

function startDrvMonitor() {
  drvMonitorActive = true;
  const btn = document.getElementById('btnDrvMonitor');
  btn.textContent = '⏹ 停止啟動';
  btn.classList.replace('btn-action', 'btn-danger');
  log('Driver Status 監控已開啟');
  drvMonitorLoop();
}

function stopDrvMonitor() {
  drvMonitorActive = false;
  if (drvMonitorTimer) { clearTimeout(drvMonitorTimer); drvMonitorTimer = null; }
  const btn = document.getElementById('btnDrvMonitor');
  btn.textContent = '▶ 強制啟動';
  btn.classList.replace('btn-danger', 'btn-action');
}

// ── Motor Vector monitoring (independent loop) ─────────────────

let motorVectorMonitorActive = false;
let motorVectorMonitorTimer  = null;
let mvTxCount = 0;
let mvRxCount = 0;

function mvUpdateCounters() {
  document.getElementById('mvTxCount').textContent = 'TX: ' + mvTxCount;
  document.getElementById('mvRxCount').textContent = 'RX: ' + mvRxCount;
}

document.getElementById('mvInterval').addEventListener('input', function () {
  document.getElementById('mvIntervalVal').textContent = this.value + ' ms';
});

document.getElementById('btnMvCountReset').addEventListener('click', () => {
  mvTxCount = 0; mvRxCount = 0; mvUpdateCounters();
});

document.getElementById('btnMotorVectorMonitor').addEventListener('click', () => {
  if (!ble.isOpen) { alert('請先開啟 BLE 連線'); return; }
  motorVectorMonitorActive ? stopMotorVectorMonitor() : startMotorVectorMonitor();
});

function startMotorVectorMonitor() {
  motorVectorMonitorActive = true;
  const btn = document.getElementById('btnMotorVectorMonitor');
  btn.textContent = '⏹ 停止向量';
  btn.classList.replace('btn-action', 'btn-danger');
  log('Motor Vector 監控已開啟，間隔 ' + document.getElementById('mvInterval').value + ' ms');
  motorVectorMonitorLoop();
}

function stopMotorVectorMonitor() {
  motorVectorMonitorActive = false;
  if (motorVectorMonitorTimer) { clearTimeout(motorVectorMonitorTimer); motorVectorMonitorTimer = null; }
  const btn = document.getElementById('btnMotorVectorMonitor');
  if (btn) {
    btn.textContent = '▶ 向量監控';
    btn.classList.replace('btn-danger', 'btn-action');
  }
}

async function motorVectorMonitorLoop() {
  if (!motorVectorMonitorActive) return;
  await motorVectorMonitorTick();
  if (motorVectorMonitorActive) {
    const interval = parseInt(document.getElementById('mvInterval').value, 10);
    motorVectorMonitorTimer = setTimeout(motorVectorMonitorLoop, interval);
  }
}

async function motorVectorMonitorTick() {
  if (!ble.isOpen) { stopMotorVectorMonitor(); return; }
  try {
    await ble.write(buildDrvStartCmd(getStartCmdData()));
    await sleep(5);
    mvTxCount++; mvUpdateCounters();
    await ble.write(buildDrvMotorVectorReq());
  } catch { /* ignore errors during motor vector monitoring */ }
}

// ── Recording Mode（韌體批次高頻資料模式） ─────────────────────

document.getElementById('btnRecordingMode').addEventListener('click', async () => {
  if (!ble.isOpen) { alert('請先開啟 BLE 連線'); return; }
  recordingModeActive ? await stopRecordingMode() : await startRecordingMode();
});

async function startRecordingMode() {
  stopDrvMonitor();
  stopMotorVectorMonitor();
  captureRecBaseline();
  try {
    await ble.write(buildRecordingModeCmd(true));
  } catch (e) { alert('開啟記錄模式失敗：' + (e.message || e)); return; }
  ble.setRecordingMode(true);
  recordingModeActive = true;
  setRecordingButtonsDisabled(true);
  const btn = document.getElementById('btnRecordingMode');
  btn.textContent = '⏹ 停止記錄';
  btn.classList.replace('btn-action', 'btn-danger');
  log('記錄模式已開啟');

  recSegmentIndex = 1;
  recLastSaveAt = Date.now();
  recAutoSaveTimer = setInterval(recAutoSaveTick, REC_AUTO_SAVE_CHECK_MS);
}

async function stopRecordingMode() {
  try { await ble.write(buildRecordingModeCmd(false)); } catch { /* 忽略斷線時的寫入失敗 */ }
  ble.setRecordingMode(false);
  recordingModeActive = false;
  setRecordingButtonsDisabled(false);
  const btn = document.getElementById('btnRecordingMode');
  btn.textContent = '⏺ 開始記錄';
  btn.classList.replace('btn-danger', 'btn-action');
  log('記錄模式已關閉');

  if (recAutoSaveTimer) { clearInterval(recAutoSaveTimer); recAutoSaveTimer = null; }
}

function setRecordingButtonsDisabled(disabled) {
  document.getElementById('btnDrvMonitor').disabled = disabled;
  document.getElementById('btnMotorVectorMonitor').disabled = disabled;
}

// 凍結進入記錄模式那一刻的卡片數值，當作跟記錄批次比對的基準
function captureRecBaseline() {
  const snap = {};
  REC_COMPARE_FIELDS.forEach(f => { snap[f.id] = document.getElementById(f.id).textContent; });
  snap._regFault  = _regFault;
  snap._regStatus = _regStatus;
  recBaseline = snap;
  renderRecCompareTable();
}

function renderRecCompareTable() {
  const tbody = document.getElementById('recCompareBody');
  if (!recBaseline) { tbody.innerHTML = ''; return; }
  const rows = REC_COMPARE_FIELDS.map(f =>
    recCompareRow(f.label, recBaseline[f.id], document.getElementById(f.id).textContent));
  rows.push(recCompareRow('Fault Reg',  '0x' + recBaseline._regFault.toString(16).toUpperCase(),  '0x' + _regFault.toString(16).toUpperCase()));
  rows.push(recCompareRow('Status Reg', '0x' + recBaseline._regStatus.toString(16).toUpperCase(), '0x' + _regStatus.toString(16).toUpperCase()));
  tbody.innerHTML = rows.join('');
}

function recCompareRow(label, baseline, latest) {
  const diff = String(baseline) !== String(latest);
  return '<tr' + (diff ? ' class="rec-compare-diff"' : '') + '>' +
    '<td>' + label + '</td><td>' + baseline + '</td><td>' + latest + '</td></tr>';
}

function resetRecordingModeUi() {
  recordingModeActive = false;
  setRecordingButtonsDisabled(false);
  const btn = document.getElementById('btnRecordingMode');
  btn.textContent = '⏺ 開始記錄';
  btn.classList.replace('btn-danger', 'btn-action');
  if (recAutoSaveTimer) { clearInterval(recAutoSaveTimer); recAutoSaveTimer = null; }
}

// 每 REC_AUTO_SAVE_CHECK_MS 檢查一次，達到使用者設定的間隔就觸發輪替匯出
function recAutoSaveTick() {
  if (!recordingModeActive) return;
  if (!document.getElementById('chkRecAutoSave').checked) return;
  const intervalMin = parseFloat(document.getElementById('recAutoSaveInterval').value) || 15;
  if (Date.now() - recLastSaveAt >= intervalMin * 60000) {
    autoSaveAndRotate();
  }
}

// 匯出目前累積的記錄並清空緩衝，避免長時間錄製時記憶體無限增長
function autoSaveAndRotate() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let saved = false;
  if (recVehicleLog.length) {
    downloadCsv('vehicle_status_seg' + recSegmentIndex + '_' + ts + '.csv', recVehicleLog);
    recVehicleLog = [];
    saved = true;
  }
  if (recMotorLog.length) {
    downloadCsv('motor_idiq_seg' + recSegmentIndex + '_' + ts + '.csv', recMotorLog);
    recMotorLog = [];
    saved = true;
  }
  if (saved) {
    recVehicleBatchCount = 0; recMotorBatchCount = 0;
    document.getElementById('recVehicleBatchCount').textContent = '車輛: 0';
    document.getElementById('recMotorBatchCount').textContent   = '馬達: 0';
    log('自動儲存：已匯出第 ' + recSegmentIndex + ' 段記錄並清空緩衝');
    recSegmentIndex++;
  }
  recLastSaveAt = Date.now();
}

function drvUpdateRecordingVehicle(s) {
  drvSet('drvBikeSpeed',      (s.speed   * 0.1).toFixed(1));
  drvSet('drvDriveCurrent',   (s.current * 0.1).toFixed(1));
  drvSet('drvDriveVoltage',   (s.voltage * 0.1).toFixed(1));
  drvSet('drvDriverTemp',     s.drvTemp  - 40);
  drvSet('drvMotorTemp',      s.motoTemp - 40);
  drvSet('drvAssistLevel',    s.assLevel);
  drvSet('drvPedalTorque',    (s.pedTorq * 0.1).toFixed(1));
  drvSet('drvPedalCadence',   s.pedCade);
  drvSet('drvPedalPower',     s.pedPower);
  drvSet('drvMotorPhaseCurr', s.mpCur);
  _regFault  = s.drvFault; _regDRV = _regFault;
  _regStatus = s.drvStatus;
  drvUpdateBits('drvFault',  _regFault);
  drvUpdateBits('drvDRV',    _regDRV);
  drvUpdateBits('drvStatus', _regStatus);

  _batFault1 = s.batFault1; _batFault2 = s.batFault2;
  _rsoc1 = s.rsoc1; _rsoc2 = s.rsoc2;
  _batStatus1 = s.batStatus1; _batStatus2 = s.batStatus2;
  _batTemp1 = s.batTemp1; _batTemp2 = s.batTemp2;
  _simualRSOC = s.simualRSOC;
  _batteryDataReceived = true;
  if (document.getElementById('modalBattery').style.display === 'flex') renderBatteryModal();
}

function drvUpdateRecordingMotor(s) {
  drvSet('drvRotorAngle', s.angle);
  drvSet('drvId', (s.id * 0.1).toFixed(1));
  drvSet('drvIq', (s.iq * 0.1).toFixed(1));
  drvSet('drvVdCmd', s.vdCmd);
  drvSet('drvVqCmd', s.vqCmd);
}

document.getElementById('btnRecReset').addEventListener('click', () => {
  recVehicleBatchCount = 0; recMotorBatchCount = 0;
  recVehicleLog = []; recMotorLog = [];
  document.getElementById('recVehicleBatchCount').textContent = '車輛: 0';
  document.getElementById('recMotorBatchCount').textContent   = '馬達: 0';
});

function downloadCsv(filename, rows) {
  if (!rows.length) { alert('尚無記錄資料'); return; }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(','), ...rows.map(r => headers.map(h => r[h]).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('btnExportRecVehicleCsv').addEventListener('click', () => {
  downloadCsv('vehicle_status_' + Date.now() + '.csv', recVehicleLog);
});
document.getElementById('btnExportRecMotorCsv').addEventListener('click', () => {
  downloadCsv('motor_idiq_' + Date.now() + '.csv', recMotorLog);
});

// ── Driver Status monitoring loop ──────────────────────────────

const DRV_MONITOR_INTERVAL = 1000;

async function drvMonitorLoop() {
  if (!drvMonitorActive) return;
  const t0 = Date.now();
  await drvMonitorTick();
  if (drvMonitorActive) {
    const remaining = Math.max(0, DRV_MONITOR_INTERVAL - (Date.now() - t0));
    drvMonitorTimer = setTimeout(drvMonitorLoop, remaining);
  }
}

function chkTick(id) { return document.getElementById(id).checked; }

function updateCmdPreview() {
  const d = getStartCmdData();
  document.getElementById('cmdPreview').textContent =
    d.map((v, i) => 'D' + i + ':' + v.toString(16).toUpperCase().padStart(2, '0')).join('  ');
}

// 監聽 cmdbar 所有控制元件 + topbar 的 chkPushAssist
document.querySelector('.cmdbar').addEventListener('input',  updateCmdPreview);
document.querySelector('.cmdbar').addEventListener('change', updateCmdPreview);
document.getElementById('chkPushAssist').addEventListener('change', updateCmdPreview);

function getStartCmdData() {
  // D0 Assist Level — bits[2:0], 0~5
  const d0 = Math.min(5, Math.max(0, parseInt(document.getElementById('cmdAssistLevel').value, 10))) & 0x07;
  // D1 Push Assist — 0x00 / 0xA5
  const d1 = document.getElementById('chkPushAssist').checked ? 0xA5 : 0x00;
  // D2 Light — bit0=前 bit1=後 bit2=左 bit3=右
  const d2 = (document.getElementById('cmdLightFront').checked  ? 0x01 : 0)
           | (document.getElementById('cmdLightRear').checked   ? 0x02 : 0)
           | (document.getElementById('cmdLightLeft').checked   ? 0x04 : 0)
           | (document.getElementById('cmdLightRight').checked  ? 0x08 : 0);
  // D3 Switch — 0x00=Idle / 0x5A=Power On / 0xA5=Power Off
  const d3 = parseInt(document.getElementById('cmdSwitch').value, 10);
  // D4 Operation — Normal/Boost/Eco/Easy/Navi/Locked
  const d4 = parseInt(document.getElementById('cmdOperation').value, 10);
  // D5 Driver Broadcast — 0x00=Disable / 0x01=Enable / 0x02=Mute
  const d5 = parseInt(document.getElementById('cmdBroadcast').value, 10);
  // D6 Battery Lock — 0x5A=Unlocked / 0x00=Locked
  const d6 = parseInt(document.getElementById('cmdBatteryLock').value, 10);
  // D7 Gear — bits[3:0]=Level, bit5=GearUp, bit6=GearDown
  const gearLevel = Math.min(15, Math.max(0, parseInt(document.getElementById('cmdGearLevel').value, 10))) & 0x0F;
  const d7 = gearLevel
    | (document.getElementById('cmdGearUp').checked   ? 0x20 : 0)
    | (document.getElementById('cmdGearDown').checked ? 0x40 : 0);
  return [d0, d1, d2, d3, d4, d5, d6, d7];
}

async function drvMonitorTick() {
  if (!ble.isOpen) { stopDrvMonitor(); return; }
  const pushAssist = document.getElementById('chkPushAssist').checked;
  try {
    if (chkTick('chkTickStart'))    { await ble.write(buildDrvStartCmd(getStartCmdData())); await sleep(5); }
    if (chkTick('chkTickFault'))    { await ble.write(buildDrvFaultReq());           await sleep(5); }
    if (chkTick('chkTickStatus'))   { await ble.write(buildDrvStatusReq());          await sleep(5); }
    if (chkTick('chkTickAssist'))   { await ble.write(buildDrvAssistReq());          await sleep(5); }
    if (chkTick('chkTickDistance')) { await ble.write(buildDrvDistanceReq());        await sleep(5); }
    if (chkTick('chkTickMotorVec')) { mvTxCount++; mvUpdateCounters(); await ble.write(buildDrvMotorVectorReq()); }
  } catch { /* ignore errors during monitoring */ }
}

// ── Data update helpers ────────────────────────────────────────

function drvSet(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

function drvUpdateFault(d) {
  _regFault = (d[0] | (d[1] << 8)) >>> 0;
  _regDRV   = _regFault;
  drvSet('drvDriverTemp', d[4] - 40);
  drvSet('drvMotorTemp',  d[5] - 40);
  drvUpdateBits('drvFault', _regFault);
  drvUpdateBits('drvDRV',   _regDRV);
}

function drvUpdateStatus(d) {
  _regStatus = d[0];
  _regPeriph = d[1];
  drvSet('drvBikeSpeed',    ((d[2] | (d[3] << 8)) * 0.1).toFixed(1));
  drvSet('drvDriveCurrent', ((d[4] | (d[5] << 8)) * 0.1).toFixed(1));
  drvSet('drvDriveVoltage', ((d[6] | (d[7] << 8)) * 0.1).toFixed(1));
  drvUpdateBits('drvStatus',    _regStatus);
  drvUpdateBits('drvPepherial', _regPeriph);
}

function drvUpdateAssist(d) {
  drvSet('drvTotalAssist',    d[0]);
  drvSet('drvAssistLevel',    d[1]);
  drvSet('drvPedalTorque',   ((d[2] | (d[3] << 8)) * 0.1).toFixed(1));
  drvSet('drvPedalCadence',   d[4]);
  drvSet('drvPedalPower',     d[5] | (d[6] << 8));
  drvSet('drvMotorPhaseCurr', d[7]);
}

function drvUpdateDistance(d) {
  drvSet('drvSingleTrip', ((d[0] | (d[1] << 8)) * 0.1).toFixed(1));
  drvSet('drvRemainDist', ((d[2] | (d[3] << 8)) * 0.1).toFixed(1));
}

function drvUpdateMotorVector(d) {
  drvSet('drvRotorAngle', (d[0] | (d[1] << 8)));
  drvSet('drvId',         ((d[2] | (d[3] << 8)) * 0.1).toFixed(1));
  drvSet('drvIq',         ((d[4] | (d[5] << 8)) * 0.1).toFixed(1));
  drvSet('drvVdCmd',      d[6]);
  drvSet('drvVqCmd',      d[7]);
}

function drvUpdateBattery1Cap(d) {
  const fullChargeCap = d[0] | (d[1] << 8);
  const remainCap     = d[2] | (d[3] << 8);
  drvSet('bat1FullChargeCap', fullChargeCap === 0xFFFF ? '—' : (fullChargeCap * 0.01).toFixed(2));
  drvSet('bat1RemainCap',     remainCap     === 0xFFFF ? '—' : (remainCap     * 0.01).toFixed(2));
  drvSet('bat1Rsoc', d[4]);
  drvSet('bat1Asoc', d[5] === 0xFF ? '—' : d[5]);
  drvSet('bat1Soh',  d[6] === 0xFF ? '—' : d[6]);
}

function drvUpdateBattery1Status(d) {
  const voltage    = d[0] | (d[1] << 8);
  const rawCurrent = d[2] | (d[3] << 8);
  const current    = rawCurrent > 0x7FFF ? rawCurrent - 0x10000 : rawCurrent; // S16
  _bat1FaultReg  = d[4] | (d[5] << 8);
  _bat1StatusReg = d[6];
  drvSet('bat1Voltage', (voltage * 0.01).toFixed(2));
  drvSet('bat1Current', (current * 0.01).toFixed(2));
  drvSet('bat1Temp',    d[7] - 40);
  drvUpdateBits('bat1FaultReg',  _bat1FaultReg);
  drvUpdateBits('bat1StatusReg', _bat1StatusReg);
}

function drvUpdateBattery2Cap(d) {
  const fullChargeCap = d[0] | (d[1] << 8);
  const remainCap     = d[2] | (d[3] << 8);
  drvSet('bat2FullChargeCap', fullChargeCap === 0xFFFF ? '—' : (fullChargeCap * 0.01).toFixed(2));
  drvSet('bat2RemainCap',     remainCap     === 0xFFFF ? '—' : (remainCap     * 0.01).toFixed(2));
  drvSet('bat2Rsoc', d[4]);
  drvSet('bat2Asoc', d[5] === 0xFF ? '—' : d[5]);
  drvSet('bat2Soh',  d[6] === 0xFF ? '—' : d[6]);
}

function drvUpdateBattery2Status(d) {
  const voltage    = d[0] | (d[1] << 8);
  const rawCurrent = d[2] | (d[3] << 8);
  const current    = rawCurrent > 0x7FFF ? rawCurrent - 0x10000 : rawCurrent; // S16
  _bat2FaultReg  = d[4] | (d[5] << 8);
  _bat2StatusReg = d[6];
  drvSet('bat2Voltage', (voltage * 0.01).toFixed(2));
  drvSet('bat2Current', (current * 0.01).toFixed(2));
  drvSet('bat2Temp',    d[7] - 40);
  drvUpdateBits('bat2FaultReg',  _bat2FaultReg);
  drvUpdateBits('bat2StatusReg', _bat2StatusReg);
}

function drvUpdateBits(containerId, regVal) {
  document.querySelectorAll('#' + containerId + ' .drv-bit-ind')
    .forEach((ind, i) => ind.classList.toggle('on', ((regVal >> i) & 1) === 1));
}

// ── SetBit modal (register bit viewer) ────────────────────────

const REG_DEFS = {
  Fault: {
    title: 'Fault Register (12-bit)',
    labels: [
      'bit0  Over Current Protection',  'bit1  Over Voltage Protection',
      'bit2  Under Voltage Protection', 'bit3  Opamp Error',
      'bit4  Hall Connection Error',    'bit5  Phase Line Error',
      'bit6  E-Lock Error',             'bit7  Cadence Sensor Error',
      'bit8  Torque Sensor Error',      'bit9  Throttle Error',
      'bit10 Hall Transition Error',    'bit11 Communication Error',
    ],
    getValue: () => _regFault,
  },
  DRV: {
    title: 'DRV Register (5-bit)',
    labels: [
      'bit0  Drive Over Temperature', 'bit1  Motor Over Temperature',
      'bit2  Motor Stuck Error',      'bit3  Hub Lock Error',
      'bit4  Wheel Sensor Error',
    ],
    getValue: () => _regDRV,
  },
  Status: {
    title: 'Drv Status Register (8-bit)',
    labels: [
      'bit0  Drive Initial (0=init 1=Ready)', 'bit1  Motor (0=Stop 1=Running)',
      'bit2  E-Lock (0=Unlock 1=Lock)',       'bit3  Push Assist (0=Off 1=On)',
      'bit4  Lock (0=Unlock 1=Lock)',          'bit5  Battery Lock (0=Unlock 1=Lock)',
      'bit6  Boost (0=Off 1=On)',              'bit7  Driver Reduction (0=Normal 1=Reduction)',
    ],
    getValue: () => _regStatus,
  },
  Pepherial: {
    title: 'Drv Peripheral Register (8-bit)',
    labels: [
      'bit0  Head Light (0=Off 1=On)',  'bit1  Rear Light (0=Off 1=On)',
      'bit2  DR Light (0=Off 1=On)',    'bit3  Break Light (0=Off 1=On)',
      'bit4  —',                         'bit5  Brake (0=Off 1=On)',
      'bit6  —',                         'bit7  Kick Stand (0=Up 1=Down)',
    ],
    getValue: () => _regPeriph,
  },
  Bat1Fault: {
    title: 'Battery1 Fault Register (13-bit)',
    labels: [
      'bit0  DSGFETE Discharge FET Error',           'bit1  CHGFET Charge FET Error',
      'bit2  TDW Temperature Discharging Warning',   'bit3  TDE Temperature Discharging Error',
      'bit4  TCE Temperature Charging Error',        'bit5  COV Cell Over Voltage',
      'bit6  CUV Cell Under Voltage',                'bit7  OCC Over Current Charge',
      'bit8  OCD-1 1st Stage Overcurrent Discharge', 'bit9  OCD-2 2nd Stage Overcurrent Discharge',
      'bit10 SCC Short Circuit',                     'bit11 FD Fully Discharge',
      'bit12 NRD Nearly Discharged',
    ],
    getValue: () => _bat1FaultReg,
  },
  Bat1Status: {
    title: 'Battery1 Status Register (8-bit)',
    labels: [
      'bit0  Initialize Complete', 'bit1  Active Mode',
      'bit2  Discharge Mos On',    'bit3  Charger Detected',
      'bit4  Charging',            'bit5  Reserved',
      'bit6  Reserved',            'bit7  Shutdown Initiating',
    ],
    getValue: () => _bat1StatusReg,
  },
  Bat2Fault: {
    title: 'Battery2 Fault Register (13-bit)',
    labels: [
      'bit0  DSGFETE Discharge FET Error',           'bit1  CHGFET Charge FET Error',
      'bit2  TDW Temperature Discharging Warning',   'bit3  TDE Temperature Discharging Error',
      'bit4  TCE Temperature Charging Error',        'bit5  COV Cell Over Voltage',
      'bit6  CUV Cell Under Voltage',                'bit7  OCC Over Current Charge',
      'bit8  OCD-1 1st Stage Overcurrent Discharge', 'bit9  OCD-2 2nd Stage Overcurrent Discharge',
      'bit10 SCC Short Circuit',                     'bit11 FD Fully Discharge',
      'bit12 NRD Nearly Discharged',
    ],
    getValue: () => _bat2FaultReg,
  },
  Bat2Status: {
    title: 'Battery2 Status Register (8-bit)',
    labels: [
      'bit0  Initialize Complete', 'bit1  Active Mode',
      'bit2  Discharge Mos On',    'bit3  Charger Detected',
      'bit4  Charging',            'bit5  Reserved',
      'bit6  Reserved',            'bit7  Shutdown Initiating',
    ],
    getValue: () => _bat2StatusReg,
  },
};

['Fault', 'DRV', 'Status', 'Pepherial', 'Bat1Fault', 'Bat1Status', 'Bat2Fault', 'Bat2Status'].forEach(key => {
  document.getElementById('title' + key).addEventListener('click', () => openSetbitModal(key));
});

function openSetbitModal(regKey) {
  const def     = REG_DEFS[regKey];
  const regVal  = def.getValue();
  const modal   = document.getElementById('modalSetBit');
  const grid    = document.getElementById('setbitGrid');
  const preview = document.getElementById('setbitPreview');

  document.getElementById('setbitTitle').textContent = def.title;
  grid.innerHTML = '';

  for (let bit = def.labels.length - 1; bit >= 0; bit--) {
    const row = document.createElement('div');
    row.className = 'setbit-row';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = ((regVal >> bit) & 1) === 1;
    cb.disabled = true;

    const lbl = document.createElement('label');
    lbl.textContent = def.labels[bit];

    row.appendChild(cb);
    row.appendChild(lbl);
    grid.appendChild(row);
  }

  preview.textContent =
    'HEX: 0x' + regVal.toString(16).toUpperCase().padStart(4, '0') +
    '   DEC: ' + regVal;
  modal.style.display = 'flex';
}

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.close).style.display = 'none';
  });
});

// ── Battery Info modal（電池1/電池2皆為 CAN 輪詢即時 + 記錄模式雙來源） ──

let _batFault1 = 0, _batFault2 = 0;
let _rsoc1 = 0, _rsoc2 = 0;
let _batStatus1 = 0, _batStatus2 = 0;
let _batTemp1 = 0, _batTemp2 = 0;
let _simualRSOC = 0;
let _batteryDataReceived = false; // 記錄模式批次是否至少收到過一次

document.getElementById('btnBatteryInfo').addEventListener('click', () => {
  document.getElementById('modalBattery').style.display = 'flex';
  renderBatteryModal();
});

function renderBatteryModal() {
  document.getElementById('batSimualRSOC').textContent = _batteryDataReceived ? _simualRSOC : '—';
  drvSet('batRsoc1', _batteryDataReceived ? _rsoc1 : '—');
  drvSet('batRsoc2', _batteryDataReceived ? _rsoc2 : '—');
  drvSet('batTemp1', _batteryDataReceived ? _batTemp1 : '—');
  drvSet('batTemp2', _batteryDataReceived ? _batTemp2 : '—');
  drvSet('batStatus1', '0x' + _batStatus1.toString(16).toUpperCase().padStart(2, '0'));
  drvSet('batStatus2', '0x' + _batStatus2.toString(16).toUpperCase().padStart(2, '0'));
  renderBatteryFaultBits('batFaultBits1', _batFault1);
  renderBatteryFaultBits('batFaultBits2', _batFault2);
}

// 記錄模式的 batFault1/batFault2 跟 CAN 輪詢的 Battery Fault Register 是同一顆
// 電池的同一個暫存器，只是走不同傳輸路徑，bit 定義沿用 CAN 版的表格
const BATTERY_FAULT_BIT_LABELS = [
  'DSGFETE Discharge FET Error',           'CHGFET Charge FET Error',
  'TDW Temperature Discharging Warning',   'TDE Temperature Discharging Error',
  'TCE Temperature Charging Error',        'COV Cell Over Voltage',
  'CUV Cell Under Voltage',                'OCC Over Current Charge',
  'OCD-1 1st Stage Overcurrent Discharge', 'OCD-2 2nd Stage Overcurrent Discharge',
  'SCC Short Circuit',                     'FD Fully Discharge',
  'NRD Nearly Discharged',
];

function renderBatteryFaultBits(containerId, regVal) {
  const grid = document.getElementById(containerId);
  grid.innerHTML = '';
  for (let bit = 15; bit >= 0; bit--) {
    const row = document.createElement('div');
    row.className = 'setbit-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = ((regVal >> bit) & 1) === 1;
    cb.disabled = true;
    const lbl = document.createElement('label');
    lbl.textContent = 'bit' + bit + '  ' + (BATTERY_FAULT_BIT_LABELS[bit] || '(Reserved)');
    row.appendChild(cb);
    row.appendChild(lbl);
    grid.appendChild(row);
  }
}

// ── Params panel toggle (StartCmd + Tick bar) ──────────────────

document.getElementById('btnToggleParams').addEventListener('click', () => {
  const panel  = document.getElementById('paramsPanel');
  const btn    = document.getElementById('btnToggleParams');
  const hidden = panel.style.display === 'none';
  panel.style.display = hidden ? '' : 'none';
  btn.textContent = hidden ? '▾ 功能鍵' : '▸ 功能鍵';
});

// ── Init ───────────────────────────────────────────────────────

document.getElementById('appVersion').textContent = APP_VERSION;
updateCmdPreview();
