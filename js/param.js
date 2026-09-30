/**
 * param.js — 參數讀寫頁（#pageParam）：單筆 FC 0x03/0x06、裝置 SIG、.txt 批次讀寫
 *
 * 依賴 app.js 的 ble / sleep / recordingModeActive，必須在 app.js 之後載入。
 * 回應由 app.js 的 ble.onCanFrame 收到 CAN_CMD_RX 後轉給 paramOnCanFrame()。
 *
 * 同一時間只會有一筆請求在等回應（paramBusy 鎖住所有按鈕），回應以
 * FC + 位址比對；不符的（例如前一筆逾時後才到的殘留回應）略過再等。
 */

const PARAM_FIRST_MS      = 300;  // 送出後這段時間內完全沒收到任何 frame → 本次逾時
const PARAM_MAX_WAIT_MS   = 1000; // 有收到不符的 frame 就繼續等，但從送出起算最多等這麼久
const PARAM_MAX_SKIP      = 20;   // 不符的 frame（FC/位址不符或 CAN ID 不符）累積上限
const PARAM_RETRY         = 3;    // 只有逾時才重試；錯誤回應(0x83/0x86)是確定結果，不重試
const PARAM_RETRY_GAP_MS  = 15;
const PARAM_STEP_GAP_MS   = 100;  // 批次每筆之間的間隔
const PARAM_SIG_ADDRS     = [0x0000, 0x0001, 0x0002, 0x0003];
const PARAM_WRITE_PROTECT = 0x0020; // 批次寫入時 ≤ 此位址（SIG／表頭區）一律略過
const PARAM_LOG_MAX_LINES = 300;

let paramPending = null;  // (resp) => void，目前等待中的請求
let paramBusy    = false;
let paramBatch   = [];    // { addr, data, readVal, result, status }
let paramStopReq = false; // 批次中途停止：由「停止」按鈕設定，迴圈每筆檢查
let paramAbortCurrent = null; // 目前等待中的請求的中斷函式（停止時立刻結束等待，不必等逾時）

function hex4(v) { return v.toString(16).toUpperCase().padStart(4, '0'); }
function hex2(v) { return v.toString(16).toUpperCase().padStart(2, '0'); }

function paramFcName(fc) {
  return { 0x03: '讀取', 0x06: '寫入', 0x83: '讀取 ERROR', 0x86: '寫入 ERROR' }[fc] || '0x' + hex2(fc);
}

// ── Log ────────────────────────────────────────────────────────

function paramLog(msg) {
  const el = document.getElementById('paramLog');
  const d  = new Date();
  const ts = d.toLocaleTimeString('zh-TW', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  const lines = (ts + ' ' + msg + '\n' + el.textContent).split('\n');
  el.textContent = lines.slice(0, PARAM_LOG_MAX_LINES).join('\n');
}

document.getElementById('btnParamLogClear').addEventListener('click', () => {
  document.getElementById('paramLog').textContent = '';
});

// ── RX（由 app.js ble.onCanFrame 呼叫） ────────────────────────

function paramOnCanFrame(d) {
  const r = parseParamResp(d);
  if (r.isErr) paramLog('[RX] ⚠ ' + paramFcName(r.fc) + ' ErrCode:0x' + hex2(r.errCode));
  else         paramLog('[RX] ' + paramFcName(r.fc) + ' Addr:0x' + hex4(r.addr) + ' Val:0x' + hex4(r.val) + ' (' + r.val + ')');
  if (paramPending) paramPending(r);
}

// 參數請求等待回應期間，收到任何分派鏈都不認得的 frame（CAN ID 不是 CAN_CMD_RX，
// 或是 CAN_CMD_RX 但長度不足）時記錄下來。這些 frame 不參與比對；不記錄的話，
// 控制器改用別的 ID 回覆時畫面上只會看到 TIMEOUT，無法分辨「沒回應」還是「ID 不對」。
// 已知的監控／電池 ID 由 app.js 前面的分支處理掉，不會進來，所以不會洗版。
function paramOnUnhandledFrame(id, len, data) {
  if (!paramPending) return;
  const idHex = '0x' + id.toString(16).toUpperCase().padStart(8, '0');
  const why = id === CAN_CMD_RX
    ? 'CAN_CMD_RX 長度不足（需 ≥ 6）'
    : 'CAN ID 不符 ' + idHex + ' ≠ CAN_CMD_RX 0x' + CAN_CMD_RX.toString(16).toUpperCase().padStart(8, '0');
  paramLog('[RX ID?] ' + why + '  len=' + len + ' DATA:' + bytesToHex(data));
  paramPending({ wrongId: true }); // 計入略過次數
}

// ── Request / response ─────────────────────────────────────────

/** 回傳 { isErr:false, addr, val } / { isErr:true, errCode } / { sendErr } / null（逾時） */
function paramRequestOnce(fc, addr, value) {
  return new Promise(async (resolve) => {
    let timer = null, skipped = 0, done = false;
    const startAt = performance.now();
    const finish = (v) => {
      if (done) return;
      done = true; clearTimeout(timer); paramPending = null; paramAbortCurrent = null; resolve(v);
    };
    paramAbortCurrent = () => finish(null);
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => finish(null), Math.max(0, ms)); };
    // 收到過不符的 frame 代表通道有在動，延長到從送出起算的最長等待時間
    const armMaxWait = () => arm(startAt + PARAM_MAX_WAIT_MS - performance.now());

    // 先掛監聽再送出，避免回應在 write 完成前就到而被漏掉
    paramPending = (r) => {
      if (!r.wrongId) {
        if (r.fc === (fc | 0x80))            { finish(r); return; }
        if (r.fc === fc && r.addr === addr)  { finish(r); return; }
        paramLog('[RX SKIP] ' + paramFcName(r.fc) + (r.isErr ? '' : ' Addr:0x' + hex4(r.addr)) +
                 ' ≠ 請求 ' + paramFcName(fc) + ' 0x' + hex4(addr));
      }
      if (++skipped >= PARAM_MAX_SKIP) {
        paramLog('[SKIP 上限] 已略過 ' + skipped + ' 筆不符的 frame，放棄本次 ' + paramFcName(fc) + ' 0x' + hex4(addr));
        finish(null);
        return;
      }
      armMaxWait();
    };

    try {
      await ble.write(buildParamCmd(fc, addr, value));
      paramLog('[TX] ' + paramFcName(fc) + ' Addr:0x' + hex4(addr) + (fc === PARAM_FC_WRITE ? ' Data:0x' + hex4(value) : ''));
    } catch (e) {
      finish({ sendErr: e.message || String(e) });
      return;
    }
    // write 期間若已收到不符的 frame，維持最長等待期限，不要縮回 300 ms
    if (!done) { if (skipped > 0) armMaxWait(); else arm(PARAM_FIRST_MS); }
  });
}

async function paramRequest(fc, addr, value = 0) {
  for (let i = 0; i < PARAM_RETRY; i++) {
    if (paramStopReq) return null;
    const r = await paramRequestOnce(fc, addr, value);
    if (r) return r;
    if (paramStopReq) return null; // 被停止中斷的不算逾時，也不重試
    paramLog('[TIMEOUT] ' + paramFcName(fc) + ' 0x' + hex4(addr) + (i + 1 < PARAM_RETRY ? '，重試' : ''));
    await sleep(PARAM_RETRY_GAP_MS);
  }
  return null;
}

function paramResultText(r) {
  if (!r)         return 'TIMEOUT';
  if (r.sendErr)  return 'ERR（' + r.sendErr + '）';
  if (r.isErr)    return 'ERR(0x' + hex2(r.errCode) + ')';
  return '0x' + hex4(r.val) + ' (' + r.val + ')';
}

// ── Busy / guard ───────────────────────────────────────────────

const PARAM_ACTION_BTNS = ['btnParamSend', 'btnParamReadSig', 'btnParamLoad',
                           'btnParamBatchRead', 'btnParamBatchWrite', 'btnParamBatchSave'];

function paramSetBusy(busy) {
  paramBusy = busy;
  PARAM_ACTION_BTNS.forEach(id => { document.getElementById(id).disabled = busy; });
  if (!busy) {
    document.getElementById('btnParamBatchStop').disabled = true;
    paramStopReq = false; // 不能殘留到之後的單筆讀寫，否則 paramRequest 會直接返回
  }
}

// 批次開始時呼叫：清掉上次的停止要求並啟用「停止」按鈕
function paramBatchBegin() {
  paramStopReq = false;
  paramSetBusy(true);
  document.getElementById('btnParamBatchStop').disabled = false;
}

document.getElementById('btnParamBatchStop').addEventListener('click', () => {
  if (!paramBusy || paramStopReq) return;
  paramStopReq = true;
  document.getElementById('btnParamBatchStop').disabled = true;
  paramLog('[STOP] 使用者要求停止批次');
  if (paramAbortCurrent) paramAbortCurrent();
});

// 記錄模式下控制器停送 Tool_R frame，參數回應收不到
function paramNotReadyReason() {
  if (!ble.isOpen)          return '請先開啟 BLE 連線';
  if (recordingModeActive)  return '記錄模式中無法讀寫參數，請先停止記錄';
  if (paramBusy)            return '上一個操作尚未完成';
  return null;
}

// ── 單筆讀寫 ───────────────────────────────────────────────────

function paramSelectedFc() {
  return parseInt(document.querySelector('input[name="paramFc"]:checked').value, 10);
}

document.querySelectorAll('input[name="paramFc"]').forEach(rb => {
  rb.addEventListener('change', () => {
    const isRead = paramSelectedFc() === PARAM_FC_READ;
    document.getElementById('paramDataGroup').classList.toggle('disabled', isRead);
    document.getElementById('paramData').disabled = isRead;
  });
});
document.getElementById('paramData').disabled = true; // 預設為讀取
document.getElementById('paramDataGroup').classList.add('disabled');

function parseHex16(id) {
  const s = document.getElementById(id).value.trim();
  return /^[0-9a-fA-F]{1,4}$/.test(s) ? parseInt(s, 16) : null;
}

document.getElementById('btnParamSend').addEventListener('click', async () => {
  const reason = paramNotReadyReason();
  const respEl = document.getElementById('paramResp');
  if (reason) { respEl.textContent = reason; return; }

  const fc   = paramSelectedFc();
  const addr = parseHex16('paramAddr');
  const data = fc === PARAM_FC_WRITE ? parseHex16('paramData') : 0;
  if (addr === null) { respEl.textContent = '位址格式錯誤（1~4 位 hex）'; return; }
  if (data === null) { respEl.textContent = '數據格式錯誤（1~4 位 hex）'; return; }

  paramSetBusy(true);
  respEl.textContent = '等待回應…';
  const r = await paramRequest(fc, addr, data);
  respEl.textContent = paramFcName(fc) + '  位址 0x' + hex4(addr) + '  →  ' + paramResultText(r);
  paramSetBusy(false);
});

// ── 裝置 SIG ───────────────────────────────────────────────────

// 4 個 word → 8 個 ASCII 字元；任一個缺值回傳 null
function sigToAscii(words) {
  if (words.some(w => w === null || w === undefined)) return null;
  let s = '';
  for (const w of words) {
    for (const b of [(w >> 8) & 0xFF, w & 0xFF]) s += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
  }
  return s;
}

async function paramReadDeviceSig() {
  const words = [];
  for (const addr of PARAM_SIG_ADDRS) {
    const r = await paramRequest(PARAM_FC_READ, addr);
    if (!r || r.isErr || r.sendErr) return null;
    words.push(r.val);
    await sleep(PARAM_STEP_GAP_MS);
  }
  return sigToAscii(words);
}

function paramFileSig() {
  return sigToAscii(PARAM_SIG_ADDRS.map(a => {
    const p = paramBatch.find(x => x.addr === a);
    return p ? p.data : null;
  }));
}

document.getElementById('btnParamReadSig').addEventListener('click', async () => {
  const reason = paramNotReadyReason();
  if (reason) { alert(reason); return; }
  paramSetBusy(true);
  const sig = await paramReadDeviceSig();
  document.getElementById('paramSigDevice').textContent = sig || 'ERR';
  paramSetBusy(false);
});

// ── 批次：載入 .txt ────────────────────────────────────────────
// 每行一筆「位址4碼 + 數據4碼」hex，例如 `00101234` 或 `0x0010 0x1234`。
// `;` `#` `//` 之後視為註解；無法解析的行會被略過並計入無效行數。

function parseParamFile(text) {
  const rows = [];
  let invalid = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(/;|#|\/\//)[0].replace(/0x/gi, '').replace(/[\s,:=]/g, '');
    if (!line) continue;
    if (!/^[0-9a-fA-F]{8}$/.test(line)) { invalid++; continue; }
    rows.push({
      addr: parseInt(line.slice(0, 4), 16),
      data: parseInt(line.slice(4, 8), 16),
      readVal: null, result: '--', status: '',
    });
  }
  return { rows, invalid };
}

document.getElementById('btnParamLoad').addEventListener('click', () => {
  document.getElementById('paramBatchFile').click();
});

document.getElementById('paramBatchFile').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const { rows, invalid } = parseParamFile(e.target.result);
    paramBatch = rows;
    document.getElementById('paramFileName').textContent = file.name;
    document.getElementById('paramBatchCtrls').style.display = rows.length ? '' : 'none';
    document.getElementById('paramSaveName').value = file.name.replace(/\.txt$/i, '') + '_result.txt';
    document.getElementById('paramProgFill').style.width = '0';
    document.getElementById('paramSigFile').textContent   = paramFileSig() || '--';
    document.getElementById('paramSigDevice').textContent = '--';
    renderParamBatchTable();
    const msg = '已載入 ' + rows.length + ' 筆' + (invalid ? '，略過 ' + invalid + ' 行無效內容' : '');
    document.getElementById('paramBatchStat').textContent = msg;
    paramLog('[FILE] ' + file.name + '：' + msg);
  };
  reader.readAsText(file);
  this.value = ''; // 允許重新載入同一個檔案
});

// ── 批次：表格 ─────────────────────────────────────────────────

const PARAM_STATUS_CLASS = { OK: 'param-st-ok', ERR: 'param-st-err', TIMEOUT: 'param-st-err', '...': 'param-st-run', SKIP: 'param-st-skip', STOP: 'param-st-skip' };

function renderParamBatchTable() {
  const tbody = document.getElementById('paramBatchBody');
  tbody.innerHTML = paramBatch.map((p, i) =>
    '<tr><td>' + (i + 1) + '</td><td>0x' + hex4(p.addr) + '</td><td>0x' + hex4(p.data) + '</td>' +
    '<td id="paramRes' + i + '">' + p.result + '</td>' +
    '<td id="paramSt' + i + '" class="' + (PARAM_STATUS_CLASS[p.status] || '') + '">' + p.status + '</td></tr>'
  ).join('');
}

function updateParamBatchRow(i) {
  const p = paramBatch[i];
  const res = document.getElementById('paramRes' + i);
  const st  = document.getElementById('paramSt' + i);
  if (res) res.textContent = p.result;
  if (st)  { st.textContent = p.status; st.className = PARAM_STATUS_CLASS[p.status] || ''; }
  if (st && p.status === '...') st.scrollIntoView({ block: 'nearest' });
}

function setParamProgress(done, total, label) {
  document.getElementById('paramProgFill').style.width = Math.round(done / total * 100) + '%';
  document.getElementById('paramBatchStat').textContent = label;
}

// ── 批次：全部讀取 ─────────────────────────────────────────────

document.getElementById('btnParamBatchRead').addEventListener('click', async () => {
  const reason = paramNotReadyReason();
  if (reason) { alert(reason); return; }
  paramBatchBegin();
  let ok = 0, err = 0, done = 0;
  for (let i = 0; i < paramBatch.length; i++) {
    if (paramStopReq) break;
    const p = paramBatch[i];
    p.status = '...'; p.result = '--'; p.readVal = null;
    updateParamBatchRow(i);
    setParamProgress(i, paramBatch.length, '讀取 ' + (i + 1) + '/' + paramBatch.length);
    const r = await paramRequest(PARAM_FC_READ, p.addr);
    if (!r && paramStopReq) { p.status = 'STOP'; updateParamBatchRow(i); break; }
    p.result = paramResultText(r);
    if (r && !r.isErr && !r.sendErr) { p.readVal = r.val; p.status = 'OK'; ok++; }
    else                             { p.status = r ? 'ERR' : 'TIMEOUT'; err++; }
    updateParamBatchRow(i);
    done++;
    if (r && r.sendErr) break; // 斷線，後面也不會成功
    await sleep(PARAM_STEP_GAP_MS);
  }
  const head = paramStopReq ? '讀取已停止（' + done + '/' + paramBatch.length + '）' : '讀取完成';
  setParamProgress(paramStopReq ? done : 1, paramStopReq ? paramBatch.length : 1, head + '：OK ' + ok + '  ERR/TIMEOUT ' + err);
  const devSig = sigToAscii(PARAM_SIG_ADDRS.map(a => {
    const p = paramBatch.find(x => x.addr === a);
    return p ? p.readVal : null;
  }));
  if (devSig) document.getElementById('paramSigDevice').textContent = devSig;
  paramSetBusy(false);
});

// ── 批次：全部寫入（先比對 SIG） ───────────────────────────────

document.getElementById('btnParamBatchWrite').addEventListener('click', async () => {
  const reason = paramNotReadyReason();
  if (reason) { alert(reason); return; }
  const statEl  = document.getElementById('paramBatchStat');
  const fileSig = paramFileSig();
  if (!fileSig) { statEl.textContent = '⚠ 檔案未包含 0x0000~0x0003，無法比對 SIG，寫入中止'; return; }

  paramBatchBegin();
  statEl.textContent = '比對 SIG 中…';
  const devSig = await paramReadDeviceSig();
  if (paramStopReq) {
    statEl.textContent = '寫入已停止（SIG 比對中途停止，尚未寫入任何參數）';
    paramSetBusy(false);
    return;
  }
  document.getElementById('paramSigDevice').textContent = devSig || 'ERR';
  if (devSig !== fileSig) {
    statEl.textContent = '⚠ SIG 不符，寫入中止。檔案「' + fileSig + '」 裝置「' + (devSig || 'ERR') + '」';
    paramSetBusy(false);
    return;
  }
  paramLog('[SIG OK] 檔案「' + fileSig + '」= 裝置「' + devSig + '」，開始寫入');

  let ok = 0, err = 0, skip = 0, done = 0;
  for (let i = 0; i < paramBatch.length; i++) {
    if (paramStopReq) break;
    const p = paramBatch[i];
    setParamProgress(i, paramBatch.length, '寫入 ' + (i + 1) + '/' + paramBatch.length);
    if (p.addr <= PARAM_WRITE_PROTECT) {
      p.status = 'SKIP'; skip++; done++;
      updateParamBatchRow(i);
      continue;
    }
    p.status = '...';
    updateParamBatchRow(i);
    const r = await paramRequest(PARAM_FC_WRITE, p.addr, p.data);
    // 寫入命令可能已送達控制器，只是沒等到回應，所以標成「未確認」而不是當作沒寫
    if (!r && paramStopReq) { p.status = 'STOP'; p.result = '未確認'; updateParamBatchRow(i); break; }
    if (r && !r.isErr && !r.sendErr) { p.status = 'OK'; ok++; }
    else                             { p.status = r ? 'ERR' : 'TIMEOUT'; err++; }
    updateParamBatchRow(i);
    done++;
    if (r && r.sendErr) break;
    await sleep(PARAM_STEP_GAP_MS);
  }
  const head = paramStopReq ? '寫入已停止（' + done + '/' + paramBatch.length + '）' : '寫入完成';
  setParamProgress(paramStopReq ? done : 1, paramStopReq ? paramBatch.length : 1, head + '：OK ' + ok + '  ERR/TIMEOUT ' + err + '  SKIP ' + skip);
  paramSetBusy(false);
});

// ── 批次：儲存結果 ─────────────────────────────────────────────
// 讀取成功的列輸出裝置值；未讀到的列保留檔案原值並在行尾加註，
// 避免存出的檔案看起來完整、實際上混有舊值。註解格式可被 parseParamFile 重新載入。

document.getElementById('btnParamBatchSave').addEventListener('click', () => {
  if (!paramBatch.length) return;
  const failed = paramBatch.filter(p => p.readVal === null).length;
  if (failed && !confirm('有 ' + failed + ' 筆沒有讀取成功，這些列會以檔案原值輸出，並在行尾標註「; READ FAIL」。\n確定要儲存嗎？')) return;

  const txt = paramBatch.map(p => p.readVal !== null
    ? hex4(p.addr) + hex4(p.readVal)
    : hex4(p.addr) + hex4(p.data) + ' ; READ FAIL (file value)'
  ).join('\n') + '\n';

  let filename = document.getElementById('paramSaveName').value.trim() || 'param_result.txt';
  if (!/\.txt$/i.test(filename)) filename += '.txt';
  const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  paramLog('[SAVE] ' + filename + '（' + paramBatch.length + ' 筆' + (failed ? '，' + failed + ' 筆 READ FAIL' : '') + '）');
});
