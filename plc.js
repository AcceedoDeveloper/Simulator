/* ============================================================================
 * IotBench - GDC PLC simulator (Modbus RTU slave)
 *
 * Emulates the GDC machine PLC that the ProductionMonitorV2 STM32 polls over
 * RS485, so station counters can be driven from the bench.
 *
 * Master polls, we answer:
 *   Request  (8 bytes):  01 03 00 C6 00 1F <crcLo> <crcHi>   (read 31 regs @ 0x00C6)
 *   Response:            01 03 <2*qty> <reg hi lo>... <crcLo> <crcHi>
 *
 * Any FC03 read inside the 64K holding-register table is answered, so a
 * changed PLC_BLOCK_ADDR / PLC_BLOCK_COUNT on the STM32 still works. Other
 * function codes get Modbus exception 01 (illegal function).
 *
 * Register map (offsets from BLOCK_ADDR, must match ProductionMonitorV2
 * Core/App/Config/config.h):
 *   station n (0..3):  production  16+4n   rejection  18+4n
 *                      temp left   8+2n    temp right 9+2n   (deg C x10)
 *
 * Serial: 19200 8N2 (GDC PLC), auto-direction USB-RS485 adapter.
 * ========================================================================== */

'use strict';
const { SerialPort } = require('serialport');
const { crc16Modbus } = require('./scales');

const SLAVE_ID   = 1;
const BLOCK_ADDR = 0x00C6;
const STATIONS   = 4;
const OFF = {
  prod:  (n) => 16 + 4 * n,
  rej:   (n) => 18 + 4 * n,
  tempL: (n) => 8 + 2 * n,
  tempR: (n) => 9 + 2 * n,
};

/* full holding-register table */
const regs = new Uint16Array(65536);
const reg = (n, k) => BLOCK_ADDR + OFF[k](n);

/* sensible start: 45.0 / 32.0 deg C on every station */
for (let n = 0; n < STATIONS; n++) { regs[reg(n, 'tempL')] = 450; regs[reg(n, 'tempR')] = 320; }

/* auto production per station: one part every cycleSec, a rejection every rejEvery parts */
const auto = [];
for (let n = 0; n < STATIONS; n++) auto.push({ cycleSec: 0, rejEvery: 0, nextAt: 0, made: 0 });

/* fault injection, to exercise the STM32's PLC=0 / PLCERR paths */
const faults = { silent: false, badCrc: false, delayMs: 0 };
/* one-shot fault: applied to the next `remaining` replies, then normal again.
 *   drop      no reply at all          -> STM32 timeout
 *   short     first 20 bytes only      -> STM32 short reply
 *   exception 01 83 02 (illegal addr)  -> STM32 exception
 *   wrongid   reply from slave 2       -> STM32 header error
 *   crc       full reply, CRC flipped  -> STM32 CRC error            */
const ONESHOT_MODES = ['drop', 'short', 'exception', 'wrongid', 'crc'];
const oneshot = { mode: 'drop', remaining: 0, applied: 0 };

/* poll telemetry */
const meta = { polls: 0, lastAt: 0, lastReq: '', rawBytes: 0, dropped: 0 };
/* log every received chunk before framing — shows garbage (wrong baud, A/B
 * swapped) that the CRC framing would otherwise drop silently */
let rawLog = true;

/* rolling RX/TX log (same shape as scales.js so the UI code is shared in spirit) */
const LOG_MAX = 300;
const logBuf = [];
let logSeq = 0;

let port = null;
let rxBuf = Buffer.alloc(0);
let reconnectTimer = null;
const RECONNECT_MS = 3000;
const status = { path: null, baud: 19200, stopBits: 2, open: false, error: null };

function hex(buf) { return Array.from(buf, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' '); }
function ts() { return new Date().toISOString().slice(11, 23); }

function logEvent(dir, hexStr, note) {
  const e = { seq: ++logSeq, t: ts(), dir, hex: hexStr, note: note || '' };
  logBuf.push(e);
  if (logBuf.length > LOG_MAX) logBuf.shift();
  console.log(`[${e.t}] ${dir.padEnd(3)} ${hexStr}${note ? '   ' + note : ''}`);
}

function withCrc(body, corrupt) {
  const b = Buffer.alloc(body.length + 2);
  body.copy(b);
  let crc = crc16Modbus(b, body.length);
  if (corrupt) crc ^= 0xFFFF;
  b[body.length] = crc & 0xFF;
  b[body.length + 1] = (crc >> 8) & 0xFF;
  return b;
}

function send(buf, note) {
  const go = () => {
    if (port) port.write(buf, (err) => { if (err) console.error(`[${ts()}] TX error: ${err.message}`); });
    logEvent('TX', hex(buf), note);
  };
  if (faults.delayMs > 0) setTimeout(go, faults.delayMs); else go();
}

/* ---------------- station API ---------------- */
function getStations() {
  const out = [];
  for (let n = 0; n < STATIONS; n++) {
    out.push({
      station: n + 1,
      prod: regs[reg(n, 'prod')], rej: regs[reg(n, 'rej')],
      tempL: regs[reg(n, 'tempL')] / 10, tempR: regs[reg(n, 'tempR')] / 10,
      regs: { prod: reg(n, 'prod'), rej: reg(n, 'rej'), tempL: reg(n, 'tempL'), tempR: reg(n, 'tempR') },
      auto: { cycleSec: auto[n].cycleSec, rejEvery: auto[n].rejEvery },
    });
  }
  return out;
}

function idx(station) {
  const n = Number(station) - 1;
  if (!(n >= 0 && n < STATIONS)) throw new Error(`station must be 1..${STATIONS}`);
  return n;
}
function u16(v, name) {
  v = Math.trunc(Number(v));
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return ((v % 65536) + 65536) % 65536;    // wrap like a real 16-bit counter
}

/* set any of prod / rej / tempL / tempR (temps in deg C) */
function setStation(station, vals) {
  const n = idx(station);
  const parts = [];
  if (vals.prod !== undefined)  { regs[reg(n, 'prod')]  = u16(vals.prod, 'prod'); parts.push(`prod=${regs[reg(n, 'prod')]}`); }
  if (vals.rej !== undefined)   { regs[reg(n, 'rej')]   = u16(vals.rej, 'rej'); parts.push(`rej=${regs[reg(n, 'rej')]}`); }
  if (vals.tempL !== undefined) { regs[reg(n, 'tempL')] = u16(Math.round(Number(vals.tempL) * 10), 'tempL'); parts.push(`tempL=${vals.tempL}`); }
  if (vals.tempR !== undefined) { regs[reg(n, 'tempR')] = u16(Math.round(Number(vals.tempR) * 10), 'tempR'); parts.push(`tempR=${vals.tempR}`); }
  if (parts.length) logEvent('SET', '', `station ${n + 1}: ${parts.join(' ')}`);
}

/* add parts (kind 'prod' or 'rej'); negative count steps the counter back */
function addParts(station, kind, count) {
  const n = idx(station);
  if (kind !== 'prod' && kind !== 'rej') throw new Error("kind must be 'prod' or 'rej'");
  const r = reg(n, kind);
  regs[r] = u16(regs[r] + Math.trunc(Number(count) || 0), kind);
  logEvent('SET', '', `station ${n + 1}: ${kind} ${count >= 0 ? '+' : ''}${count} -> ${regs[r]}`);
}

function setAuto(station, cycleSec, rejEvery) {
  const n = idx(station);
  auto[n].cycleSec = Math.max(0, Number(cycleSec) || 0);
  auto[n].rejEvery = Math.max(0, Math.trunc(Number(rejEvery) || 0));
  auto[n].nextAt = Date.now() + auto[n].cycleSec * 1000;
  auto[n].made = 0;
  logEvent('SET', '', `station ${n + 1}: auto ${auto[n].cycleSec ? 'every ' + auto[n].cycleSec + ' s' : 'off'}` +
           (auto[n].rejEvery ? `, reject every ${auto[n].rejEvery}` : ''));
}

function setOneShot(mode, count) {
  if (!ONESHOT_MODES.includes(mode)) throw new Error(`mode must be one of ${ONESHOT_MODES.join(', ')}`);
  oneshot.mode = mode;
  oneshot.remaining = Math.max(0, Math.trunc(Number(count) || 0));
  logEvent('SET', '', oneshot.remaining ? `one-shot: ${mode} on the next ${oneshot.remaining} reply(s)` : 'one-shot cleared');
}

function setFaults(f) {
  if (f.silent !== undefined) faults.silent = !!f.silent;
  if (f.badCrc !== undefined) faults.badCrc = !!f.badCrc;
  if (f.delayMs !== undefined) faults.delayMs = Math.max(0, Number(f.delayMs) || 0);
  logEvent('SET', '', `faults: silent=${faults.silent} badCrc=${faults.badCrc} delay=${faults.delayMs} ms`);
}

setInterval(() => {
  const now = Date.now();
  for (let n = 0; n < STATIONS; n++) {
    const a = auto[n];
    if (!a.cycleSec || now < a.nextAt) continue;
    a.nextAt = now + a.cycleSec * 1000;
    a.made++;
    const isRej = a.rejEvery > 0 && a.made % a.rejEvery === 0;
    addParts(n + 1, isRej ? 'rej' : 'prod', 1);
  }
}, 100).unref();

/* ---------------- Modbus slave ---------------- */
function handleRequest(frame) {
  const id = frame[0], fn = frame[1];
  const addr = (frame[2] << 8) | frame[3];
  const qty = (frame[4] << 8) | frame[5];

  if (id !== SLAVE_ID) { logEvent('--', hex(frame), `other slave ${id}, ignored`); return; }

  meta.polls++; meta.lastAt = Date.now(); meta.lastReq = hex(frame);
  if (faults.silent) { logEvent('RX', hex(frame), 'SILENT fault: no reply'); return; }

  if (oneshot.remaining > 0 && fn === 0x03) {
    oneshot.remaining--; oneshot.applied++;
    const left = `(${oneshot.remaining} left)`;
    const full = Buffer.alloc(3 + 2 * qty);
    full[0] = id; full[1] = 0x03; full[2] = 2 * qty;
    for (let i = 0; i < qty && addr + i < 65536; i++) full.writeUInt16BE(regs[addr + i], 3 + 2 * i);
    logEvent('RX', hex(frame), `ONE-SHOT ${oneshot.mode} ${left}`);
    switch (oneshot.mode) {
      case 'drop':      return;
      case 'short':     send(withCrc(full, false).subarray(0, 20), `ONE-SHOT short: 20 bytes only ${left}`); return;
      case 'exception': send(withCrc(Buffer.from([id, 0x83, 0x02]), false), `ONE-SHOT exception 02 ${left}`); return;
      case 'wrongid':   full[0] = (id % 247) + 1; send(withCrc(full, false), `ONE-SHOT reply as slave ${full[0]} ${left}`); return;
      case 'crc':       send(withCrc(full, true), `ONE-SHOT bad CRC ${left}`); return;
    }
  }

  if (fn !== 0x03) {
    logEvent('RX', hex(frame), `fn 0x${fn.toString(16)} -> exception 01`);
    send(withCrc(Buffer.from([id, fn | 0x80, 0x01]), faults.badCrc), 'exception: illegal function');
    return;
  }
  if (qty < 1 || qty > 125 || addr + qty > 65536) {
    logEvent('RX', hex(frame), `bad range addr=0x${addr.toString(16)} qty=${qty} -> exception 02`);
    send(withCrc(Buffer.from([id, 0x83, 0x02]), faults.badCrc), 'exception: illegal address');
    return;
  }

  logEvent('RX', hex(frame), `read ${qty} @ 0x${addr.toString(16).padStart(4, '0')}`);
  const body = Buffer.alloc(3 + 2 * qty);
  body[0] = id; body[1] = 0x03; body[2] = 2 * qty;
  for (let i = 0; i < qty; i++) body.writeUInt16BE(regs[addr + i], 3 + 2 * i);
  const s = getStations().map((x) => `S${x.station} ${x.prod}/${x.rej}`).join('  ');
  send(withCrc(body, faults.badCrc), (faults.badCrc ? 'BAD CRC  ' : '') + s);
}

/* RTU requests for FC01..06 are 8 bytes: validate CRC, else drop a byte and resync */
function processBuffer() {
  while (rxBuf.length >= 8) {
    const frame = rxBuf.subarray(0, 8);
    if (crc16Modbus(frame, 6) === (frame[6] | (frame[7] << 8))) {
      handleRequest(Buffer.from(frame));
      rxBuf = Buffer.from(rxBuf.subarray(8));
    } else {
      rxBuf = Buffer.from(rxBuf.subarray(1));
      meta.dropped++;
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer || status.open) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!status.open) openPort();
  }, RECONNECT_MS);
}

function openPort() {
  try { if (port && port.isOpen) port.close(); } catch (_) { /* ignore */ }
  port = new SerialPort({
    path: status.path, baudRate: status.baud, dataBits: 8, parity: 'none',
    stopBits: status.stopBits, autoOpen: false,
  });
  port.open((err) => {
    if (err) {
      status.open = false; status.error = err.message;
      console.error(`PLC sim: failed to open ${status.path}: ${err.message} (retry in ${RECONNECT_MS / 1000}s)`);
      scheduleReconnect();
      return;
    }
    status.open = true; status.error = null; rxBuf = Buffer.alloc(0);
    console.log(`PLC sim on ${status.path} @ ${status.baud} 8N${status.stopBits} - slave ${SLAVE_ID}, ` +
                `${STATIONS} stations, block 0x${BLOCK_ADDR.toString(16).padStart(4, '0')}`);
  });
  port.on('data', (chunk) => {
    meta.rawBytes += chunk.length;
    if (rawLog) logEvent('RAW', hex(chunk), `${chunk.length} byte(s) on the wire`);
    rxBuf = Buffer.concat([rxBuf, chunk]);
    processBuffer();
  });
  port.on('close', () => { status.open = false; scheduleReconnect(); });
  port.on('error', (e) => { status.open = false; status.error = e.message; scheduleReconnect(); });
  return port;
}

function startPlcSim({ path, baud = 19200, stopBits = 2 } = {}) {
  if (!path) { status.error = 'no serial port configured'; return null; }
  Object.assign(status, { path, baud, stopBits, open: false, error: null });
  return openPort();
}

module.exports = {
  startPlcSim, getStations, setStation, addParts, setAuto, setFaults,
  getStatus: () => ({ ...status, slave: SLAVE_ID, blockAddr: BLOCK_ADDR }),
  getMeta: () => ({ ...meta }),
  getFaults: () => ({ ...faults, oneshot: { ...oneshot } }),
  setOneShot,
  setRawLog: (on) => { rawLog = !!on; },
  getLog: (since = 0) => logBuf.filter((e) => e.seq > since),
  /* bench self-test: feed raw bytes as if they arrived on the serial line */
  _rx: (buf) => { rxBuf = Buffer.concat([rxBuf, buf]); processBuffer(); },
};
