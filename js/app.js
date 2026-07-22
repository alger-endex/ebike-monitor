/**
 * app.js — Endex eBike Monitor
 * BLE/CAN 即時監控：Driver Status + SetBit 位元檢視
 */

const APP_VERSION = 'v1.2.0';

// ── State ──────────────────────────────────────────────────────

const ble = new BleManager();

ble.onDisconnect = () => {
  stopDrvMonitor();
  stopMotorVectorMonitor();
  setDot(false);
  log('BLE 連線中斷');
};

let rxTotalCount      = 0;
let rxLastTime        = 0;
let rxIntervalSamples = [];
let rxMinInterval     = Infinity;
const RX_AVG_SAMPLES  = 10;

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
};

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
};

['Fault', 'DRV', 'Status', 'Pepherial'].forEach(key => {
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

document.querySelectorAll('[data-close="modalSetBit"]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('modalSetBit').style.display = 'none';
  });
});

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
