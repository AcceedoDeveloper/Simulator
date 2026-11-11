/* ============================================================================
 * IotBench - charge-mix bin board simulator (topics default to the plant's, editable on the page)
 *
 * Plays either end of the melting server <-> bin board conversation, so each side
 * can be tested without the other:
 *
 *   software - acts as the melting server. Saving a charge mix or a spectrum stage
 *              publishes `charge`, the Open / Close / Finished buttons publish
 *              `open`, `close`, `done`, and the board's `took` readings are turned
 *              into Qty Taken (weight when the bin opened - weight now), saved on
 *              the heat when the bin closes.
 *   board    - acts as the bin machine. It opens bins on `charge` / `open`, closes
 *              them on `close` / `done`, and while a bin stands open sends its
 *              weight once a second as `took`. The weight falls by itself (auto
 *              take) or as the operator steps it; the machine's own buttons publish
 *              `open`, `close`, `done`.
 *
 * Messages follow docs/bin-board-protocol.md in the melting server: kilograms,
 * QoS 1, retain off, every message has a `cmd`, unknown cmds are ignored.
 *
 * Bin weights also travel on their own topic - the ESP32's feed of
 * every bin's scale, once a second, in grams as strings:
 *   {"B1":"89260","B2":"0",...,"B8":"0","sec":0,"onl":125,"hook":0,"hookConv":0,"hookOk":0}
 * The board publishes it; the software reads B<n> as bin n's weight (kg = g / 1000)
 * and ignores sec, onl and the hook fields.
 *
 * Targets
 *   embedded - this IotBench's own broker (:1883), connected to over TCP like any
 *              other client, so the traffic also shows on /mqtt
 *   external - any MQTT 3.1.1 broker, with the host, port and credentials typed on
 *              the page. Plain TCP only (no TLS).
 * ========================================================================== */

'use strict';
const net = require('net');
const EventEmitter = require('events');
const mqttPacket = require('mqtt-packet');

const PLANT_BROKER = '192.168.96.11';   // production broker: refused unless ALLOW_PLANT=1
const MAX_LOG = 600;
const ACK_TIMEOUT_MS = 5000;

const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
function ts() { return new Date().toISOString().slice(11, 23); }

/* ---------------------------------------------------------------------------
 * Minimal MQTT 3.1.1 client: QoS 1 publish (resolves on PUBACK) and subscribe
 * ------------------------------------------------------------------------- */
class MqttLink extends EventEmitter {
  constructor({ host, port, clientId, username, password }, log) {
    super();
    Object.assign(this, { host, port, clientId, username, password, log });
    this.connected = false; this.stopped = false; this.error = null;
    this.sock = null; this.ping = null; this.retry = null;
    this.topics = []; this.nextId = 0; this.pending = new Map();
  }
  start() { this.stopped = false; this._connect(); }
  subscribe(topic) { if (!this.topics.includes(topic)) this.topics.push(topic); }
  _id() { this.nextId = (this.nextId % 65535) + 1; return this.nextId; }
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
          if (this.topics.length) {
            this._write({ cmd: 'subscribe', messageId: this._id(),
                          subscriptions: this.topics.map((topic) => ({ topic, qos: 1 })) });
          }
          this.emit('state');
        } else {
          const why = { 1: 'bad protocol version', 2: 'client id rejected', 3: 'server unavailable',
                        4: 'bad username or password', 5: 'not authorised' }[p.returnCode] || 'refused';
          this.error = `broker refused the connection (code ${p.returnCode}: ${why})`;
          this.log(this.error); sock.destroy();
        }
      } else if (p.cmd === 'suback') {
        const bad = (p.granted || []).some((g) => g === 128);
        this.log(bad ? `subscription refused for ${this.topics.join(', ')}` : `subscribed to ${this.topics.join(', ')}`);
      } else if (p.cmd === 'puback') {
        const w = this.pending.get(p.messageId);
        if (w) { clearTimeout(w.timer); this.pending.delete(p.messageId); w.resolve(true); }
      } else if (p.cmd === 'publish') {
        if (p.qos === 1) this._write({ cmd: 'puback', messageId: p.messageId });
        else if (p.qos === 2) this._write({ cmd: 'pubrec', messageId: p.messageId });
        this.emit('message', p.topic, p.payload ? p.payload.toString() : '');
      } else if (p.cmd === 'pubrel') {
        this._write({ cmd: 'pubcomp', messageId: p.messageId });
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
      const was = this.connected;
      this.connected = false;
      if (this.ping) { clearInterval(this.ping); this.ping = null; }
      for (const w of this.pending.values()) { clearTimeout(w.timer); w.resolve(false); }
      this.pending.clear();
      if (why) this.error = why;
      if (!this.stopped) {
        if (was || why) this.log(`disconnected (${this.error || 'closed'}) - retrying in 5 s`);
        this.retry = setTimeout(() => this._connect(), 5000);
      }
      this.emit('state');
    };
    sock.on('error', (e) => down(e.code ? `${e.code} ${e.message}` : e.message));
    sock.on('close', () => down(null));
  }
  _write(pkt) { if (this.sock && !this.sock.destroyed) this.sock.write(mqttPacket.generate(pkt)); }
  /* QoS 1: resolves true on PUBACK, false on timeout / not connected */
  publish(topic, payload) {
    if (!this.connected) return Promise.resolve(false);
    const messageId = this._id();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(messageId); resolve(false); }, ACK_TIMEOUT_MS);
      this.pending.set(messageId, { resolve, timer });
      this._write({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 1, messageId, retain: false, dup: false });
    });
  }
  /* QoS 0, fire and forget - how the ESP32 publishes its bin weights */
  publish0(topic, payload) {
    if (!this.connected) return false;
    this._write({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false });
    return true;
  }
  stop() {
    this.stopped = true; this.connected = false;
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    for (const w of this.pending.values()) { clearTimeout(w.timer); w.resolve(false); }
    this.pending.clear();
    if (this.sock && !this.sock.destroyed) { try { this._write({ cmd: 'disconnect' }); } catch (_) {} this.sock.destroy(); }
  }
}

/* ---------------------------------------------------------------------------
 * The bins both roles share. In software mode `weight` is the stock the server
 * holds for the bin; in board mode it is what the bin's scale reads.
 * ------------------------------------------------------------------------- */
const DEFAULT_BINS = [
  { bin: 1, el: 'Cu', material: 'Copper', weight: 10000 },
  { bin: 2, el: 'Sn', material: 'Tin', weight: 10000 },
  { bin: 3, el: 'Si', material: 'Ferro Silicon', weight: 10000 },
  { bin: 4, el: 'P', material: 'Ferro Phosphorous', weight: 10000 },
  { bin: 5, el: 'Cr', material: 'Ferro Chrome', weight: 10000 },
  { bin: 6, el: 'Mn', material: 'Ferro Manganese', weight: 10000 },
  { bin: 7, el: 'S', material: 'Iron Sulphide', weight: 10000 },
  { bin: 8, el: 'C', material: 'Carbon Raiser', weight: 10000 },
];

function freshBin(b) {
  return { bin: Number(b.bin), el: String(b.el || ''), material: String(b.material || ''),
           weight: round3(num(b.weight) ?? 0),
           open: false, need: null, manual: false, furnace: null, heat: null, stage: null,
           startWeight: null, lastWeight: null, taken: null, weightAt: null };
}

/* bin weights: B<n> -> grams (string or number). Everything else (sec, onl, hook...) is ignored. */
function binWeightsOf(json) {
  const out = [];
  for (const [k, v] of Object.entries(json || {})) {
    const m = /^B(\d+)$/i.exec(k);
    if (!m) continue;
    const g = num(v);
    if (g !== null) out.push({ bin: Number(m[1]), kg: round3(g / 1000) });
  }
  return out;
}

/* `took` carries one bin or a `bins` list; qty is kg unless "unit":"g" */
function readingsOf(json) {
  const grams = String(json.unit || '').toLowerCase() === 'g';
  const list = Array.isArray(json.bins) ? json.bins : [json];
  return list
    .map((r) => ({ bin: num(r.bin), el: r.el, qty: num(r.qty) }))
    .filter((r) => r.bin !== null && r.qty !== null)
    .map((r) => ({ ...r, qty: grams ? r.qty / 1000 : r.qty }));
}

function createBinBoard({ embeddedPort = 1883 } = {}) {
  const st = {
    role: null,
    conn: { target: 'external', host: 'broker.mqtt.cool', port: 1883, username: '', password: '', clientId: '',
            requestTopic: 'melting/software/set-weights', replyTopic: 'bin/chargemix/reply', dataTopic: 'melting/board1/weights' },
    link: null,
    bins: DEFAULT_BINS.map(freshBin),
    log: [], seq: 0, rev: 0,
    /* software: the request now standing, the heat each furnace is on, Qty Taken saved */
    sw: { current: null, heatOf: {}, saved: [], takes: [] },
    /* board: how the auto take behaves, and the furnace a hand-opened bin reports */
    bd: { autoTake: true, rate: 1, overshoot: 0, combined: true, unit: 'kg', furnace: '1', sending: true,
          sendData: true },
    timer: null,
    repeat: null,      // testing only: the charge being re-sent by Continuous send
    sim: null,         // testing only: the charge -> done -> charge loop of Simulation
  };

  const touch = () => { st.rev++; };
  function entry(e) {
    const x = { seq: ++st.seq, t: ts(), ...e };
    st.log.push(x);
    if (st.log.length > MAX_LOG) st.log.shift();
    touch();
    return x;
  }
  const note = (text, level = 'info') => { entry({ dir: 'note', level, text }); console.log(`[${ts()}] binboard: ${text}`); };
  const binOf = (n) => st.bins.find((b) => b.bin === Number(n));

  /* publish one message, logging it and, when it comes, the broker's PUBACK */
  async function send(topic, obj, { qos0 = false } = {}) {
    const payload = JSON.stringify(obj);
    const e = entry({ dir: 'out', topic, payload, ack: null, ...(qos0 ? { qos0: true } : {}) });
    if (!st.link || !st.link.connected) {
      e.ack = false; e.text = 'not connected - not sent'; touch();
      return false;
    }
    if (qos0) { e.ack = st.link.publish0(topic, payload); touch(); return e.ack; }
    const ok = await st.link.publish(topic, payload);
    e.ack = ok; if (!ok) e.text = 'no PUBACK within 5 s'; touch();
    return ok;
  }

  /* ------------------------------------------------------------- software */

  /* What a bin has given: weight when it opened less its latest reading */
  const takenOf = (b) => (b.startWeight !== null && b.lastWeight !== null
    ? Math.max(0, round3(b.startWeight - b.lastWeight)) : null);

  /* Save a closing bin's take on its heat, as the server does: a request bin sets
   * its stage's figure, a hand-opened bin adds onto the heat's latest stage. */
  function settle(b, why) {
    const taken = takenOf(b);
    if (taken !== null) {
      const row = {
        at: new Date().toISOString(), bin: b.bin, el: b.el, material: b.material,
        need: b.need, taken, over: b.need !== null && taken > b.need,
        furnace: b.furnace, heat: b.heat, stage: b.stage, manual: b.manual, why,
      };
      st.sw.takes.unshift(row);
      if (st.sw.takes.length > 200) st.sw.takes.pop();
      if (b.heat) {
        const where = b.manual ? (st.sw.heatOf[b.furnace]?.stage ?? null) : b.stage;
        const label = where || 'Charge mix';
        let slot = st.sw.saved.find((s) => s.heat === b.heat && s.label === label && s.el === b.el);
        if (!slot) {
          slot = { heat: b.heat, furnace: b.furnace, label, el: b.el, bin: b.bin, need: null, qtyTaken: 0 };
          st.sw.saved.push(slot);
        }
        if (!b.manual && b.need !== null) slot.need = b.need;
        slot.qtyTaken = round3(b.manual ? slot.qtyTaken + taken : taken);
        note(`bin ${b.bin} ${b.el} closed (${why}): ${taken} kg taken -> heat ${b.heat}, ${label}` +
             `${b.manual ? ' (added on top)' : ''}${row.over ? ' - MORE than the ' + b.need + ' kg asked' : ''}`,
             row.over ? 'warn' : 'info');
      } else {
        note(`bin ${b.bin} ${b.el} closed (${why}): ${taken} kg taken - no furnace on its readings, only the stock changes`, 'warn');
      }
      b.weight = b.lastWeight;
    } else {
      note(`bin ${b.bin} ${b.el} closed (${why}) - no reading came, nothing taken`);
    }
    Object.assign(b, { open: false, need: null, manual: false, furnace: null, heat: null, stage: null,
                       startWeight: null, lastWeight: null, taken: null });
    touch();
  }

  /* Charge mix saved, or a spectrum stage: open what it asks for */
  async function swCharge({ furnace, heat, stage, bins }) {
    const f = num(furnace);
    if (f === null) throw new Error('furnace number is needed');
    if (!String(heat || '').trim()) throw new Error('heat number is needed');
    const rows = (bins || []).map((r) => ({ bin: num(r.bin), need: num(r.need) })).filter((r) => r.bin !== null && r.need !== null);
    // Every row is sent as typed, 0 included, so the board can be tested with any need.
    const negative = rows.filter((r) => r.need < 0);
    if (negative.length) throw new Error(`a need cannot be below 0 (${negative.map((r) => `B${r.bin} ${r.need}`).join(', ')})`);
    const wanted = rows;
    if (!wanted.length) throw new Error('add at least one bin');
    for (const r of wanted) if (!binOf(r.bin)) throw new Error(`there is no bin ${r.bin}`);

    // The standing request is replaced: its bins are settled, and the ones the
    // new request does not want get their own close first.
    const wantedNos = wanted.map((r) => r.bin);
    for (const b of st.bins.filter((x) => x.open && !x.manual)) {
      if (!wantedNos.includes(b.bin)) {
        await send(st.conn.requestTopic, { cmd: 'close', bin: b.bin });
        settle(b, 'superseded');
      } else {
        settle(b, 'superseded - asked again');
      }
    }

    const msg = { cmd: 'charge', furnace: f, heat: String(heat).trim(),
                  ...(stage ? { stage: String(stage) } : {}),
                  bins: wanted.map((r) => ({ bin: r.bin, el: binOf(r.bin).el, need: round3(r.need) })) };
    const acked = await send(st.conn.requestTopic, msg);
    for (const r of wanted) {
      const b = binOf(r.bin);
      Object.assign(b, { open: true, need: round3(r.need), manual: false, furnace: f, heat: msg.heat,
                         stage: stage || null, startWeight: b.weight > 0 ? b.weight : null, lastWeight: null, taken: null });
    }
    st.sw.current = { furnace: f, heat: msg.heat, stage: stage || null };
    st.sw.heatOf[f] = { heat: msg.heat, stage: stage || null };
    note(acked
      ? `broker acknowledged - bins ${wantedNos.join(', ')} opened for heat ${msg.heat}${stage ? ' ' + stage : ''}`
      : `sent without a broker acknowledgement - treating bins ${wantedNos.join(', ')} as open`, acked ? 'info' : 'warn');
    touch();
    return msg;
  }

  /* TESTING ONLY - "Continuous send": the charge (or stage) is saved once as usual,
   * then the very same message is published again every `every` seconds until
   * Finished (or Stop). The repeats only publish: they open, settle and save
   * nothing, so the rest of the software logic is untouched. Remove with the buttons. */
  function stopRepeat(why) {
    if (!st.repeat) return;
    clearInterval(st.repeat.timer);
    note(`continuous send stopped (${why}) after ${st.repeat.count} message(s)`);
    st.repeat = null;
    touch();
  }
  async function swRepeat(body) {
    stopRepeat('replaced');
    const every = Math.max(0.2, num(body.every) ?? 1);
    const msg = await swCharge(body);
    const r = { msg, every, count: 1, kind: msg.stage ? `stage ${msg.stage}` : 'charge mix', timer: null };
    r.timer = setInterval(() => {
      if (!st.link || !st.link.connected) return;
      r.count++;
      send(st.conn.requestTopic, msg);
      touch();
    }, every * 1000);
    st.repeat = r;
    note(`continuous send: ${r.kind} every ${every} s until Finished`);
  }

  /* TESTING ONLY - "Simulation": charge mix for bins 1..6, then after `chargeSec`
   * Finished (done), then after `waitSec` the charge again - round and round until
   * Stop. Each step is the ordinary swCharge / swDone, so the settling and saving
   * work as when the buttons are pressed by hand. */
  function stopSim(why) {
    if (!st.sim) return;
    clearTimeout(st.sim.timer);
    note(`simulation stopped (${why}) after ${st.sim.cycles} cycle(s)`);
    st.sim = null;
    touch();
  }
  async function swSim(body) {
    stopSim('restarted');
    const f = num(body.furnace);
    if (f === null) throw new Error('furnace number is needed');
    const heat = String(body.heat || '').trim();
    if (!heat) throw new Error('heat number is needed');
    const need = num(body.need);
    if (need === null || need < 0) throw new Error('need must be a number from 0');
    const chargeSec = Math.max(1, num(body.chargeSec) ?? 25);
    const waitSec = Math.max(1, num(body.waitSec) ?? 5);
    const bins = st.bins.filter((b) => b.bin >= 1 && b.bin <= 6).map((b) => ({ bin: b.bin, need }));
    if (!bins.length) throw new Error('the bin table has none of bins 1..6');

    const sim = { furnace: f, heat, need, chargeSec, waitSec, cycles: 0, phase: null, nextAt: 0, timer: null };
    st.sim = sim;
    const live = () => st.sim === sim;
    const later = (sec, fn) => { sim.nextAt = Date.now() + sec * 1000; sim.timer = setTimeout(fn, sec * 1000); touch(); };
    const charge = async () => {
      if (!live()) return;
      sim.cycles++; sim.phase = 'charge';
      try { await swCharge({ furnace: f, heat, bins }); }
      catch (e) { note(`simulation: charge failed - ${e.message}`, 'warn'); }
      if (live()) later(chargeSec, finish);
    };
    const finish = async () => {
      if (!live()) return;
      sim.phase = 'done';
      try { await send(st.conn.requestTopic, { cmd: 'done' }); }
      catch (e) { note(`simulation: done failed - ${e.message}`, 'warn'); }
      const open = st.bins.filter((b) => b.open);
      open.forEach((b) => settle(b, 'Finished (simulation)'));
      if (live()) later(waitSec, charge);
    };
    note(`simulation: charge bins ${bins.map((b) => b.bin).join(', ')} (${need} kg each), done after ${chargeSec} s, ` +
         `charge again ${waitSec} s later - until Stop`);
    await charge();
  }

  async function swOpen(n) {
    const b = binOf(n);
    if (!b) throw new Error(`there is no bin ${n}`);
    if (b.open) throw new Error(`bin ${n} is already open`);
    const acked = await send(st.conn.requestTopic, { cmd: 'open', bin: b.bin, el: b.el, material: b.material });
    openByHand(b);
    note(`bin ${b.bin} opened by hand${acked ? ' (acknowledged)' : ' - no acknowledgement'}; its readings go to the furnace they name`);
  }
  function openByHand(b) {
    Object.assign(b, { open: true, need: null, manual: true, furnace: null, heat: null, stage: null,
                       startWeight: b.weight > 0 ? b.weight : null, lastWeight: null, taken: null });
    touch();
  }
  async function swClose(n) {
    const b = binOf(n);
    if (!b || !b.open) throw new Error(`bin ${n} is not open`);
    await send(st.conn.requestTopic, { cmd: 'close', bin: b.bin });
    settle(b, 'closed from the software');
  }
  async function swDone() {
    stopRepeat('Finished');
    await send(st.conn.requestTopic, { cmd: 'done' });
    const open = st.bins.filter((b) => b.open);
    open.forEach((b) => settle(b, 'Finished'));
    if (!open.length) note('Finished - no bin was open');
  }

  function swReceive(json) {
    const cmd = String(json.cmd || '').toLowerCase();
    if (cmd === 'took') {
      const f = num(json.furnace);
      for (const r of readingsOf(json)) {
        const b = binOf(r.bin);
        if (!b) { note(`took for bin ${r.bin} - no such bin, ignored`, 'warn'); continue; }
        if (!b.open) { note(`took for bin ${r.bin} while it is shut - ignored`, 'warn'); continue; }
        if (b.manual && !b.heat && f !== null && st.sw.heatOf[f]) {
          Object.assign(b, { furnace: f, heat: st.sw.heatOf[f].heat });
          note(`bin ${b.bin} (opened by hand) tied to furnace ${f}, heat ${b.heat}`);
        }
        if (!b.manual && f !== null && b.furnace !== null && f !== b.furnace) {
          note(`took for bin ${b.bin} names furnace ${f}, but it is open for furnace ${b.furnace} - ignored`, 'warn');
          continue;
        }
        if (b.startWeight === null) b.startWeight = r.qty;   // first reading is the start
        b.lastWeight = round3(r.qty);
        b.taken = takenOf(b);
      }
      touch();
    } else if (cmd === 'open') {
      const b = binOf(json.bin);
      if (!b) return note(`open for bin ${json.bin} - no such bin`, 'warn');
      if (b.open) return note(`board opened bin ${b.bin} - already open`);
      openByHand(b);
      note(`board button: bin ${b.bin} opened`);
    } else if (cmd === 'close') {
      const b = binOf(json.bin);
      if (!b || !b.open) return note(`board closed bin ${json.bin} - it was not open`);
      settle(b, 'closed on the machine');
    } else if (cmd === 'done') {
      const open = st.bins.filter((b) => b.open);
      open.forEach((b) => settle(b, 'done on the machine'));
      if (!open.length) note('board sent done - no bin was open');
    } else {
      note(`cmd "${json.cmd}" is not one the software knows - ignored`);
    }
  }

  /* ---------------------------------------------------------------- board */

  function bdReceive(json) {
    const cmd = String(json.cmd || '').toLowerCase();
    if (cmd === 'charge') {
      const grams = String(json.unit || '').toLowerCase() === 'g';
      const opened = [];
      for (const r of Array.isArray(json.bins) ? json.bins : []) {
        const b = binOf(r.bin);
        if (!b) { note(`charge asks for bin ${r.bin} - this board has no such bin`, 'warn'); continue; }
        const need = num(r.need);
        Object.assign(b, { open: true, need: need === null ? null : round3(grams ? need / 1000 : need), manual: false,
                           furnace: num(json.furnace), heat: json.heat ?? null, stage: json.stage ?? null,
                           startWeight: b.weight, lastWeight: b.weight, taken: 0 });
        if (r.el && b.el && String(r.el) !== b.el) note(`bin ${b.bin}: asked for ${r.el}, the bin holds ${b.el}`, 'warn');
        opened.push(b.bin);
      }
      note(`charge for furnace ${json.furnace}, heat ${json.heat}${json.stage ? ' ' + json.stage : ''} - opened bins ${opened.join(', ') || 'none'}`);
    } else if (cmd === 'open') {
      const b = binOf(json.bin);
      if (!b) return note(`open for bin ${json.bin} - no such bin`, 'warn');
      bdOpenLocal(b);
      note(`software opened bin ${b.bin} by hand`);
    } else if (cmd === 'close') {
      const b = binOf(json.bin);
      if (!b) return note(`close for bin ${json.bin} - no such bin`, 'warn');
      bdCloseLocal(b);
      note(`software closed bin ${b.bin}`);
    } else if (cmd === 'done') {
      st.bins.filter((b) => b.open).forEach(bdCloseLocal);
      note('software sent done - every bin closed');
    } else {
      note(`cmd "${json.cmd}" is not one the board knows - ignored`);
    }
    touch();
  }
  function bdOpenLocal(b) {
    Object.assign(b, { open: true, need: null, manual: true, furnace: null, heat: null, stage: null,
                       startWeight: b.weight, lastWeight: b.weight, taken: 0 });
  }
  function bdCloseLocal(b) {
    Object.assign(b, { open: false, need: null, manual: false, furnace: null, heat: null, stage: null,
                       startWeight: null, lastWeight: null, taken: null });
  }
  async function bdButton(action, n) {
    if (action === 'done') {
      st.bins.filter((b) => b.open).forEach(bdCloseLocal); touch();
      await send(st.conn.replyTopic, { cmd: 'done' });
      return;
    }
    const b = binOf(n);
    if (!b) throw new Error(`there is no bin ${n}`);
    if (action === 'open') {
      if (b.open) throw new Error(`bin ${n} is already open`);
      bdOpenLocal(b); touch();
      await send(st.conn.replyTopic, { cmd: 'open', bin: b.bin });
    } else {
      if (!b.open) throw new Error(`bin ${n} is not open`);
      bdCloseLocal(b); touch();
      await send(st.conn.replyTopic, { cmd: 'close', bin: b.bin });
    }
  }

  /* the furnace a reading names: the charge's, else the one set for hand-opened bins */
  const furnaceFor = (b) => (b.furnace !== null ? b.furnace : num(st.bd.furnace));

  /* the ESP32's bin weights: every bin's scale in grams, as strings, plus its other fields */
  function bdPublishData() {
    if (!st.bd.sendData || !st.conn.dataTopic || !st.link || !st.link.connected) return;
    const msg = {};
    let onl = 0;
    for (const b of st.bins) {
      msg[`B${b.bin}`] = String(Math.round(b.weight * 1000));
      if (b.bin >= 1 && b.bin <= 8) onl |= 1 << (b.bin - 1);
    }
    Object.assign(msg, { sec: 0, onl, hook: 0, hookConv: 0, hookOk: 0 });
    send(st.conn.dataTopic, msg, { qos0: true });
  }

  function bdTick() {
    if (st.role !== 'board') return;
    const open = st.bins.filter((b) => b.open);
    if (!open.length) { bdPublishData(); return; }
    // Auto take: the bin gives `rate` kg a second until it has given its need (+ overshoot).
    if (st.bd.autoTake) {
      for (const b of open) {
        if (b.need === null) continue;
        const target = b.need + (num(st.bd.overshoot) || 0);
        const taken = b.startWeight - b.weight;
        if (taken < target - 1e-9) b.weight = Math.max(0, round3(b.weight - Math.min(num(st.bd.rate) || 0, target - taken)));
      }
    }
    for (const b of open) { b.lastWeight = b.weight; b.taken = Math.max(0, round3(b.startWeight - b.weight)); }
    touch();
    bdPublishData();
    if (!st.bd.sending || !st.link || !st.link.connected) return;

    const grams = st.bd.unit === 'g';
    const qty = (b) => (grams ? Math.round(b.weight * 1000) : round3(b.weight));
    const unit = grams ? { unit: 'g' } : {};
    // One message per furnace: a bins list when several stand open, else the single form.
    const byFurnace = new Map();
    for (const b of open) {
      const f = furnaceFor(b);
      const k = f === null ? '' : String(f);
      if (!byFurnace.has(k)) byFurnace.set(k, []);
      byFurnace.get(k).push(b);
    }
    for (const [k, list] of byFurnace) {
      const f = k === '' ? {} : { furnace: Number(k) };
      if (st.bd.combined && list.length > 1) {
        send(st.conn.replyTopic, { cmd: 'took', ...f, ...unit, bins: list.map((b) => ({ bin: b.bin, el: b.el, qty: qty(b) })) });
      } else {
        for (const b of list) send(st.conn.replyTopic, { cmd: 'took', ...f, bin: b.bin, el: b.el, qty: qty(b), ...unit });
      }
    }
  }

  function bdWeight(n, { delta, set }) {
    const b = binOf(n);
    if (!b) throw new Error(`there is no bin ${n}`);
    const w = set !== undefined && set !== null ? num(set) : b.weight + (num(delta) || 0);
    if (w === null) throw new Error('weight must be a number');
    b.weight = Math.max(0, round3(w));
    if (b.open) { b.lastWeight = b.weight; b.taken = Math.max(0, round3(b.startWeight - b.weight)); }
    touch();
  }

  /* ----------------------------------------------------------- connection */

  /* software: the weights topic sets each bin's weight - its stock while shut, the live scale while open */
  function swWeights(json) {
    const now = new Date().toISOString();
    const unknown = [];
    for (const { bin, kg } of binWeightsOf(json)) {
      const b = binOf(bin);
      if (!b) { unknown.push(bin); continue; }
      b.weight = kg; b.weightAt = now;
    }
    if (unknown.length && !st.sw.warnedData) {
      st.sw.warnedData = true;
      note(`the bin weights name bin(s) ${unknown.join(', ')} that are not in the bin table - ignored`, 'warn');
    }
    touch();
  }

  function onMessage(topic, payload) {
    if (st.role === 'software' && st.conn.dataTopic && topic === st.conn.dataTopic) {
      entry({ dir: 'in', topic, payload });
      let json;
      try { json = JSON.parse(payload); } catch (_) { return note('bin weights are not JSON - ignored', 'warn'); }
      return swWeights(json);
    }
    const mine = st.role === 'software' ? st.conn.replyTopic : st.conn.requestTopic;
    if (topic !== mine) return;
    entry({ dir: 'in', topic, payload });
    let json;
    try { json = JSON.parse(payload); } catch (_) { return note('not JSON - ignored', 'warn'); }
    if (!json || typeof json !== 'object') return note('not a JSON object - ignored', 'warn');
    if (st.role === 'software') swReceive(json); else bdReceive(json);
  }

  function connect(opts = {}) {
    if (!st.role) throw new Error('choose Software or Board first');
    const c = {
      target: opts.target === 'external' ? 'external' : 'embedded',
      host: String(opts.host || '').trim(),
      port: Number(opts.port) || 1883,
      username: opts.username ? String(opts.username) : '',
      password: opts.password ? String(opts.password) : '',
      clientId: String(opts.clientId || '').trim() ||
        `IotBench-${st.role}-${Math.random().toString(16).slice(2, 8)}`,
      requestTopic: String(opts.requestTopic || '').trim() || 'melting/software/set-weights',
      replyTopic: String(opts.replyTopic || '').trim() || 'bin/chargemix/reply',
      // blank turns the weight feed off
      dataTopic: opts.dataTopic === undefined ? 'melting/board1/weights' : String(opts.dataTopic || '').trim(),
    };
    const topics = [c.requestTopic, c.replyTopic, c.dataTopic].filter(Boolean);
    if (new Set(topics).size !== topics.length) throw new Error('the request, reply and bin weight topics must all differ');
    if (c.target === 'external') {
      if (!c.host) throw new Error('external broker needs a host');
      if (c.host === PLANT_BROKER && !process.env.ALLOW_PLANT) {
        throw new Error(`${PLANT_BROKER} is the PLANT broker. Simulated bin commands must not go there ` +
                        '(set ALLOW_PLANT=1 before starting IotBench if you really mean it).');
      }
    }
    disconnect(true);
    st.conn = c;
    const host = c.target === 'embedded' ? '127.0.0.1' : c.host;
    const port = c.target === 'embedded' ? embeddedPort : c.port;
    st.link = new MqttLink({ host, port, clientId: c.clientId, username: c.username, password: c.password },
                           (s) => note(s));
    st.link.subscribe(st.role === 'software' ? c.replyTopic : c.requestTopic);
    if (st.role === 'software' && c.dataTopic) st.link.subscribe(c.dataTopic);
    st.link.on('message', onMessage);
    st.link.on('state', touch);
    st.link.start();
    if (st.role === 'board') st.timer = setInterval(bdTick, 1000);
    note(`${st.role === 'software' ? 'acting as the SOFTWARE' : 'acting as the BOARD'} - ` +
         `${c.target === 'embedded' ? 'this IotBench broker' : `${c.host}:${c.port}`}, ` +
         `sends on ${st.role === 'software' ? c.requestTopic : [c.replyTopic, c.dataTopic].filter(Boolean).join(' + ')}, ` +
         `listens on ${st.role === 'software' ? [c.replyTopic, c.dataTopic].filter(Boolean).join(' + ') : c.requestTopic}`);
  }

  function disconnect(quiet) {
    stopRepeat('disconnected');
    stopSim('disconnected');
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (st.link) { st.link.stop(); st.link = null; if (!quiet) note('disconnected'); }
    touch();
  }

  function setRole(role) {
    if (role !== null && role !== 'software' && role !== 'board') throw new Error('role is software or board');
    if (role === st.role) return;
    disconnect(true);
    st.role = role;
    st.bins.forEach((b) => Object.assign(b, freshBin(b)));
    st.sw = { current: null, heatOf: {}, saved: [], takes: [] };
    st.log = [];
    if (role) note(`role: ${role}`);
    touch();
  }

  /* edit the bin table (number, element, material, weight); open state is kept by bin number */
  function setBins(list) {
    if (!Array.isArray(list) || !list.length) throw new Error('give at least one bin');
    const seen = new Set();
    const next = list.map((r) => {
      const n = num(r.bin);
      if (n === null || n < 1) throw new Error('every bin needs a number from 1');
      if (seen.has(n)) throw new Error(`bin ${n} is listed twice`);
      seen.add(n);
      const old = binOf(n);
      const b = old ? { ...old } : freshBin(r);
      b.el = String(r.el ?? b.el); b.material = String(r.material ?? b.material);
      if (r.weight !== undefined && !b.open) b.weight = Math.max(0, round3(num(r.weight) ?? 0));
      return b;
    }).sort((a, b) => a.bin - b.bin);
    st.bins = next;
    touch();
  }

  function setBoard(patch = {}) {
    const d = st.bd;
    if (patch.autoTake !== undefined) d.autoTake = !!patch.autoTake;
    if (patch.rate !== undefined) d.rate = Math.max(0, num(patch.rate) ?? d.rate);
    if (patch.overshoot !== undefined) d.overshoot = num(patch.overshoot) ?? 0;
    if (patch.combined !== undefined) d.combined = !!patch.combined;
    if (patch.unit !== undefined) d.unit = patch.unit === 'g' ? 'g' : 'kg';
    if (patch.furnace !== undefined) d.furnace = String(patch.furnace ?? '').trim();
    if (patch.sending !== undefined) d.sending = !!patch.sending;
    if (patch.sendData !== undefined) d.sendData = !!patch.sendData;
    touch();
    return { ...d };
  }

  async function action(body = {}) {
    const a = String(body.action || '');
    if (st.role === 'software') {
      if (a === 'charge') return swCharge(body);
      if (a === 'repeat') return swRepeat(body);
      if (a === 'stopRepeat') return stopRepeat('Stop pressed');
      if (a === 'sim') return swSim(body);
      if (a === 'stopSim') return stopSim('Stop pressed');
      if (a === 'open') return swOpen(body.bin);
      if (a === 'close') return swClose(body.bin);
      if (a === 'done') return swDone();
      if (a === 'clearSaved') { st.sw.saved = []; st.sw.takes = []; touch(); return; }
    } else if (st.role === 'board') {
      if (a === 'open' || a === 'close' || a === 'done') return bdButton(a, body.bin);
      if (a === 'weight') return bdWeight(body.bin, body);
      if (a === 'settings') return setBoard(body);
    }
    if (a === 'bins') return setBins(body.bins);
    if (a === 'clearLog') { st.log = []; touch(); return; }
    throw new Error(`unknown action "${a}" for role ${st.role || '(none)'}`);
  }

  function getStatus() {
    const { password, ...conn } = st.conn;
    return {
      rev: st.rev, role: st.role,
      conn: { ...conn, hasPassword: !!password },
      link: st.link ? { on: true, connected: st.link.connected, error: st.link.error } : { on: false, connected: false, error: null },
      bins: st.bins.map((b) => ({ ...b })),
      software: { current: st.sw.current, saved: st.sw.saved, takes: st.sw.takes.slice(0, 50),
                  repeat: st.repeat ? { kind: st.repeat.kind, stage: st.repeat.msg.stage || null,
                                        every: st.repeat.every, count: st.repeat.count } : null,
                  sim: st.sim ? { furnace: st.sim.furnace, heat: st.sim.heat, need: st.sim.need, chargeSec: st.sim.chargeSec,
                                  waitSec: st.sim.waitSec, cycles: st.sim.cycles, phase: st.sim.phase,
                                  nextInMs: Math.max(0, st.sim.nextAt - Date.now()) } : null },
      board: { ...st.bd },
      log: st.log,
    };
  }

  return { connect, disconnect, setRole, action, getStatus, _tick: bdTick, _state: st };
}

module.exports = { createBinBoard, MqttLink, readingsOf, binWeightsOf, DEFAULT_BINS };
