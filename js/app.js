/**
 * app.js — Endex eBike Monitor
 * BLE/CAN 即時監控：Driver Status + SetBit 位元檢視
 */

const APP_VERSION = 'v1.0.0';

// ── State ──────────────────────────────────────────────────────

const ble = new BleManager();

ble.onDisconnect = () => {
  stopDrvMonitor();
  setDot(false);
  log('BLE 連線中斷');
};

// ── Utilities ──────────────────────────────────────────────────

function log(msg) {
  const el = document.getElementById('statusLog');
  el.value += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── BLE Connection ─────────────────────────────────────────────

document.getElementById('btnOpen').addEventListener('click', async () => {
  if (ble.isOpen) { log('BLE 已連線'); return; }
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

document.getElementById('btnClose').addEventListener('click', async () => {
  stopDrvMonitor();
  await ble.close();
  setDot(false);
  log('BLE 連線已關閉');
});

function setDot(connected) {
  const dot     = document.getElementById('statusDot');
  const bleInfo = document.getElementById('bleInfo');
  dot.classList.toggle('connected',    connected);
  dot.classList.toggle('disconnected', !connected);
  if (connected) {
    const info = ble.deviceInfo;
    bleInfo.textContent = (info.name || 'BLE') + (info.profile ? '  [' + info.profile + ']' : '');
    bleInfo.style.display = '';
  } else {
    bleInfo.style.display = 'none';
  }
}

// ── Driver Status monitoring ───────────────────────────────────

let drvMonitorActive = false;
let drvMonitorTimer  = null;
const drvCurrentLog  = [];

// last register values — kept for SetBit modal
let _regFault = 0, _regDRV = 0, _regStatus = 0, _regPeriph = 0;

document.getElementById('btnDrvMonitor').addEventListener('click', () => {
  if (!ble.isOpen) { alert('請先開啟 BLE 連線'); return; }
  drvMonitorActive ? stopDrvMonitor() : startDrvMonitor();
});

function startDrvMonitor() {
  drvMonitorActive = true;
  const btn = document.getElementById('btnDrvMonitor');
  btn.textContent = '⏹ 停止監控';
  btn.classList.replace('btn-action', 'btn-danger');
  drvCurrentLog.length = 0;
  drvUpdateLogCount();
  log('Driver Status 監控已開啟');
  drvMonitorLoop();
}

function stopDrvMonitor() {
  drvMonitorActive = false;
  if (drvMonitorTimer) { clearTimeout(drvMonitorTimer); drvMonitorTimer = null; }
  const btn = document.getElementById('btnDrvMonitor');
  btn.textContent = '▶ 開始監控';
  btn.classList.replace('btn-danger', 'btn-action');
  if (drvCurrentLog.length > 1) log('電流 Log: ' + drvCurrentLog.length + ' 筆');
}

async function drvMonitorLoop() {
  if (!drvMonitorActive) return;
  await drvMonitorTick();
  if (drvMonitorActive) drvMonitorTimer = setTimeout(drvMonitorLoop, 300);
}

async function drvMonitorTick() {
  if (!ble.isOpen) { stopDrvMonitor(); return; }
  const pushAssist = document.getElementById('chkPushAssist').checked;
  try {
    // 1. Start command
    await ble.write(buildDrvStartCmd(pushAssist));
    await sleep(5);

    // 2. Fault Register
    ble.clearBuffer();
    await ble.write(buildDrvFaultReq());
    await sleep(10);
    const faultFrame = await ble.readCanFrame(300);
    if (faultFrame) {
      const r = parseCanResponse(faultFrame);
      if (r && r.id === DRV_RX_FAULT && r.len >= 6) drvUpdateFault(r.data);
    }

    // 3. Status + Speed / Current / Voltage
    ble.clearBuffer();
    await ble.write(buildDrvStatusReq());
    await sleep(10);
    const statusFrame = await ble.readCanFrame(300);
    if (statusFrame) {
      const r = parseCanResponse(statusFrame);
      if (r && r.id === DRV_RX_STATUS && r.len >= 8) drvUpdateStatus(r.data);
    }

    // 4. Assist / Pedal
    ble.clearBuffer();
    await ble.write(buildDrvAssistReq());
    await sleep(10);
    const assistFrame = await ble.readCanFrame(300);
    if (assistFrame) {
      const r = parseCanResponse(assistFrame);
      if (r && r.id === DRV_RX_ASSIST && r.len >= 8) drvUpdateAssist(r.data);
    }

    // 5. Trip / Distance
    ble.clearBuffer();
    await ble.write(buildDrvDistanceReq());
    await sleep(10);
    const distFrame = await ble.readCanFrame(300);
    if (distFrame) {
      const r = parseCanResponse(distFrame);
      if (r && r.id === DRV_RX_DISTANCE && r.len >= 6) drvUpdateDistance(r.data);
    }
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
  if (document.getElementById('chkDrvLog').checked) {
    drvCurrentLog.push({ ts: Date.now(), val: parseFloat(((d[4] | (d[5] << 8)) * 0.1).toFixed(1)) });
    drvUpdateLogCount();
  }
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

function drvUpdateBits(containerId, regVal) {
  document.querySelectorAll('#' + containerId + ' .drv-bit-ind')
    .forEach((ind, i) => ind.classList.toggle('on', ((regVal >> i) & 1) === 1));
}

function drvUpdateLogCount() {
  const n = drvCurrentLog.length;
  const countEl   = document.getElementById('drvLogCount');
  const exportBtn = document.getElementById('btnDrvLogExport');
  if (countEl)   countEl.textContent = n + ' 筆';
  if (exportBtn) exportBtn.disabled  = n === 0;
}

document.getElementById('btnDrvLogExport').addEventListener('click', () => {
  if (!drvCurrentLog.length) return;
  const t0 = drvCurrentLog[0].ts;
  let csv = '時間(ms),相對時間(s),Drive Current(A)\r\n';
  for (const row of drvCurrentLog) {
    csv += row.ts + ',' + ((row.ts - t0) / 1000).toFixed(3) + ',' + row.val + '\r\n';
  }
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  downloadText(csv, 'drive_current_' + ts + '.csv');
  log('電流 Log 已下載，共 ' + drvCurrentLog.length + ' 筆');
});

function downloadText(text, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
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

// ── Init ───────────────────────────────────────────────────────

document.getElementById('appVersion').textContent = APP_VERSION;
