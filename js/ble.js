/**
 * ble.js — Web Bluetooth (BLE) channel manager
 *
 * 連線流程:
 *   1. 掃描所有裝置，由使用者選擇
 *   2. 建立 GATT 連線
 *   3. 自動偵測支援 UART bridge 的 Service/Characteristic
 *      (依序嘗試 ESP_GATTS → NUS → HM10 → SPP，找到第一組 write+notify 即使用)
 *   4. 訂閱 notify characteristic → 資料推入 _rxBuf
 *   5. write() 直接寫入 write characteristic
 */

const BLE_UART_PROFILES = [
  {
    name:   'ESP_GATTS',
    svc:    0x00ff,
    write:  0xff01,
    notify: 0xff01,
    cfg:    null,
  },
  {
    name:   'NUS',
    svc:    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    write:  '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    cfg:    '6e400004-b5a3-f393-e0a9-e50e24dcca9e',
  },
  {
    name:   'HM10',
    svc:    0xffe0,
    write:  0xffe1,
    notify: 0xffe1,
    cfg:    null,
  },
  {
    name:   'SPP',
    svc:    0xabf0,
    write:  0xabf1,
    notify: 0xabf2,
    cfg:    null,
  },
];

const BLE_OPTIONAL_SERVICES = [
  0x00ff,
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  0xffe0, 0xffe1,
  0xabf0,
];

class BleManager {
  constructor() {
    this._device      = null;
    this._server      = null;
    this._writeChar   = null;
    this._notifChar   = null;
    this._cfgChar     = null;
    this._profileName = null;
    this._rxBuf       = [];
    this.onDisconnect = null;
    this.onCanFrame   = null;
  }

  get deviceInfo() {
    return {
      name:    this._device ? this._device.name : null,
      profile: this._profileName || null,
    };
  }

  get isOpen() {
    return !!(this._device && this._device.gatt.connected);
  }

  async open({ baudRate = 115200 } = {}) {
    if (!window.isSecureContext) {
      throw new Error('Web Bluetooth 需要 HTTPS 或 localhost 環境');
    }
    if (!navigator.bluetooth) {
      throw new Error('此瀏覽器不支援 Web Bluetooth API\n請使用 Chrome / Edge 並以 HTTPS 或 localhost 開啟');
    }

    try {
      this._device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: BLE_OPTIONAL_SERVICES,
      });
    } catch (e) {
      if (e.name === 'NotFoundError') throw new Error('BLE 掃描已取消（未選擇裝置）');
      throw e;
    }

    this._device.addEventListener('gattserverdisconnected', () => {
      this._rxBuf = [];
      if (this.onDisconnect) this.onDisconnect();
    });

    try {
      this._server = await this._device.gatt.connect();
    } catch (e) {
      this._device = null;
      throw new Error('GATT 連線失敗：' + e.message);
    }

    const found = await this._findUartChars();
    this._writeChar   = found.writeChar;
    this._notifChar   = found.notifChar;
    this._cfgChar     = found.cfgChar;
    this._profileName = found.profileName;

    try {
      await this._notifChar.startNotifications();
    } catch {
      await this.close();
      throw new Error('無法訂閱 Notification，請重試');
    }
    this._notifChar.addEventListener('characteristicvaluechanged', (e) => {
      const bytes = new Uint8Array(e.target.value.buffer);
      for (const b of bytes) this._rxBuf.push(b);
      this._dispatchFrames();
    });

    if (this._cfgChar && baudRate) {
      const cfg = new Uint8Array(5);
      cfg[0] = 0x01;
      cfg[1] =  baudRate        & 0xFF;
      cfg[2] = (baudRate >>  8) & 0xFF;
      cfg[3] = (baudRate >> 16) & 0xFF;
      cfg[4] = (baudRate >> 24) & 0xFF;
      await this._cfgChar.writeValueWithoutResponse(cfg);
    }
  }

  async _findUartChars() {
    const errors = [];

    for (const profile of BLE_UART_PROFILES) {
      let svc;
      try {
        svc = await this._server.getPrimaryService(profile.svc);
      } catch (e) {
        errors.push(profile.name + ': ' + e.message);
        continue;
      }

      let writeChar = null, notifChar = null;
      try { writeChar = await svc.getCharacteristic(profile.write);  } catch {}
      try { notifChar = await svc.getCharacteristic(profile.notify); } catch {}

      if (!writeChar || !notifChar) {
        let allChars = [];
        try {
          allChars = await svc.getCharacteristics();
        } catch (e) {
          errors.push(profile.name + ': getCharacteristics 失敗 — ' + e.message);
          continue;
        }
        for (const char of allChars) {
          if (!writeChar && (char.properties.write || char.properties.writeWithoutResponse)) writeChar = char;
          if (!notifChar && char.properties.notify) notifChar = char;
        }
      }

      const canWrite  = writeChar  && (writeChar.properties.write  || writeChar.properties.writeWithoutResponse);
      const canNotify = notifChar  && notifChar.properties.notify;

      if (!canWrite || !canNotify) {
        errors.push(profile.name + ': 找不到符合的 write + notify characteristics');
        continue;
      }

      let cfgChar = null;
      if (profile.cfg) {
        try { cfgChar = await svc.getCharacteristic(profile.cfg); } catch {}
      }

      return { writeChar, notifChar, cfgChar, profileName: profile.name };
    }

    await this.close();
    throw new Error(
      '無法自動偵測 BLE UART Characteristics\n\n' +
      '嘗試的 Profile:\n' + errors.map(s => '  • ' + s).join('\n') + '\n\n' +
      '請確認裝置 GATT Service 包含 Write + Notify Characteristic'
    );
  }

  async close() {
    if (this._notifChar) {
      try { await this._notifChar.stopNotifications(); } catch {}
      this._notifChar = null;
    }
    if (this._device && this._device.gatt.connected) {
      try { this._device.gatt.disconnect(); } catch {}
    }
    this._device      = null;
    this._server      = null;
    this._writeChar   = null;
    this._cfgChar     = null;
    this._profileName = null;
    this._rxBuf       = [];
  }

  async write(data) {
    if (!this.isOpen) throw new Error('BLE 未連線');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this._writeChar.writeValueWithoutResponse(bytes);
  }

  clearBuffer() { this._rxBuf.length = 0; }

  _dispatchFrames() {
    while (true) {
      let start = -1;
      for (let i = 0; i < this._rxBuf.length - 1; i++) {
        if (this._rxBuf[i] === 0xFA && this._rxBuf[i + 1] === 0x0D) { start = i; break; }
      }
      if (start < 0)                           { this._rxBuf.length = 0; return; }
      if (this._rxBuf.length < start + 15)     { return; }

      const frame = new Uint8Array(this._rxBuf.splice(0, start + 15).slice(start + 2));
      if (this.onCanFrame) {
        const r = parseCanResponse(frame);
        if (r) this.onCanFrame(r.id, r.len, r.data);
      }
    }
  }

  readCanFrame(timeoutMs = 1000) {
    return this._waitFor((buf) => {
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0xFA && buf[i + 1] === 0x0D) {
          if (buf.length >= i + 15) return i + 14;
        }
      }
      return -1;
    }, timeoutMs, null);
  }

  _waitFor(matcher, timeoutMs, startByte) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        const endIdx = matcher(this._rxBuf);
        if (endIdx >= 0) {
          let startIdx = 0;
          if (startByte !== null) {
            startIdx = this._rxBuf.indexOf(startByte);
            if (startIdx < 0) startIdx = 0;
          } else {
            for (let i = 0; i <= endIdx - 1; i++) {
              if (this._rxBuf[i] === 0xFA && this._rxBuf[i + 1] === 0x0D) {
                startIdx = i + 2;
                break;
              }
            }
          }
          const slice = this._rxBuf.splice(0, endIdx + 1).slice(startIdx);
          resolve(new Uint8Array(slice));
          return;
        }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(poll, 2);
      };
      poll();
    });
  }
}
