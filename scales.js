/* ============================================================================
 * IotBench - 6-scale Modbus RTU slave simulator
 *
 * Emulates 6 industrial weighing scales (slave IDs 1..6) on an RS485/serial line
 * so an STM32 (Modbus RTU MASTER) can be bench-tested without real scales.
 *
 * Master polls, we answer:
 *   Request  (8 bytes):  <id> 03 00 25 00 02 <crcLo> <crcHi>   (read 2 regs @ 0x0025)
 *   Response (9 bytes):  <id> 03 04 <w3> <w2> <w1> <w0> <crcLo> <crcHi>
 *                        weight = 32-bit BIG-ENDIAN unsigned grams (w3 = MSB)
 *
 * Only respond when: id in 1..6 AND fn==0x03 AND addr==0x0025 AND qty==0x0002.
 * CRC = CRC-16/MODBUS (poly 0xA001, init 0xFFFF), appended LOW byte first.
 *
 * Serial: 9600 8N1, half-duplex via auto-direction USB-RS485 (no DE/RE control).
 * ========================================================================== */

'use strict';
const { SerialPort } = require('serialport');

/* ---- In-memory weights in GRAMS, one per bin ---- */
const weights = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };

/* ---- Per-bin telemetry for the UI: poll count, last poll time, last served ---- */
const binMeta = {};
for (let i = 1; i <= 6; i++) binMeta[i] = { polls: 0, lastAt: 0, lastServed: 0 };

/* ---- Rolling RX/TX log for the UI ---- */
const LOG_MAX = 300;
const logBuf = [];               // { seq, t, dir, hex, note }
let logSeq = 0;

/* ---- Serial port state ---- */
let port = null;
let rxBuf = Buffer.alloc(0);
let reconnectTimer = null;
const RECONNECT_MS = 3000;
const status = { path: null, baud: 9600, open: false, error: null };

/* ---- CRC-16/MODBUS (polynomial 0xA001 reflected, init 0xFFFF) ---- */
function crc16Modbus(buf, len) {
  let crc = 0xFFFF;
  for (let i = 0; i < len; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : (crc >>> 1);
    }
  }
  return crc & 0xFFFF;
}

/* ---- helpers ---- */
function hex(buf) {
  return Array.from(buf, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
function ts() { return new Date().toISOString().slice(11, 23); }
function kg(g) { return (g / 1000).toFixed(3); }

/* console + rolling buffer, so the UI can show the same traffic */
function logEvent(dir, hexStr, note) {
  const e = { seq: ++logSeq, t: ts(), dir, hex: hexStr, note: note || '' };
  logBuf.push(e);
  if (logBuf.length > LOG_MAX) logBuf.shift();
  const tag = dir.padEnd(3);
  console.log(`[${e.t}] ${tag} ${hexStr}${note ? '   ' + note : ''}`);
}

/* ---- Build the 9-byte response frame ---- */
function buildResponse(id, grams) {
  const b = Buffer.alloc(9);
  b[0] = id;
  b[1] = 0x03;                 // function
  b[2] = 0x04;                 // byte count (2 registers = 4 bytes)
  b.writeUInt32BE(grams >>> 0, 3);   // big-endian grams at bytes 3..6 (w3 = MSB)
  const crc = crc16Modbus(b, 7);
  b[7] = crc & 0xFF;           // CRC low byte first
  b[8] = (crc >> 8) & 0xFF;
  return b;
}

/* ---- Live setter: change a bin's weight (grams) at any time ---- */
function setBinWeight(bin, grams) {
  bin = Number(bin);
  grams = Math.trunc(Number(grams));
  if (!(bin >= 1 && bin <= 6)) throw new Error('bin must be 1..6');
  if (!Number.isFinite(grams) || grams < 0) throw new Error('grams must be a number >= 0');
  grams = grams >>> 0;         // clamp to uint32
  weights[bin] = grams;
  logEvent('SET', '', `bin ${bin} = ${grams} g (${kg(grams)} kg)`);
  return grams;
}

function getWeights() { return { ...weights }; }
function getBinMeta() { return JSON.parse(JSON.stringify(binMeta)); }
function getStatus() { return { ...status }; }
function getLog(sinceSeq = 0) { return logBuf.filter((e) => e.seq > sinceSeq); }

/* ---- Handle one CRC-validated 8-byte request ---- */
function handleRequest(frame) {
  const id = frame[0];
  const fn = frame[1];
  const addr = (frame[2] << 8) | frame[3];
  const qty = (frame[4] << 8) | frame[5];

  if (id >= 1 && id <= 6 && fn === 0x03 && addr === 0x0025 && qty === 0x0002) {
    const grams = weights[id] >>> 0;
    const resp = buildResponse(id, grams);
    logEvent('RX', hex(frame), `poll bin ${id}`);
    if (port) port.write(resp, (err) => { if (err) console.error(`[${ts()}] TX error: ${err.message}`); });
    binMeta[id].polls++;
    binMeta[id].lastAt = Date.now();
    binMeta[id].lastServed = grams;
    logEvent('TX', hex(resp), `bin ${id} = ${grams} g (${kg(grams)} kg)`);
  } else {
    logEvent('--', hex(frame),
      `ignored (id=${id} fn=0x${fn.toString(16)} addr=0x${addr.toString(16).padStart(4, '0')} qty=${qty})`);
  }
}

/* ---- Framing: RTU has no start/end markers; frames are gap-separated.
 * Every request is exactly 8 bytes, so accumulate and parse from the front:
 *   - >= 8 bytes: check CRC of the first 8; if valid, consume 8 and reply;
 *   - if invalid, drop 1 byte and retry (resync).                            */
function processBuffer() {
  while (rxBuf.length >= 8) {
    const frame = rxBuf.subarray(0, 8);
    const crcCalc = crc16Modbus(frame, 6);
    const crcRecv = frame[6] | (frame[7] << 8);
    if (crcCalc === crcRecv) {
      handleRequest(frame);
      rxBuf = Buffer.from(rxBuf.subarray(8));   // consume the 8-byte frame
    } else {
      rxBuf = Buffer.from(rxBuf.subarray(1));    // resync: drop one byte
    }
  }
}

/* ---- Retry opening the port after a drop, until it's back. ---- */
function scheduleReconnect() {
  if (reconnectTimer || status.open) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (status.open) return;
    console.log(`[${ts()}] reconnecting to ${status.path} ...`);
    openPort();
  }, RECONNECT_MS);
}

/* ---- (Re)open the serial port and wire up its events. ---- */
function openPort() {
  try { if (port && port.isOpen) port.close(); } catch (_) { /* ignore */ }

  port = new SerialPort({
    path: status.path, baudRate: status.baud, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false,
  });

  port.open((err) => {
    if (err) {
      status.open = false; status.error = err.message;
      console.error(`Scale sim: failed to open ${status.path}: ${err.message} (retry in ${RECONNECT_MS / 1000}s)`);
      scheduleReconnect();
      return;
    }
    status.open = true; status.error = null; rxBuf = Buffer.alloc(0);
    console.log(`Scale sim on ${status.path} @ ${status.baud} 8N1 - bins 1..6, Modbus RTU slave (FC03 @ 0x0025)`);
  });

  port.on('data', (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    processBuffer();
  });
  port.on('close', () => {
    if (status.open) console.warn(`[${ts()}] serial ${status.path} closed - retrying`);
    status.open = false;
    scheduleReconnect();
  });
  port.on('error', (e) => {
    status.open = false; status.error = e.message;
    console.error(`[${ts()}] serial error: ${e.message}`);
    scheduleReconnect();
  });

  return port;
}

/* ---- Bind the serial port and start listening (auto-reconnects on drop). ---- */
function startScaleSim({ path, baud = 9600 } = {}) {
  if (!path) { status.error = 'no serial port configured'; return null; }
  status.path = path; status.baud = baud; status.open = false; status.error = null;
  return openPort();
}

module.exports = {
  startScaleSim, setBinWeight, getWeights, getBinMeta, getStatus, getLog,
  weights, crc16Modbus, buildResponse,
};
