/* ============================================================================
 * IotBench - bin / crane data publisher (topic bin/data)
 *
 * Replays the scripted field cycle from the melting-line STM32 simulator
 * (FieldTest/simulate_weight_cranesection, fieldsim.c) and publishes the same
 * JSON the ESP32 builds in publishBins(), once per second:
 *
 *   {"B1":"7500",...,"B8":"6000","sec":1,"onl":255,"hook":4200,"hookConv":4200,"hookOk":1}
 *
 * It exists so the app / server side can be tested with realistic data when the
 * boards cannot be flashed or are not on the desk. Nothing here touches hardware.
 *
 * What is REAL and what is SYNTHETIC
 *   real       - the section logic (a port of cranesection.c updateSectionAssert,
 *                tie-break v4), the 10 ms sampling, the 100 ms scale round-robin
 *                and the 2 s freshness window that produce `sec`, `onl`, `hookOk`
 *   synthetic  - the recipe weights, ramp shapes and hook values. They exercise
 *                every field; they are not plant data and the hook unit is unknown.
 *
 * The script table below is a hand port of s_script[] in fieldsim.c. If you change
 * one, change the other (test-binsim.js checks this table's behaviour).
 *
 * Targets
 *   embedded - published onto this IotBench's own broker (visible on /mqtt, and to
 *              any client connected to it)
 *   external - a minimal MQTT 3.1.1 client (built on mqtt-packet, already a
 *              dependency of aedes) publishes to another broker, QoS 0, not
 *              retained - exactly how the ESP32's PubSubClient publishes.
 *              Plain TCP only (no TLS).
 * ========================================================================== */

'use strict';
const net = require('net');
const mqttPacket = require('mqtt-packet');

/* ---------------------------------------------------------------------------
 * Script vocabulary (same as fieldsim.c)
 * ------------------------------------------------------------------------- */
const S1 = 0x01, S2 = 0x02, S3 = 0x04, S4 = 0x08, S5 = 0x10, S6 = 0x20;
const HOLD = 0, UP = 1, DOWN = 2;
const offBin = (n) => 1 << n;
const OFF_HOOK = 1 << 8;
const HK_UP = 4200;

/* staggered crossing of a close pair: `a` first, overlap, `b` last */
const cross = (a, b, m, h, o) => [
  [400, a, m, h, o], [600, a | b, m, h, o], [400, b, m, h, o], [100, 0, m, h, o],
];
/* fast crossing: both change in ONE 10 ms sample; `held` is still on after the
 * leading sensor releases */
const fast = (both, held, m, h, o) => [
  [500, both, m, h, o], [600, held, m, h, o], [300, 0, m, h, o],
];

/* recipe the bins ramp to, grams: Carbon, Silica, Manganese, Copper, Tin,
 * Copper-act, Tin-act, Zinc (synthetic) */
const TARGET = [7500, 12300, 18600, 9200, 3100, 4800, 1500, 6000];

/* [duration ms, sensors, bin mode, hook target, off-bus flags] */
const SCRIPT = [
  [5000, 0, HOLD, 0, 0],                         // parked far left, bins empty      SEC 0
  [30000, 0, UP, 0, 0],                          // operator weighs additions        SEC 0
  [4000, 0, HOLD, 0, 0],
  [5000, 0, HOLD, 0, offBin(2)],                 // Manganese scale off the bus
  [2000, 0, HOLD, 0, 0],
  ...cross(S1, S2, HOLD, 0, 0),                  // enters gate A                    SEC 1
  [8000, 0, DOWN, HK_UP, 0],                     // lifts the charge: bins empty
  [500, S3, HOLD, HK_UP, 0],                     // on to Section 2
  [12000, 0, HOLD, HK_UP, 0],                    // long walking path
  [500, S4, HOLD, HK_UP, 0],                     //                                  SEC 2
  [6000, 0, HOLD, 0, 0],                         // dumps the charge
  [3000, 0, HOLD, -350, 0],                      // hook below zero (tare)
  [2000, 0, HOLD, 0, 0],
  [5000, 0, HOLD, 0, OFF_HOOK],                  // hook scale off the bus
  [2000, 0, HOLD, 0, 0],
  ...cross(S5, S6, HOLD, 0, 0),                  // leaves through gate C            SEC 3
  [5000, 0, HOLD, 0, 0],
  ...cross(S6, S5, HOLD, 0, 0),                  // back in through gate C           SEC 2
  [3000, 0, HOLD, 0, 0],
  [500, S4, HOLD, 0, 0],                         // leaves Section 2
  [10000, 0, HOLD, 0, 0],
  [500, S3, HOLD, 0, 0],                         //                                  SEC 1
  [3000, 0, HOLD, 0, 0],
  ...cross(S2, S1, HOLD, 0, 0),                  // out through gate A               SEC 0
  [3000, 0, HOLD, 0, 0],
  ...fast(S1 | S2, S2, HOLD, 0, 0),              // fast IN at gate A                SEC 1
  [3000, 0, HOLD, 0, 0],
  ...fast(S1 | S2, S1, HOLD, 0, 0),              // fast OUT at gate A               SEC 0
  [3000, 0, HOLD, 0, 0],
  ...cross(S1, S2, HOLD, 0, 0),                  //                                  SEC 1
  [500, S3, HOLD, 0, 0],
  [8000, 0, HOLD, 0, 0],
  [500, S4, HOLD, 0, 0],                         //                                  SEC 2
  ...fast(S5 | S6, S6, HOLD, 0, 0),              // fast OUT at gate C               SEC 3
  [3000, 0, HOLD, 0, 0],
  ...fast(S5 | S6, S5, HOLD, 0, 0),              // fast IN at gate C                SEC 2
  [3000, 0, HOLD, 0, 0],
  [500, S4, HOLD, 0, 0],                         // home again
  [10000, 0, HOLD, 0, 0],
  [500, S3, HOLD, 0, 0],
  [2000, 0, HOLD, 0, 0],
  ...cross(S2, S1, HOLD, 0, 0),                  //                                  SEC 0
  [5000, 0, HOLD, 0, 0],
];
const CYCLE_MS = SCRIPT.reduce((a, s) => a + s[0], 0);

/* C integer division truncates toward zero */
const cdiv = (a, b) => Math.trunc(a / b);

/* ---------------------------------------------------------------------------
 * Scenario engine (port of the engine in fieldsim.c)
 * ------------------------------------------------------------------------- */
class Scenario {
  constructor() {
    this.seg = 0; this.t0 = 0; this.cycle = 0;
    this.wStart = new Array(8).fill(0); this.hStart = 0;
    this.rng = 0x2F6E2B1;
  }
  _rng() {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return this.rng >>> 16;
  }
  _true(b, pm) {
    const start = this.wStart[b], mode = SCRIPT[this.seg][2];
    if (mode === UP) {
      let f = cdiv((pm - b * 80) * 1000, 400);
      f = Math.max(0, Math.min(1000, f));
      return start + cdiv((TARGET[b] - start) * f, 1000);
    }
    if (mode === DOWN) {
      const f = Math.min(1000, cdiv(pm * 1000, 700));
      return start - cdiv(start * f, 1000);
    }
    return start;
  }
  advance(now) {
    while (now - this.t0 >= SCRIPT[this.seg][0]) {
      for (let b = 0; b < 8; b++) this.wStart[b] = this._true(b, 1000);
      this.hStart = SCRIPT[this.seg][3];
      this.t0 += SCRIPT[this.seg][0];
      if (++this.seg >= SCRIPT.length) { this.seg = 0; this.cycle++; }
    }
  }
  _pm(now) { return cdiv((now - this.t0) * 1000, SCRIPT[this.seg][0]); }
  sensor(now, i) { this.advance(now); return (SCRIPT[this.seg][1] >> i) & 1; }
  binOffline(now, b) { this.advance(now); return (SCRIPT[this.seg][4] >> b) & 1; }
  hookOffline(now) { this.advance(now); return (SCRIPT[this.seg][4] >> 8) & 1; }
  binWeight(now, b) {
    this.advance(now);
    let w = this._true(b, this._pm(now));
    if (w > 200) w += (this._rng() % 7) - 3;
    return Math.max(0, w);
  }
  hookRaw(now) {
    this.advance(now);
    const tgt = SCRIPT[this.seg][3];
    let hs = this.hStart + cdiv((tgt - this.hStart) * this._pm(now), 1000);
    if (hs > 1000 || hs < -1000) hs += (this._rng() % 25) - 12;
    if (hs >= 0) return Math.min(hs, 7999);
    return 65535 + Math.max(hs, -(65535 - 8000));
  }
}

/* ---------------------------------------------------------------------------
 * Section logic (port of cranesection.c updateSectionAssert, tie-break v4)
 * ------------------------------------------------------------------------- */
const ASSERT = [0, 1, 1, 2, 2, 3];       // S1..S6 -> section asserted on a rising edge
const PARTNER = [1, 0, -1, -1, 5, 4];    // close pairs: S1<->S2, S5<->S6; S3/S4 have none

class SectionLogic {
  constructor() { this.sec = 0; this.prev = new Array(6).fill(0); this.defer = 0; this.first = true; }
  step(inp) {
    if (this.first) {                                   // power-up recovery from a live level
      this.first = false;
      const on = [];
      for (let i = 0; i < 6; i++) if (inp[i]) on.push(i);
      if (on.length === 1) this.sec = ASSERT[on[0]];
      else if (on.length > 1) this.defer = on.reduce((m, i) => m | (1 << i), 0);
      this.prev = inp.slice(); return;
    }
    for (let i = 0; i < 6; i++) {
      if (inp[i] && !this.prev[i]) {                    // rising edge
        const p = PARTNER[i];
        if (p >= 0 && inp[p]) this.defer |= (1 << i) | (1 << p);   // partner already on: wait
        else { this.sec = ASSERT[i]; this.defer = 0; }
      }
    }
    for (let i = 0; i < 6; i++) {
      if (!inp[i] && this.prev[i] && (this.defer & (1 << i))) {   // falling edge of a deferred sensor
        this.defer &= ~(1 << i);
        const still = [];
        for (let k = 0; k < 6; k++) if ((this.defer & (1 << k)) && inp[k]) still.push(k);
        if (still.length === 1) { this.sec = ASSERT[still[0]]; this.defer &= ~(1 << still[0]); }
        else if (still.length === 0) this.sec = ASSERT[i];
      }
    }
    this.prev = inp.slice();
  }
}

/* ---------------------------------------------------------------------------
 * The "board": 10 ms crane tick + 100 ms scale slot + freshness, as on the STM32
 * ------------------------------------------------------------------------- */
const FRESH_MS = 2000;

class Board {
  constructor() { this.reset(); }
  reset() {
    this.scn = new Scenario(); this.sec = new SectionLogic();
    this.t = 0; this.lastPoll = 0; this.slot = 0;
    this.weights = new Array(8).fill(0);
    this.binSeen = new Array(8).fill(0);
    this.hookRawV = 0; this.hookSeen = 0;
  }
  step() {                                              // advance 10 simulated ms
    this.t += 10;
    const t = this.t;
    const inp = [0, 1, 2, 3, 4, 5].map((i) => this.scn.sensor(t, i));
    this.sec.step(inp);
    if (t - this.lastPoll >= 100) {                     // one slot per 100 ms: hook, then bins
      this.lastPoll = t;
      if (this.slot === 0) {
        if (!this.scn.hookOffline(t)) { this.hookRawV = this.scn.hookRaw(t); this.hookSeen = t; }
      } else {
        const b = this.slot - 1;
        if (!this.scn.binOffline(t, b)) { this.weights[b] = this.scn.binWeight(t, b); this.binSeen[b] = t; }
      }
      this.slot = (this.slot + 1) % 9;
    }
  }
  snapshot() {
    const t = this.t;
    let onl = 0;
    for (let b = 0; b < 8; b++) if (this.binSeen[b] && t - this.binSeen[b] < FRESH_MS) onl |= (1 << b);
    const hookOk = (this.hookSeen && t - this.hookSeen < FRESH_MS) ? 1 : 0;
    const raw = this.hookRawV;
    const conv = raw < 8000 ? raw : -(65535 - raw);
    return { t, cycle: this.scn.cycle, seg: this.scn.seg, sec: this.sec.sec, onl,
             hook: raw, hookConv: conv, hookOk, bins: this.weights.slice() };
  }
}

/* Exactly the string ESP32 publishBins() builds. */
function buildPayload(s) {
  const b = s.bins.map((w, i) => `"B${i + 1}":"${w}"`).join(',');
  return `{${b},"sec":${s.sec},"onl":${s.onl},"hook":${s.hook},"hookConv":${s.hookConv},"hookOk":${s.hookOk}}`;
}

/* ---------------------------------------------------------------------------
 * Crane X position - second topic (default melting_furnace_distance)
 *
 * Same payload the field ESP32 builds in publishDistData()
 * (sketch_pm_Melting_15_05_2026.ino). X/Y are lidar distances in cm. The values
 * are SYNTHETIC: X glides (first-order lag) toward an anchor for the current crane
 * section, so the position follows what the bin/data `sec` field says. The anchors
 * are placeholders - the real geometry is not known here. Edit POS_ANCHOR_CM.
 * ------------------------------------------------------------------------- */
const POS_ANCHOR_CM = [1500, 2200, 2900, 3600];   // sec 0..3 (OUT-left, SEC1, SEC2, OUT-right)
const POS_Y_CM = 480;                             // second axis held roughly constant
const POS_LAG = 0.35;                             // fraction of the gap closed per message
const jit = (n) => Math.round((Math.random() * 2 - 1) * n);

class PosModel {
  constructor() { this.reset(); }
  reset() { this.x = POS_ANCHOR_CM[0]; this.seq = 0; }
  /* manual mode: the typed X/Y go out exactly (strength still wobbles a little) */
  exact(X, Y, upS) {
    this.x = X;
    return `{"X":${X},"XS":${350 + jit(60)},"XV":1,"Y":${Y},"YS":${420 + jit(60)},"YV":1,` +
           `"status":"ok","age_ms":${Math.floor(Math.random() * 120)},"seq":${++this.seq},"up_s":${upS}}`;
  }
  next(sec, upS) {
    this.x += (POS_ANCHOR_CM[sec] - this.x) * POS_LAG;
    const X = Math.round(this.x) + jit(2), Y = POS_Y_CM + jit(2);
    const XS = 350 + jit(60), YS = 420 + jit(60);
    return `{"X":${X},"XS":${XS},"XV":1,"Y":${Y},"YS":${YS},"YV":1,` +
           `"status":"ok","age_ms":${Math.floor(Math.random() * 120)},"seq":${++this.seq},"up_s":${upS}}`;
  }
}

/* ---------------------------------------------------------------------------
 * Minimal MQTT 3.1.1 publisher for an external broker
 * ------------------------------------------------------------------------- */
class MqttPub {
  constructor({ host, port, clientId, username, password }, log) {
    Object.assign(this, { host, port, clientId, username, password, log });
    this.connected = false; this.stopped = false; this.error = null;
    this.sock = null; this.ping = null; this.retry = null;
  }
  start() { this.stopped = false; this._connect(); }
  _connect() {
    if (this.stopped) return;
    const sock = net.connect({ host: this.host, port: this.port });
    this.sock = sock;
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    parser.on('packet', (p) => {
      if (p.cmd === 'connack') {
        if (p.returnCode === 0) {
          this.connected = true; this.error = null;
          this.log(`connected to ${this.host}:${this.port} as ${this.clientId}`);
          this.ping = setInterval(() => this._write({ cmd: 'pingreq' }), 15000);
        } else {
          this.error = `broker refused the connection (code ${p.returnCode})`;
          this.log(this.error); sock.destroy();
        }
      }
    });
    parser.on('error', (e) => { this.error = 'protocol error: ' + e.message; sock.destroy(); });
    sock.on('connect', () => {
      this._write({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clean: true,
                    clientId: this.clientId, keepalive: 30,
                    ...(this.username ? { username: this.username, password: Buffer.from(this.password || '') } : {}) });
    });
    sock.on('data', (d) => parser.parse(d));
    const down = (why) => {
      if (this.sock !== sock) return;
      this.connected = false;
      if (this.ping) { clearInterval(this.ping); this.ping = null; }
      if (why) this.error = why;
      if (!this.stopped) {
        this.log(`disconnected (${this.error || 'closed'}) - retrying in 5 s`);
        this.retry = setTimeout(() => this._connect(), 5000);
      }
    };
    sock.on('error', (e) => down(e.code ? `${e.code} ${e.message}` : e.message));
    sock.on('close', () => down(null));
  }
  _write(pkt) { if (this.sock && !this.sock.destroyed) this.sock.write(mqttPacket.generate(pkt)); }
  publish(topic, payload) {
    if (!this.connected) return false;
    this._write({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false });
    return true;
  }
  stop() {
    this.stopped = true; this.connected = false;
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    if (this.sock && !this.sock.destroyed) { try { this._write({ cmd: 'disconnect' }); } catch (_) {} this.sock.destroy(); }
  }
}

/* ---------------------------------------------------------------------------
 * Controller used by server.js
 * ------------------------------------------------------------------------- */
const PLANT_BROKER = '192.168.96.11';   // production broker: never publish simulated data there
const MAX_LOG = 300;

const ctl = {
  running: false, board: new Board(), timer: null, last: 0, acc: 0, lastPub: 0,
  opts: { mode: 'embedded', host: '', port: 1883, topic: 'bin/data', speed: 1, posTopic: '' },
  pos: new PosModel(), latestPos: null,
  sq: { running: false, name: '', t: 0, cs: null, label: '' },
  /* manual mode: the operator's values replace the scripted cycle (and the section logic) */
  manual: { on: false, sec: 0, bins: [0, 0, 0, 0, 0, 0, 0, 0], onl: 255, hook: 0, hookOk: 1, x: POS_ANCHOR_CM[0], y: POS_Y_CM },
  pub: null, brokerPublish: null,
  seq: 0, sent: 0, dropped: 0, msgs: [], notes: [], latest: null,
};

function ts() { return new Date().toISOString().slice(11, 23); }
function note(s) { ctl.notes.push(`[${ts()}] ${s}`); if (ctl.notes.length > 50) ctl.notes.shift(); console.log(`[${ts()}] binsim: ${s}`); }

function tick() {
  const now = Date.now();
  ctl.acc += (now - ctl.last) * ctl.opts.speed;
  ctl.last = now;
  let guard = 0;
  while (ctl.acc >= 10 && guard++ < 2000) {
    ctl.acc -= 10;
    ctl.board.step();
    if (ctl.sq.running) ctl.sq.t += 10;
    if (ctl.board.t - ctl.lastPub >= 1000) {                // ESP32 cadence: once a second
      ctl.lastPub = ctl.board.t;
      publishNow();
    }
  }
}

/* send one message to the chosen target; returns whether it left (external: broker connected) */
function sendTo(topic, payload) {
  let ok = false;
  if (ctl.opts.mode === 'embedded') {
    ctl.brokerPublish(topic, payload, { retain: false }).catch(() => {});
    ok = true;
  } else if (ctl.pub) {
    ok = ctl.pub.publish(topic, payload);
  }
  ok ? ctl.sent++ : ctl.dropped++;
  ctl.msgs.push({ seq: ++ctl.seq, t: ts(), topic, payload, ok });
  if (ctl.msgs.length > MAX_LOG) ctl.msgs.shift();
  return ok;
}

/* ---------------------------------------------------------------------------
 * Sequences - timed scripts that drive section, X and hook through manual mode
 *
 * Each segment: { ms, label, sec?, x?, hook }
 *   sec   section sent during the segment (kept from the previous segment if omitted)
 *   x     X in cm at the END of the segment (ramps linearly from where the previous ended)
 *   hook  { osc:[lo,hi] }  oscillates between lo and hi in real time
 *         { to: v }        ramps linearly to v by the end of the segment
 *         { hold: true }   stays where it is
 * Bin weights are not touched - set them in the manual card (they keep their values).
 * ------------------------------------------------------------------------- */
const SEQUENCES = {
  seq1: {
    title: 'seq1 - hook oscillates, dips to -4235, settles at 110, crane 1 -> 3, drop to 0',
    start: { sec: 1, x: 1500 },
    segs: [
      { ms: 5000,  label: 'section 1, X 1500 - hook oscillates 100..200', hook: { osc: [100, 200] } },
      { ms: 3000,  label: 'hook goes to -4235',                         hook: { to: -4235 } },
      { ms: 3000,  label: 'hook goes to 110',                           hook: { to: 110 } },
      { ms: 10000, label: 'hook stays at 110 for 10 s',                 hook: { hold: true } },
      { ms: 4000,  label: 'crane moves, section 1',   sec: 1, x: 2000,  hook: { hold: true } },
      { ms: 4000,  label: 'crane moves, section 2',   sec: 2, x: 2500,  hook: { hold: true } },
      { ms: 4000,  label: 'crane moves, section 3',   sec: 3, x: 3000,  hook: { hold: true } },
      { ms: 10000, label: 'section 3, waiting 10 s with 110', hook: { hold: true } },
      { ms: 2000,  label: 'weight drops 110 -> 0',                      hook: { to: 0 } },
    ],
  },
};

SEQUENCES.seq2 = {
  title: 'seq2 - X 2800, hook 0 -> -1100..-300 -> 400 -> 800 -> 710, crane 1 -> 3, drop to 0',
  start: { sec: 1, x: 2800, hook: 0 },
  segs: [
    { ms: 2000, label: 'section 1, X 2800 - hook at 0',                       hook: { hold: true } },
    { ms: 2000, label: 'hook -1100 rising to -300 (2 s)',                     hook: { from: -1100, to: -300 } },
    { ms: 3000, label: 'hook ramps -300 to 400 (3 s)',                        hook: { to: 400 } },
    { ms: 4000, label: 'hook ramps 400 to 800 (4 s)',                         hook: { to: 800 } },
    { ms: 1000, label: 'hook settles at 710',                                 hook: { to: 710 } },
    { ms: 4000, label: 'crane moves, section 1',  sec: 1, x: 3000,            hook: { hold: true } },
    { ms: 4000, label: 'crane moves, section 2',  sec: 2, x: 3200,            hook: { hold: true } },
    { ms: 4000, label: 'crane moves, section 3',  sec: 3, x: 3400,            hook: { hold: true } },
    { ms: 3000, label: 'section 3 - weight drops 710 -> 0 (3 s)',             hook: { to: 0 } },
  ],
};

/* seq1's hook pattern, but: starts at 0, starts in section 3 at X 2100, crane moves 3 -> 2 -> 1 */
SEQUENCES.seq3 = {
  title: 'seq3 - like seq1 but hook starts at 0, X 2100, crane moves section 3 -> 1',
  start: { sec: 3, x: 2100, hook: 0 },
  segs: [
    { ms: 2000,  label: 'section 3, X 2100 - hook at 0',                    hook: { hold: true } },
    { ms: 5000,  label: 'hook oscillates 100..200',                         hook: { osc: [100, 200] } },
    { ms: 3000,  label: 'hook goes to -4235',                               hook: { to: -4235 } },
    { ms: 3000,  label: 'hook goes to 110',                                 hook: { to: 110 } },
    { ms: 10000, label: 'hook stays at 110 for 10 s',                       hook: { hold: true } },
    { ms: 4000,  label: 'crane moves, section 3',  sec: 3, x: 1600,         hook: { hold: true } },
    { ms: 4000,  label: 'crane moves, section 2',  sec: 2, x: 1100,         hook: { hold: true } },
    { ms: 4000,  label: 'crane moves, section 1',  sec: 1, x: 600,          hook: { hold: true } },
    { ms: 10000, label: 'section 1, waiting 10 s with 110',                 hook: { hold: true } },
    { ms: 2000,  label: 'weight drops 110 -> 0',                            hook: { to: 0 } },
  ],
};

/* hook 0 while crane goes 3 -> 1 (ends at X 1550), then 0->200, -1000..-200, -200->170, wait, crane 1 -> 3, drop to 0 */
SEQUENCES.seq4 = {
  title: 'seq4 - hook 0, crane 3 -> 1 (X 1550), 0->200, -1000..-200, ->170, wait, crane 1 -> 3, drop to 0',
  start: { sec: 3, x: 2800, hook: 0 },
  segs: [
    { ms: 4000, label: 'hook 0 - crane moves, section 3',  sec: 3, x: 2400, hook: { hold: true } },
    { ms: 4000, label: 'hook 0 - crane moves, section 2',  sec: 2, x: 2000, hook: { hold: true } },
    { ms: 4000, label: 'hook 0 - crane arrives section 1, X 1550', sec: 1, x: 1550, hook: { hold: true } },
    { ms: 3000, label: 'arrived at X 1550 - waiting 3 s, hook 0',          hook: { hold: true } },
    { ms: 2000, label: 'hook rises 0 -> 200 (2 s)',                          hook: { to: 200 } },
    { ms: 5000, label: 'hook -1000 rising to -200 (5 s)',                    hook: { from: -1000, to: -200 } },
    { ms: 5000, label: 'hook -200 -> 170 (5 s)',                             hook: { to: 170 } },
    { ms: 2000, label: 'wait 2 s at 170',                                    hook: { hold: true } },
    { ms: 4000, label: 'crane moves, section 1',  sec: 1, x: 2000,           hook: { hold: true } },
    { ms: 4000, label: 'crane moves, section 2',  sec: 2, x: 2400,           hook: { hold: true } },
    { ms: 4000, label: 'crane arrives section 3',  sec: 3, x: 2800,          hook: { hold: true } },
    { ms: 2000, label: 'section 3 - weight drops 170 -> 0 (2 s)',            hook: { to: 0 } },
  ],
};

/* smooth, bounded wobble in [lo,hi]: two sines so 1 Hz samples do not look periodic */
function oscAt(lo, hi, tMs) {
  const t = tMs / 1000;
  const u = 0.6 * Math.sin(2 * Math.PI * t / 2.3) + 0.4 * Math.sin(2 * Math.PI * t / 0.9 + 1);   // -1..1
  return Math.round(lo + (hi - lo) * (0.5 + 0.5 * u));
}

function compileSeq(def) {
  let t = 0, sec = def.start.sec, x = def.start.x, hook = def.start.hook || 0;
  const out = def.segs.map((s) => {
    const c = { label: s.label, t0: t, t1: t + s.ms, sec: s.sec !== undefined ? s.sec : sec, x0: x, x1: s.x !== undefined ? s.x : x, h: s.hook,
                h0: s.hook.from !== undefined ? s.hook.from : hook };    // `from` = jump to this value at the segment start
    c.hEnd = s.hook.osc ? oscAt(s.hook.osc[0], s.hook.osc[1], s.ms) : s.hook.to !== undefined ? s.hook.to : c.h0;
    t = c.t1; sec = c.sec; x = c.x1; hook = c.hEnd;
    return c;
  });
  return { segs: out, total: t };
}

function evalSeq(cs, tMs) {
  const seg = cs.segs.find((s) => tMs < s.t1) || cs.segs[cs.segs.length - 1];
  const done = tMs >= cs.total;
  const f = done ? 1 : (tMs - seg.t0) / (seg.t1 - seg.t0);
  const lerp = (a, b) => Math.round(a + (b - a) * f);
  let hook;
  if (seg.h.osc) hook = done ? seg.hEnd : oscAt(seg.h.osc[0], seg.h.osc[1], tMs - seg.t0);
  else if (seg.h.to !== undefined) hook = lerp(seg.h0, seg.h.to);
  else hook = seg.h0;
  return { sec: seg.sec, x: lerp(seg.x0, seg.x1), hook, label: seg.label, done };
}

/* hook as the ESP32 sees it: negative values travel as 65535 + value (see Board.snapshot) */
const hookRaw = (conv) => (conv < 0 ? 65535 + conv : conv);

function manualSnap() {
  const m = ctl.manual, base = ctl.board.snapshot();
  return { t: base.t, cycle: base.cycle, seg: base.seg, sec: m.sec, onl: m.onl, hook: hookRaw(m.hook),
           hookConv: m.hook, hookOk: m.hookOk, bins: m.bins.slice() };
}

/* push the sequence's values at its current time into the manual fields */
function applySeq() {
  const q = ctl.sq;
  const v = evalSeq(q.cs, q.t);
  if (!ctl.manual.on) setManual({ on: true });
  ctl.manual.sec = v.sec; ctl.manual.x = v.x; ctl.manual.hook = v.hook;
  q.label = v.label;
  if (v.done) { q.running = false; note(`sequence ${q.name} finished - holding the last values in manual mode`); }
}

function runSeq(name) {
  const def = SEQUENCES[name];
  if (!def) throw new Error(`unknown sequence "${name}"`);
  if (!ctl.running) throw new Error('press Start first - sequences publish through the running publisher');
  ctl.sq = { running: true, name, t: 0, cs: compileSeq(def), label: '' };
  applySeq();
  note(`sequence ${name} started (${(ctl.sq.cs.total / 1000).toFixed(0)} s)`);
}

function stopSeq() {
  if (ctl.sq.running) { ctl.sq.running = false; note(`sequence ${ctl.sq.name} stopped - manual mode keeps the current values`); }
}

function publishNow() {
  if (ctl.sq.running) applySeq();
  const man = ctl.manual.on;
  const snap = man ? manualSnap() : ctl.board.snapshot();
  const payload = buildPayload(snap);
  const ok = sendTo(ctl.opts.topic, payload);
  ctl.latest = { snap, payload, ok };
  if (ctl.opts.posTopic) {
    const pp = man ? ctl.pos.exact(ctl.manual.x, ctl.manual.y, Math.floor(snap.t / 1000))
                   : ctl.pos.next(snap.sec, Math.floor(snap.t / 1000));
    sendTo(ctl.opts.posTopic, pp);
    ctl.latestPos = pp;
  }
}

/* Update manual mode. `patch` may hold: on, sec, bins (array of 8 or {i,w}), onl, hook, hookOk, x, y.
 * Turning manual ON starts from whatever the cycle is showing right now. */
function setManual(patch = {}) {
  const m = ctl.manual;
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
  if (patch.on !== undefined) {
    const on = !!patch.on;
    if (on && !m.on) {
      const s = (ctl.latest ? ctl.latest.snap : ctl.board.snapshot());
      m.sec = s.sec; m.bins = s.bins.slice(); m.onl = s.onl; m.hook = s.hookConv; m.hookOk = s.hookOk;
      m.x = ctl.pos.x; m.y = POS_Y_CM;
    }
    if (!on) stopSeq();
    if (m.on !== on) note(on ? 'MANUAL mode on - script paused' : 'manual mode off - script resumed');
    m.on = on;
  }
  if (patch.sec !== undefined) m.sec = clampInt(patch.sec, 0, 3);
  if (Array.isArray(patch.bins)) m.bins = patch.bins.slice(0, 8).map((w) => clampInt(w, 0, 99999));
  if (patch.bin && Number.isInteger(patch.bin.i) && patch.bin.i >= 0 && patch.bin.i < 8) m.bins[patch.bin.i] = clampInt(patch.bin.w, 0, 99999);
  if (patch.onl !== undefined) m.onl = clampInt(patch.onl, 0, 255);
  if (patch.hook !== undefined) m.hook = clampInt(patch.hook, -7999, 7999);   // keeps raw<8000 / raw>=8000 sign convention valid
  if (patch.hookOk !== undefined) m.hookOk = patch.hookOk ? 1 : 0;
  if (patch.x !== undefined) m.x = clampInt(patch.x, 0, 65535);
  if (patch.y !== undefined) m.y = clampInt(patch.y, 0, 65535);
  return { ...m, bins: m.bins.slice() };
}

function start(opts, brokerPublish) {
  const o = {
    mode: opts.mode === 'external' ? 'external' : 'embedded',
    host: String(opts.host || '').trim(),
    port: Number(opts.port) || 1883,
    topic: String(opts.topic || 'bin/data').trim() || 'bin/data',
    speed: Math.max(1, Math.min(10, Math.round(Number(opts.speed) || 1))),
    posTopic: String(opts.posTopic || '').trim(),
    username: opts.username ? String(opts.username) : '',
    password: opts.password ? String(opts.password) : '',
  };
  if (o.mode === 'external') {
    if (!o.host) throw new Error('external mode needs a broker host');
    if (o.host === PLANT_BROKER && !process.env.ALLOW_PLANT) {
      throw new Error(`${PLANT_BROKER} is the PLANT broker. Simulated data must not go there ` +
                      '(set ALLOW_PLANT=1 before starting IotBench if you really mean it).');
    }
  }
  stop(true);
  ctl.opts = o; ctl.brokerPublish = brokerPublish;
  ctl.board.reset(); ctl.acc = 0; ctl.lastPub = 0; ctl.pos.reset();
  ctl.seq = 0; ctl.sent = 0; ctl.dropped = 0; ctl.msgs = []; ctl.latest = null; ctl.latestPos = null;
  if (o.mode === 'external') {
    ctl.pub = new MqttPub({ host: o.host, port: o.port, clientId: `IotBench-binsim-${Math.random().toString(16).slice(2, 8)}`,
                            username: o.username, password: o.password }, note);
    ctl.pub.start();
  }
  ctl.last = Date.now();
  ctl.timer = setInterval(tick, 10);
  ctl.running = true;
  note(`started: ${o.mode}${o.mode === 'external' ? ` ${o.host}:${o.port}` : ''} topic=${o.topic}${o.posTopic ? ` position=${o.posTopic}` : ''} speed=x${o.speed}`);
}

function stop(quiet) {
  ctl.sq.running = false;
  if (ctl.timer) { clearInterval(ctl.timer); ctl.timer = null; }
  if (ctl.pub) { ctl.pub.stop(); ctl.pub = null; }
  if (ctl.running && !quiet) note('stopped');
  ctl.running = false;
}

function restartCycle() { ctl.board.reset(); ctl.acc = 0; ctl.lastPub = 0; ctl.pos.reset(); note('cycle restarted'); }

function getStatus(since = 0) {
  const snap = ctl.latest ? ctl.latest.snap : ctl.board.snapshot();
  return {
    running: ctl.running,
    opts: { mode: ctl.opts.mode, host: ctl.opts.host, port: ctl.opts.port, topic: ctl.opts.topic, speed: ctl.opts.speed, posTopic: ctl.opts.posTopic },
    link: ctl.opts.mode === 'embedded'
      ? { connected: true, error: null }
      : { connected: !!(ctl.pub && ctl.pub.connected), error: ctl.pub ? ctl.pub.error : null },
    sent: ctl.sent, dropped: ctl.dropped,
    cycleMs: CYCLE_MS, tInCycleMs: ctl.board.t % CYCLE_MS,
    state: snap,
    payload: ctl.latest ? ctl.latest.payload : null,
    posPayload: ctl.latestPos,
    manual: { ...ctl.manual, bins: ctl.manual.bins.slice() },
    seq: { running: ctl.sq.running, name: ctl.sq.name, label: ctl.sq.label, t: ctl.sq.t,
           total: ctl.sq.cs ? ctl.sq.cs.total : 0,
           available: Object.keys(SEQUENCES).map((k) => ({ name: k, title: SEQUENCES[k].title })) },
    notes: ctl.notes.slice(-8),
    messages: ctl.msgs.filter((m) => m.seq > since),
  };
}

module.exports = { start, stop, restartCycle, getStatus, setManual, runSeq, stopSeq, SEQUENCES, compileSeq, evalSeq,
                   /* exposed for test-binsim.js */
                   Board, buildPayload, PosModel, POS_ANCHOR_CM, SCRIPT, CYCLE_MS, TARGET };
