/* ============================================================================
 * IotBench - connectivity test server + live reply editor UI
 * Emulates skyfastpms.janaticsindia.com:9010 for board <-> server testing.
 *
 *  Board (ESP32) sends:
 *    POST /production?mac=5011&ip=<ip>&t1=<t1>&t2=<t2>
 *    Body: ["rec0", ... ]
 *
 *  We reply with the RAW server frame (the ESP32 appends ",11,22,33,44#" itself
 *  before handing it to the STM32 - so we do NOT add '#').
 *
 *  Real format (from captured samples):
 *    $LLL,DD/MM/YY_HH:MM:SS,PPPPP,RRRRR,BBBBBBBB,TTT,HHH,LLL,IIIIII,JJJJJJJJJJ,001,01,01,00
 *     lead  date _ time       prod  rej  batch    tSet tHi tLo reqId  itemNo(10)  ^trailing 3,2,2,2
 *    (itemNo may be alphanumeric, e.g. "0R18019 07")
 *
 *  Two reply modes (chosen from the browser UI at  /):
 *    - Raw mode  : send an exact string verbatim (paste a captured sample)
 *    - Field mode: build the frame from individual editable fields
 * ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const scales = require('./scales');
const plc = require('./plc');
const broker = require('./mqttbroker');
const binsim = require('./binsim');
const { createBinBoard } = require('./binboard');
const phsim = require('./phsim');

const PORT = process.env.PORT || 9010;
const HOST = process.env.HOST || '0.0.0.0';
/* optional RS485 slave on one serial port:
 *   node server.js <COMx>        -> scale sim  (9600 8N1)
 *   node server.js <COMx> plc    -> GDC PLC sim (19200 8N2)
 * (or SERIAL_PORT / SERIAL_MODE / SERIAL_BAUD env) */
const SERIAL_PORT = process.argv[2] || process.env.SERIAL_PORT || null;
const SERIAL_MODE = String(process.argv[3] || process.env.SERIAL_MODE || 'scales').toLowerCase();
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD || (SERIAL_MODE === 'plc' ? 19200 : 9600));
/* embedded MQTT broker port (ESP32 connects here) */
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
/* topic the P10 display sketch subscribes to (see FieldTest/DisplayLed/P10_Display) */
const FURNACE_TOPIC = 'furnace/display';
/* charge-mix bin board simulator (/bin): acts as the melting server or as the board */
const binboard = createBinBoard({ embeddedPort: MQTT_PORT });

/* this PC's LAN IPv4 addresses — tell the user what to point the ESP32 at */
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name]) {
      if (i.family === 'IPv4' && !i.internal) out.push({ iface: name, ip: i.address });
    }
  }
  return out;
}

/* Current reply configuration (edited from the UI, kept in memory). */
const replyConfig = {
  appendHash: true,                   // true = terminate reply with '#' (matches real server)
  rawMode: false,                     // true = send rawReply verbatim
  rawReply: '',                       // exact string to send in raw mode
  autoTime: false,                    // true = use server clock for date/time
  lead: '022',                        // 3  leading field
  DD: '5', MM: '7', YY: '26',         // date  (used only when autoTime = false)
  HH: '15', Min: '38', SS: '3',       // time  (used only when autoTime = false)
  prod: '920',                        // 5  Production_Total
  rej: '0',                           // 5  Rejection_Total
  batch: '975',                       // 8  batchTargetquantity
  tSet: '200',                        // 3  temperateSet
  tHi: '220',                         // 3  temperateSetHigh
  tLo: '180',                         // 3  temperateSetLow
  reqId: '271841',                    // 6  requirementId
  itemNo: '0000434106',               // 10 itemNumber (may be alphanumeric)
  batchNo: '1',                       // 3  trailing field 1 (e.g. 001)
  reset: '1',                         // 2  trailing field 2 (e.g. 01)
  startStop: '1',                     // 2  trailing field 3 (e.g. 01)
  reason: '0',                        // 2  trailing field 4 (e.g. 00)
};

/* Live view of what the board is doing (shown in the UI). */
const stats = { count: 0, lastFrom: '', lastQuery: '', lastBody: '', lastReply: '', lastAt: '' };

/* numeric field: strip non-digits, left-pad zeros, clamp to width */
function fixed(v, w) { return String(v).replace(/[^0-9]/g, '').padStart(w, '0').slice(-w); }
/* raw field (itemNo): keep chars as-is, pad/clamp to width without stripping */
function padRaw(v, w) { return String(v).padStart(w, '0').slice(-w); }
function two(n) { return String(n).padStart(2, '0'); }

/* Build the reply from the current config. No trailing '#': the ESP32 adds it. */
function buildReply(cfg) {
  let frame;
  if (cfg.rawMode && cfg.rawReply && String(cfg.rawReply).trim()) {
    frame = String(cfg.rawReply).trim();
  } else {
    let DD, MM, YY, HH, Min, SS;
    if (cfg.autoTime) {
      const n = new Date();
      DD = two(n.getDate()); MM = two(n.getMonth() + 1); YY = two(n.getFullYear() % 100);
      HH = two(n.getHours()); Min = two(n.getMinutes()); SS = two(n.getSeconds());
    } else {
      DD = fixed(cfg.DD, 2); MM = fixed(cfg.MM, 2); YY = fixed(cfg.YY, 2);
      HH = fixed(cfg.HH, 2); Min = fixed(cfg.Min, 2); SS = fixed(cfg.SS, 2);
    }
    frame = `$${fixed(cfg.lead, 3)},${DD}/${MM}/${YY}_${HH}:${Min}:${SS},` +
            `${fixed(cfg.prod, 5)},${fixed(cfg.rej, 5)},${fixed(cfg.batch, 8)},` +
            `${fixed(cfg.tSet, 3)},${fixed(cfg.tHi, 3)},${fixed(cfg.tLo, 3)},` +
            `${fixed(cfg.reqId, 6)},${padRaw(cfg.itemNo, 10)},` +
            `${fixed(cfg.batchNo, 3)},${fixed(cfg.reset, 2)},${fixed(cfg.startStop, 2)},${fixed(cfg.reason, 2)}`;
  }
  /* terminate with a single '#' when enabled (raw samples may already have one) */
  if (cfg.appendHash && !frame.endsWith('#')) frame += '#';
  return frame;
}

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => cb(b));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  /* ---- UI page ---- */
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    fs.readFile(path.join(__dirname, 'ui.html'), (e, data) => {
      if (e) { res.writeHead(500); res.end('ui.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  /* ---- config API (used by the UI) ---- */
  if (req.method === 'GET' && p === '/api/config') {
    sendJson(res, { config: replyConfig, preview: buildReply(replyConfig) });
    return;
  }
  if (req.method === 'POST' && p === '/api/config') {
    readBody(req, (b) => {
      try {
        Object.assign(replyConfig, JSON.parse(b || '{}'));
        sendJson(res, { ok: true, config: replyConfig, preview: buildReply(replyConfig) });
      } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/status') {
    sendJson(res, { ...stats, preview: buildReply(replyConfig) });
    return;
  }

  /* ---- scale simulator page + API ---- */
  if (req.method === 'GET' && p === '/scales') {
    fs.readFile(path.join(__dirname, 'scales.html'), (e, data) => {
      if (e) { res.writeHead(500); res.end('scales.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/bins') {
    const since = Number(url.searchParams.get('since') || 0);
    sendJson(res, {
      weights: scales.getWeights(),
      meta: scales.getBinMeta(),
      status: scales.getStatus(),
      log: scales.getLog(since),
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/bins') {
    readBody(req, (b) => {
      try {
        const body = JSON.parse(b || '{}');
        if (body.weights && typeof body.weights === 'object') {
          Object.keys(body.weights).forEach((k) => scales.setBinWeight(k, body.weights[k]));
        } else if (body.bin !== undefined) {
          scales.setBinWeight(body.bin, body.grams);
        }
        sendJson(res, { ok: true, weights: scales.getWeights() });
      } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    });
    return;
  }

  /* ---- GDC PLC simulator page + API ---- */
  if (req.method === 'GET' && p === '/plc') {
    fs.readFile(path.join(__dirname, 'plc.html'), (e, data) => {
      if (e) { res.writeHead(500); res.end('plc.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/plc') {
    const since = Number(url.searchParams.get('since') || 0);
    sendJson(res, {
      status: plc.getStatus(), meta: plc.getMeta(), faults: plc.getFaults(),
      stations: plc.getStations(), log: plc.getLog(since),
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/plc') {
    readBody(req, (b) => {
      try {
        const body = JSON.parse(b || '{}');
        if (body.action === 'add') plc.addParts(body.station, body.kind, body.count);
        else if (body.action === 'set') plc.setStation(body.station, body);
        else if (body.action === 'auto') plc.setAuto(body.station, body.cycleSec, body.rejEvery);
        else if (body.action === 'faults') plc.setFaults(body);
        else if (body.action === 'oneshot') plc.setOneShot(body.mode, body.count);
        else throw new Error('unknown action');
        sendJson(res, { ok: true, stations: plc.getStations(), faults: plc.getFaults() });
      } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    });
    return;
  }

  /* ---- MQTT broker page + API ---- */
  if (req.method === 'GET' && p === '/mqtt') {
    fs.readFile(path.join(__dirname, 'mqtt.html'), (e, data) => {
      if (e) { res.writeHead(500); res.end('mqtt.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/mqtt') {
    const since = Number(url.searchParams.get('since') || 0);
    sendJson(res, {
      status: broker.getStatus(),
      hostIps: lanIPs(),
      clients: broker.getClients(),
      latest: broker.getLatest(),
      messages: broker.getMessages(since),
    });
    return;
  }

  /* ---- furnace / bunker publisher page + API ---- */
  if (req.method === 'GET' && p === '/furnace') {
    fs.readFile(path.join(__dirname, 'furnace.html'), (e, data) => {
      if (e) { res.writeHead(500); res.end('furnace.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/furnace') {
    const since = Number(url.searchParams.get('since') || 0);
    sendJson(res, {
      status: broker.getStatus(),
      hostIps: lanIPs(),
      topic: FURNACE_TOPIC,
      current: broker.getLatestForTopic(FURNACE_TOPIC),
      messages: broker.getMessages(since).filter((m) => m.topic === FURNACE_TOPIC),
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/furnace/publish') {
    readBody(req, (b) => {
      let body;
      try { body = JSON.parse(b || '{}'); } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); return; }
      /* Server controls exactly what the panel shows — these are the literal lines, no
       * formatting applied on the ESP32 side. */
      const payload = {
        LINE1: String(body.line1 ?? ''),
        LINE2: String(body.line2 ?? ''),
      };
      broker.publish(FURNACE_TOPIC, payload, { retain: true })
        .then(() => sendJson(res, { ok: true, topic: FURNACE_TOPIC, payload }))
        .catch((err) => sendJson(res, { ok: false, error: err.message }, 500));
    });
    return;
  }

  /* ---- PHSupport SQL simulator (production flow) page + API ----
   *   GET  /phsupport                         page
   *   GET  /api/phsupport/tables              table list with row counts
   *   GET  /api/phsupport/rows?table=Line_1&hours=6 | &day=YYYY-MM-DD | &sinceId=N
   *                                           rows exactly as SELECT * returns them (what the SMES sync reads)
   *   GET  /api/phsupport/status              page state
   *   GET  /api/phsupport/row?table=&id=      one row's non-empty columns
   *   POST /api/phsupport/settings            { running, speed, takt, faults, historyHours }
   *   POST /api/phsupport/reset               regenerate history and restart
   */
  if (p.startsWith('/api/phsupport')) res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'GET' && p === '/phsupport') {
    fs.readFile(path.join(__dirname, 'phsupport.html'), (e, data) => {
      if (e) { res.writeHead(500); res.end('phsupport.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/phsupport/tables') { sendJson(res, phsim.tableList()); return; }
  if (req.method === 'GET' && p === '/api/phsupport/rows') {
    const q = {};
    for (const k of ['hours', 'day', 'sinceId', 'top']) if (url.searchParams.get(k)) q[k] = url.searchParams.get(k);
    const out = phsim.rows(String(url.searchParams.get('table') || ''), q, req.headers['user-agent'] || '');
    sendJson(res, out, out.error ? 404 : 200);
    return;
  }
  if (req.method === 'GET' && p === '/api/phsupport/status') { sendJson(res, phsim.getStatus()); return; }
  if (req.method === 'GET' && p === '/api/phsupport/row') {
    const r = phsim.rowDetail(String(url.searchParams.get('table') || ''), url.searchParams.get('id'));
    sendJson(res, r || { error: 'row not found' }, r ? 200 : 404);
    return;
  }
  if (req.method === 'POST' && p === '/api/phsupport/settings') {
    readBody(req, (b) => {
      try { sendJson(res, { ok: true, settings: phsim.setSettings(JSON.parse(b || '{}')) }); }
      catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/phsupport/reset') { phsim.reset(); sendJson(res, { ok: true }); return; }

  /* ---- bin / crane data publisher (topic bin/data) page + API ---- */
  if (req.method === 'GET' && p === '/crane') {
    fs.readFile(path.join(__dirname, 'crane.html'), (e, data) => {
      if (e) { res.writeHead(500); res.end('crane.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/crane') {
    const since = Number(url.searchParams.get('since') || 0);
    sendJson(res, { ...binsim.getStatus(since), brokerStatus: broker.getStatus(), hostIps: lanIPs() });
    return;
  }
  if (req.method === 'POST' && p === '/api/crane/start') {
    readBody(req, (b) => {
      let body;
      try { body = JSON.parse(b || '{}'); } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); return; }
      try {
        binsim.start(body, (topic, payload, opts) => broker.publish(topic, payload, opts));
        sendJson(res, { ok: true });
      } catch (err) {
        sendJson(res, { ok: false, error: err.message }, 400);
      }
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/crane/manual') {
    readBody(req, (b) => {
      let body;
      try { body = JSON.parse(b || '{}'); } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); return; }
      sendJson(res, { ok: true, manual: binsim.setManual(body) });
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/crane/seq') {
    readBody(req, (b) => {
      let body;
      try { body = JSON.parse(b || '{}'); } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); return; }
      try {
        if (body.action === 'stop') binsim.stopSeq(); else binsim.runSeq(String(body.name || 'seq1'));
        sendJson(res, { ok: true });
      } catch (err) {
        sendJson(res, { ok: false, error: err.message }, 400);
      }
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/crane/stop') { binsim.stop(); sendJson(res, { ok: true }); return; }
  if (req.method === 'POST' && p === '/api/crane/restart') { binsim.restartCycle(); sendJson(res, { ok: true }); return; }

  /* ---- charge-mix bin board simulator page + API ---- */
  if (req.method === 'GET' && p === '/bin') {
    fs.readFile(path.join(__dirname, 'bin.html'), (e, data) => {
      if (e) { res.writeHead(500); res.end('bin.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/bin') {
    sendJson(res, { ...binboard.getStatus(), brokerStatus: broker.getStatus(), hostIps: lanIPs() });
    return;
  }
  if (req.method === 'POST' && p.startsWith('/api/bin/')) {
    readBody(req, async (b) => {
      let body;
      try { body = JSON.parse(b || '{}'); } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); return; }
      try {
        const what = p.slice('/api/bin/'.length);
        if (what === 'role') binboard.setRole(body.role || null);
        else if (what === 'connect') binboard.connect(body);
        else if (what === 'disconnect') binboard.disconnect();
        else if (what === 'action') await binboard.action(body);
        else throw new Error('unknown endpoint');
        sendJson(res, { ok: true });
      } catch (err) {
        sendJson(res, { ok: false, error: err.message }, 400);
      }
    });
    return;
  }

  /* ---- the board endpoint ---- */
  /* /MultiSlave is the GDC path (ProductionMonitorV2 ESP32: mac=<station>&tl=&tr=&m=) */
  if (req.method === 'POST' && (p === '/production' || p === '/MultiSlave')) {
    readBody(req, (b) => {
      const q = url.searchParams;
      const reply = buildReply(replyConfig);
      stats.count++;
      stats.lastFrom = req.socket.remoteAddress;
      stats.lastQuery = url.search;
      stats.lastBody = b;
      stats.lastReply = reply;
      stats.lastAt = new Date().toISOString();
      console.log(`[${stats.lastAt}] POST ${p} from ${stats.lastFrom}`);
      if (p === '/MultiSlave') console.log(`   station=${q.get('mac')} tl=${q.get('tl')} tr=${q.get('tr')} m=${q.get('m')}`);
      else console.log(`   mac=${q.get('mac')} ip=${q.get('ip')} t1=${q.get('t1')} t2=${q.get('t2')}`);
      console.log(`   body : ${b}`);
      console.log(`   reply: ${reply}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(reply);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`IotBench - test server + UI listening on http://${HOST}:${PORT}`);
  console.log(`  Reply editor : http://localhost:${PORT}/`);
  console.log(`  Scale panel  : http://localhost:${PORT}/scales`);
  console.log(`  PLC panel    : http://localhost:${PORT}/plc`);
  console.log(`  MQTT monitor : http://localhost:${PORT}/mqtt`);
  console.log(`  Furnace/Bunker publisher : http://localhost:${PORT}/furnace`);
  console.log(`  Bin/Crane data publisher : http://localhost:${PORT}/crane   (topic bin/data)`);
  console.log(`  Charge-mix bin board     : http://localhost:${PORT}/bin     (bin/chargemix <-> bin/chargemix/reply)`);
  console.log(`  PHSupport SQL simulator  : http://localhost:${PORT}/phsupport   (API /api/phsupport/rows?table=Line_1&hours=6)`);

  /* PHSupport simulator: pre-generates history, then runs on the wall clock */
  try { phsim.start(); } catch (e) { console.error('PHSupport simulator start failed:', e.message); }

  /* start the embedded MQTT broker the ESP32 connects to */
  broker.start(MQTT_PORT).catch((e) => console.error('MQTT broker start failed:', e.message));
  const ips = lanIPs().map((x) => x.ip).join(', ') || '(no LAN IP)';
  console.log(`  MQTT broker  : point ESP32 mqttBroker at  ${ips}  port ${MQTT_PORT}`);

  if (SERIAL_PORT && SERIAL_MODE === 'plc') {
    plc.startPlcSim({ path: SERIAL_PORT, baud: SERIAL_BAUD, stopBits: 2 });
  } else if (SERIAL_PORT) {
    scales.startScaleSim({ path: SERIAL_PORT, baud: SERIAL_BAUD });
  } else {
    console.log('  (serial OFF - run  node server.js <COMx> [plc]  to enable an RS485 slave)');
  }
});
