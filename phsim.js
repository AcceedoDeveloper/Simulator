/* ============================================================================
 * IotBench - PHSupport SQL simulator (page /phsupport, API /api/phsupport/*)
 *
 * Plays the plant's SQL Server database PHSupport for the SMES production-flow
 * sync, so the backend -> MongoDB -> dashboard chain can be tested without the
 * plant server.
 *
 *   simulator (this)  --GET /api/phsupport/rows-->  SMES backend sync  -->  MongoDB  -->  dashboard
 *
 * What it keeps, in memory, with the REAL schema (phsupport/schema.json, exported
 * from PHSupport on 13 Nov 2026):
 *   Line_1, Line_2, Line_5          one row per part, one column per PLC tag
 *   Production_Count*               hourly OK / NOK per cell
 *   TagDetails*                     the tag maps (labels + spec limits), as-is
 *
 * How a part moves (same as the plant's Usp_Insert_L1 / Usp_Upd_L1_Cn jobs):
 *   - a part enters Cell-01 every takt; when Cell-01 finishes, a row is INSERTed
 *     (TimeStamp = insert time, QR_Code + all Cell-01 columns)
 *   - every later cell UPDATEs that same row when it finishes, a little later
 *     (the 3-minute job), so a row keeps changing for ~1 h after it appears
 *   - values are written the way the PLC writes them: text NUL-padded to a fixed
 *     length, dates `2026:10:22`, times `07:09:29`, durations ` 2:42` / ` 0: 7`,
 *     LReal floats for modes / status / gauge readings
 *
 * Data faults (rates editable on the page) reproduce what the real data has:
 * empty and junk QR codes, fields that lost their first characters
 * (`\0\0:49:14`), cells never written, and duplicate rows for one QR.
 *
 * Times: the plant clock is IST. TimeStamp is returned as SQL prints a datetime,
 * `YYYY-MM-DD HH:MM:SS.mmm`, IST wall clock.
 * ========================================================================== */

'use strict';
const fs = require('fs');
const path = require('path');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'phsupport', 'schema.json'), 'utf8'));
const IST_MS = 330 * 60000;
const PAD = 30;                       // fixed PLC string length
const KEEP_HOURS = 72;                // rows older than this are dropped
const MAX_LOG = 60;

/* ---------------------------------------------------------------------------
 * settings (the page edits these)
 * ------------------------------------------------------------------------- */
const settings = {
  running: true,
  speed: 1,                 // x1 = plant timing; x10 compresses every duration 10x
  historyHours: 8,          // parts pre-generated on start / reset
  takt: { 1: 80, 2: 75, 5: 95 },          // seconds between parts entering Cell-01 (x1)
  lines: { 1: true, 2: true, 5: true },   // a line switched off starts no new parts (parts already on it finish)
  faults: {
    emptyQr: 0.015,         // row with an empty QR_Code
    junkQr: 0.005,          // row with binary junk in QR_Code
    corrupt: 0.02,          // per time/duration field: first 2 chars lost
    missCell: 0.05,         // a cell's update never written (job missed)
    duplicate: 0.02,        // a second row for the same QR carries the later cells
  },
};

const LINES = SCHEMA.lines.filter(l => l.dataTable);          // 1, 2, 5 (Line 3 has no table)
const VARIANTS = { 1: ['FL3W 4851 AB', 'FL3W 4851 AC'], 2: ['GN1W 4851 BA', 'GN1W 4851 BB'], 5: ['KV6W 4851 CA'] };

/* ---------------------------------------------------------------------------
 * small helpers
 * ------------------------------------------------------------------------- */
const rnd = (a, b) => a + Math.random() * (b - a);
const chance = p => Math.random() < p;
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const p2 = n => String(n).padStart(2, '0');
const ist = ms => new Date(ms + IST_MS);   // read with getUTC* for the IST wall clock
const plcDate = ms => { const d = ist(ms); return `${d.getUTCFullYear()}:${p2(d.getUTCMonth() + 1)}:${p2(d.getUTCDate())}`; };
const plcTime = ms => { const d = ist(ms); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
const plcDur = sec => { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return `${String(m).padStart(2, ' ')}:${String(s).padStart(2, ' ')}`; };
const sqlTs = ms => { const d = ist(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`; };
const istDay = ms => sqlTs(ms).slice(0, 10);
/** PLC text: NUL-padded to the fixed length. */
const plcText = s => { s = String(s); return s.length >= PAD ? s : s + '\u0000'.repeat(PAD - s.length); };
/** A field that lost its first two characters, like the real `\0\0:49:14`. */
const corrupt = s => '\u0000\u0000' + String(s).slice(2);

/** Spec limits from a TagDetails label (`… 46.236 / 46.134`, `49.66±0.1`, `0.1 Max`). */
function spec(label) {
  const s = String(label || ''), N = '(\\d+(?:\\.\\d+)?)';
  let m = s.match(new RegExp(`${N}\\s*(?:±|\\+\\s*/\\s*-|\\+-)\\s*${N}`));
  if (m) return { lsl: +m[1] - +m[2], usl: +m[1] + +m[2] };
  m = s.match(new RegExp(`${N}\\s*/\\s*${N}(?![\\w.])`));
  if (m) return { lsl: Math.min(+m[1], +m[2]), usl: Math.max(+m[1], +m[2]) };
  m = s.match(new RegExp(`${N}\\s*Max\\b`, 'i'));
  if (m) return { lsl: 0, usl: +m[1] };
  return null;
}

/* ---------------------------------------------------------------------------
 * per-line model from the schema
 * ------------------------------------------------------------------------- */
const model = {};
for (const cfg of LINES) {
  const cols = SCHEMA.tables[cfg.dataTable].columns;
  const tags = SCHEMA.tables[cfg.tagTable].rows || [];
  const label = new Map(tags.map(t => [String(t.PHTagName || '').replace(/[\r\n]+/g, ''), t.ReportTagName]));
  const prodCols = cfg.productionTable ? SCHEMA.tables[cfg.productionTable].columns.map(c => c.name) : [];
  model[cfg.line] = {
    cfg,
    columns: cols.map(c => c.name),
    numeric: new Set(cols.filter(c => /float|int|real|decimal/i.test(c.type)).map(c => c.name)),
    spec: new Map([...label].map(([k, v]) => [k, spec(v)])),
    prodCells: [...new Set(prodCols.map(c => (c.match(/^L\d+C(\d+)_(OK|NOK)_TOTAL$/) || [])[1]).filter(Boolean))].map(Number).sort((a, b) => a - b),
    prodCols,
  };
}

/* Typical seconds per station, from the traced plant part (x1). */
function stationTiming(st) {
  const n = `${st.station} ${st.code || ''}`.toUpperCase();
  if (/SCANNER|^QR|\bSCR|\bSC1/.test(n)) return { cycle: rnd(3, 6), ld: 0 };
  if (/VISION/.test(n)) return { cycle: rnd(6, 10), ld: 0 };
  if (/OCR/.test(n)) return { cycle: rnd(140, 165), ld: 0 };
  if (/EDDY/.test(n)) return { cycle: rnd(3, 6), ld: 0 };
  if (/HTC OP10/.test(n)) return { cycle: rnd(150, 175), ld: rnd(8, 15) };
  if (/HTC OP20/.test(n)) return { cycle: rnd(100, 118), ld: rnd(6, 12) };
  if (/HTC OP40/.test(n)) return { cycle: rnd(85, 100), ld: rnd(5, 9) };
  if (/VMC/.test(n)) return { cycle: rnd(110, 140), ld: rnd(6, 12) };
  if (/BROACH/.test(n)) return { cycle: rnd(60, 80), ld: rnd(6, 12) };
  if (/OP30|IHM/.test(n)) return { cycle: rnd(170, 190), ld: rnd(8, 14) };
  if (/PLUNGE/.test(n)) return { cycle: rnd(52, 66), ld: rnd(10, 16) };
  if (/LASER|LSR/.test(n)) return { cycle: rnd(31, 36), ld: rnd(5, 9) };
  if (/EQUATOR/.test(n)) return { cycle: rnd(80, 100), ld: rnd(8, 14) };
  if (/BALANC/.test(n)) return { cycle: rnd(20, 26), ld: rnd(5, 9) };
  if (/AUTOGAUGE|AUTOAGAUGE|\bAG/.test(n)) return { cycle: rnd(26, 46), ld: rnd(5, 9) };
  return { cycle: rnd(30, 60), ld: rnd(5, 10) };
}

/* ---------------------------------------------------------------------------
 * state
 * ------------------------------------------------------------------------- */
let tables, parts, nextId, nextSerial, nextEntry, hourly, lastHour, requestLog, stats;

function resetState() {
  tables = {};
  for (const [name, t] of Object.entries(SCHEMA.tables)) tables[name] = { columns: t.columns.map(c => c.name), rows: t.kind === 'tagmap' ? t.rows.slice() : [] };
  parts = [];
  nextId = { Line_1: 26001, Line_2: 33001, Line_5: 12001 };
  nextSerial = { 1: 1, 2: 1, 5: 1 };
  nextEntry = {};
  hourly = {};         // `${line}|${hourStartMs}|${cell}` -> { ok, nok }
  lastHour = {};
  requestLog = [];
  stats = { inserted: 0, updated: 0, emptyQr: 0, junkQr: 0, corrupted: 0, missedCells: 0, duplicates: 0 };
}

/* ---------------------------------------------------------------------------
 * part generation: one part -> a schedule of row writes
 * ------------------------------------------------------------------------- */
function makePart(line, enterMs) {
  const m = model[line], cfg = m.cfg, sp = settings.speed;
  const d = ist(enterMs);
  const variant = VARIANTS[line][Math.floor(Math.random() * VARIANTS[line].length)];
  const serial = `JCNGA${String(d.getUTCFullYear()).slice(2)}${String(Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000)).padStart(3, '0')}${String(nextSerial[line]++).padStart(6, '0')}`;
  const qr = `${serial}${variant}`;
  const forging = `${String(d.getUTCFullYear()).slice(2)}K${String(10 + Math.floor(Math.random() * 20))}A\u0000\u0000${String(10 + Math.floor(Math.random() * 80))}`;
  const nok = chance(0.02);
  const part = { line, qr, variant, enterMs, cells: [], finished: false, current: null };
  let t = enterMs;
  const shift = (() => { const h = d.getUTCHours(); return h >= 6 && h < 14 ? 1 : h >= 14 && h < 22 ? 2 : 3; })();

  cfg.cells.forEach((cell, ci) => {
    if (ci > 0) t += rnd(150, 1000) * 1000 / sp;        // conveyor / buffer between cells
    const set = {};
    const startMs = t;
    if (cell.qrColumn) set[cell.qrColumn] = plcText(qr);
    if (cell.shiftColumn) set[cell.shiftColumn] = shift;
    if (cell.userColumn) set[cell.userColumn] = plcText(`OP${100 + Math.floor(Math.random() * 40)}`);
    if (ci === 0 && cfg.variantColumn) set[cfg.variantColumn] = plcText(variant);
    if (ci === 0 && cfg.forgingCodeColumn) set[cfg.forgingCodeColumn] = plcText(forging);
    let lastOut = t, cellNok = false;
    for (const st of cell.stations) {
      const c = st.columns, tm = stationTiming(st);
      const inMs = t + rnd(8, 30) * 1000 / sp;
      const outMs = inMs + (tm.cycle + tm.ld) * 1000 / sp;
      const w = (role, v) => { if (c[role]) set[c[role]] = v; };
      const txt = (role, v) => { if (!c[role]) return; const bad = chance(settings.faults.corrupt); if (bad) stats.corrupted++; set[c[role]] = plcText(bad ? corrupt(v) : v); };
      txt('inDate', plcDate(inMs)); txt('outDate', plcDate(outMs));
      txt('inTime', plcTime(inMs)); txt('outTime', plcTime(outMs));
      txt('cycleStart', plcTime(inMs + tm.ld * 500 / sp)); txt('cycleStop', plcTime(outMs - tm.ld * 500 / sp));
      txt('cycle', plcDur(tm.cycle)); if (tm.ld) txt('ldUld', plcDur(tm.ld));
      w('robotMode', chance(0.02) ? 16777216 + Math.floor(Math.random() * 255) : (chance(0.7) ? 1 : 0));
      w('machineIndex', /PLUNGE/i.test(st.station) && line === 1 ? 1 + Math.floor(Math.random() * 13) : 1 + (chance(0.3) ? 1 : 0));
      const stNok = nok && !cellNok && st.params.length > 0 && chance(0.5);
      if (stNok) cellNok = true;
      w('status', stNok ? 0 : 1);
      if (c.grade) set[c.grade] = plcText(`AB\u0000\u000058${variant}`);
      if (c.side) set[c.side] = plcText(chance(0.5) ? 'LH' : 'RH');
      w('value', +(Math.abs(gauss()) * 2).toFixed(3)); w('angle', +(Math.random() * 360).toFixed(1));
      if (c.onCallInDate && chance(0.03)) {
        const a = outMs + 60000, b = a + rnd(300, 900) * 1000;
        txt('onCallInDate', plcDate(a)); txt('onCallInTime', plcTime(a)); txt('onCallOutDate', plcDate(b)); txt('onCallOutTime', plcTime(b));
      }
      for (const p of st.params) {
        const s = m.spec.get(p.column);
        let v;
        if (s) {
          const mid = (s.lsl + s.usl) / 2, half = (s.usl - s.lsl) / 2 || 0.01;
          v = (stNok && p.n === 1) ? s.usl + half * 0.3 : mid + gauss() * half / 3.2;
          if (s.lsl === 0) v = Math.abs(v);
        } else v = 50 + gauss() * 2;
        set[p.column] = +v.toFixed(4);
      }
      t = outMs; lastOut = outMs;
    }
    // the Usp_Upd job picks the cell up a little after it finishes (every ~3 min)
    const writeMs = lastOut + rnd(5, 180) * 1000 / sp;
    part.cells.push({ cell: cell.cell, startMs, endMs: lastOut, writeMs, set, nok: cellNok, missed: ci > 0 && chance(settings.faults.missCell), done: false });
    t = lastOut;
  });
  // a second row for the same QR carrying the later cells (real data: 23,668 rows, 19,513 QRs)
  part.dupFrom = part.cells.length > 2 && chance(settings.faults.duplicate) ? 2 + Math.floor(Math.random() * (part.cells.length - 2)) : null;
  part.qrFault = chance(settings.faults.emptyQr) ? 'empty' : chance(settings.faults.junkQr) ? 'junk' : null;
  return part;
}

/* ---------------------------------------------------------------------------
 * applying writes (INSERT on Cell-01, UPDATE afterwards)
 * ------------------------------------------------------------------------- */
function insertRow(part, atMs, values) {
  const m = model[part.line], tbl = tables[m.cfg.dataTable];
  const row = Object.fromEntries(m.columns.map(c => [c, null]));
  row.ID = nextId[m.cfg.dataTable]++;
  row.TimeStamp = sqlTs(atMs);
  row._ms = atMs;
  row.QR_Code = part.qrFault === 'empty' ? '' : part.qrFault === 'junk' ? '\u0001ÿ\u0000\u0013' + part.qr.slice(4, 9) : plcText(part.qr);
  Object.assign(row, values);
  tbl.rows.push(row);
  stats.inserted++;
  if (part.qrFault === 'empty') stats.emptyQr++; else if (part.qrFault === 'junk') stats.junkQr++;
  return row;
}

function applyCell(part, ci, nowMs) {
  const c = part.cells[ci];
  c.done = true;
  part.current = c.cell;
  if (ci === part.cells.length - 1) part.finished = true;
  countProduction(part.line, c, c.endMs);
  if (c.missed) { stats.missedCells++; return; }
  if (ci === 0) { part.row = insertRow(part, c.writeMs, c.set); return; }
  if (part.dupFrom !== null && ci >= part.dupFrom) {
    if (!part.dupRow) { part.dupRow = insertRow({ ...part, qrFault: null }, c.writeMs, c.set); stats.duplicates++; }
    else { Object.assign(part.dupRow, c.set); stats.updated++; }
    return;
  }
  if (part.row) { Object.assign(part.row, c.set); stats.updated++; }
}

function countProduction(line, cell, endMs) {
  const n = /^C(\d+)$/.exec(cell.cell);
  if (!n || !model[line].prodCells.includes(+n[1])) return;
  const hour = Math.floor((endMs + IST_MS) / 3600000) * 3600000 - IST_MS;
  const k = `${line}|${hour}|${n[1]}`;
  const e = hourly[k] || (hourly[k] = { ok: 0, nok: 0 });
  cell.nok ? e.nok++ : e.ok++;
}

/** At each full hour: one Production_Count row with the previous hour's totals (sometimes a duplicate with nulls). */
function writeProductionRows(line, nowMs) {
  const m = model[line];
  if (!m.cfg.productionTable) return;
  const hourNow = Math.floor((nowMs + IST_MS) / 3600000) * 3600000 - IST_MS;
  let h = lastHour[line] ?? hourNow;
  for (; h < hourNow; h += 3600000) {
    const at = h + 3600000 + 693;                 // logged at hh:00:00.693 for the hour before
    const tbl = tables[m.cfg.productionTable];
    const row = { Id: tbl.rows.length + 11000, TimeStamp: sqlTs(at), _ms: at };
    for (const cn of m.prodCells) {
      const e = hourly[`${line}|${h}|${cn}`] || { ok: 0, nok: 0 };
      row[`L${line}C${cn}_OK_TOTAL`] = e.ok;
      row[`L${line}C${cn}_NOK_TOTAL`] = e.nok;
    }
    if (chance(0.1)) {                            // the duplicate-with-nulls row the real table has
      const dup = { ...row, Id: row.Id + 1 };
      for (const cn of m.prodCells) if (chance(0.6)) { dup[`L${line}C${cn}_OK_TOTAL`] = null; dup[`L${line}C${cn}_NOK_TOTAL`] = null; }
      tbl.rows.push(row, dup);
    } else tbl.rows.push(row);
  }
  lastHour[line] = hourNow;
}

/* ---------------------------------------------------------------------------
 * clock
 * ------------------------------------------------------------------------- */
function advance(nowMs) {
  for (const cfg of LINES) {
    const line = cfg.line, takt = settings.takt[line] * 1000 / settings.speed;
    if (nextEntry[line] === undefined) nextEntry[line] = nowMs;
    if (!settings.lines[line]) { nextEntry[line] = Math.max(nextEntry[line], nowMs); continue; }
    while (nextEntry[line] <= nowMs) {
      parts.push(makePart(line, nextEntry[line]));
      nextEntry[line] += takt * rnd(0.8, 1.25);
    }
  }
  for (const p of parts) {
    if (p.finished) continue;
    p.cells.forEach((c, i) => { if (!c.done && c.writeMs <= nowMs && (i === 0 || p.cells[i - 1].done)) applyCell(p, i, nowMs); });
  }
  for (const cfg of LINES) writeProductionRows(cfg.line, nowMs);
  // forget old parts and rows
  const cutoff = nowMs - KEEP_HOURS * 3600000;
  parts = parts.filter(p => !p.finished || p.enterMs > nowMs - 6 * 3600000);
  for (const t of Object.values(tables)) if (t.rows.length && t.rows[0]._ms !== undefined) t.rows = t.rows.filter(r => r._ms >= cutoff);
}

let timer = null;
function start() {
  resetState();
  // history: parts that entered over the last N hours, played forward to now at x1
  const now = Date.now(), from = now - settings.historyHours * 3600000;
  const sp = settings.speed; settings.speed = 1;
  for (const cfg of LINES) { nextEntry[cfg.line] = from; lastHour[cfg.line] = Math.floor((from + IST_MS) / 3600000) * 3600000 - IST_MS; }
  for (let t = from; t <= now; t += 60000) advance(t);
  advance(now);
  settings.speed = sp;
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (settings.running) advance(Date.now()); }, 1000);
}

/* ---------------------------------------------------------------------------
 * the "SQL" API — rows exactly as SELECT * returns them
 * ------------------------------------------------------------------------- */
const publicRow = r => { const { _ms, ...rest } = r; return rest; };

/**
 * rows(table, { hours | day | sinceId | top })
 *   hours=6        TimeStamp >= DATEADD(HOUR, -6, GETDATE())
 *   day=2026-11-13 TimeStamp in that IST day
 *   sinceId=123    ID > 123
 * Tag map tables ignore the filters and return every row.
 */
function rows(table, q = {}, who = '') {
  const t = tables[table];
  if (!t) return { error: `Invalid object name 'dbo.${table}'.`, tables: Object.keys(tables) };
  let out = t.rows;
  if (out.length && out[0]._ms !== undefined) {
    if (q.hours) { const from = Date.now() - Number(q.hours) * 3600000; out = out.filter(r => r._ms >= from); }
    if (q.day) out = out.filter(r => istDay(r._ms) === String(q.day));
    if (q.sinceId) out = out.filter(r => (r.ID ?? r.Id) > Number(q.sinceId));
  }
  if (q.top) out = out.slice(-Number(q.top));
  const res = { table, columns: t.columns, count: out.length, rows: out.map(publicRow) };
  requestLog.unshift({ at: sqlTs(Date.now()).slice(11, 19), who, table, query: Object.entries(q).map(([k, v]) => `${k}=${v}`).join('&') || 'all', rows: out.length });
  requestLog.length = Math.min(requestLog.length, MAX_LOG);
  return res;
}

function tableList() {
  return Object.entries(tables).map(([name, t]) => ({ name, kind: SCHEMA.tables[name].kind, columns: t.columns.length, rows: t.rows.length }));
}

/* ---------------------------------------------------------------------------
 * page status / settings
 * ------------------------------------------------------------------------- */
function getStatus() {
  const now = Date.now();
  const wip = LINES.map(cfg => {
    const live = parts.filter(p => p.line === cfg.line && !p.finished && p.cells[0].done);
    const byCell = Object.fromEntries(cfg.cells.map(c => [c.cell, 0]));
    for (const p of live) if (p.current) byCell[p.current]++;
    return { line: cfg.line, table: cfg.dataTable, on: !!settings.lines[cfg.line], cells: cfg.cells.map(c => ({ cell: c.cell, op: c.op, parts: byCell[c.cell] })), inProgress: live.length,
      waiting: parts.filter(p => p.line === cfg.line && !p.cells[0].done).length };
  });
  const recent = [];
  for (const cfg of LINES) {
    const r = tables[cfg.dataTable].rows.slice(-6).reverse();
    for (const row of r) {
      const filled = Object.entries(row).filter(([k, v]) => k !== '_ms' && v !== null && v !== '').length;
      recent.push({ line: cfg.line, id: row.ID, ts: row.TimeStamp, qr: printable(row.QR_Code), filled, of: tables[cfg.dataTable].columns.length });
    }
  }
  return { now: sqlTs(now), settings, stats, tables: tableList(), wip, recent, requests: requestLog };
}

function setSettings(body = {}) {
  if (typeof body.running === 'boolean') settings.running = body.running;
  if (body.speed) settings.speed = Math.min(60, Math.max(1, Number(body.speed) || 1));
  if (body.historyHours !== undefined) settings.historyHours = Math.min(48, Math.max(0, Number(body.historyHours) || 0));
  if (body.lines) for (const k of Object.keys(settings.lines)) if (body.lines[k] !== undefined) settings.lines[k] = !!body.lines[k];
  if (body.takt) for (const k of Object.keys(settings.takt)) if (body.takt[k]) settings.takt[k] = Math.min(600, Math.max(20, Number(body.takt[k])));
  if (body.faults) for (const k of Object.keys(settings.faults)) if (body.faults[k] !== undefined) settings.faults[k] = Math.min(1, Math.max(0, Number(body.faults[k])));
  return settings;
}

/** One row with only its non-empty columns, NULs shown as `·`, for the row inspector. */
function rowDetail(table, id) {
  const t = tables[table]; if (!t) return null;
  const r = t.rows.find(x => (x.ID ?? x.Id) === Number(id)); if (!r) return null;
  return Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== '_ms' && v !== null && v !== '').map(([k, v]) => [k, typeof v === 'string' ? printable(v) : v]));
}

function printable(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/\u0000+$/, '').replace(/\u0000/g, '·').replace(/[^\x20-\x7e·]/g, '?');
}

module.exports = { start, reset: start, rows, tableList, getStatus, setSettings, rowDetail, settings };
