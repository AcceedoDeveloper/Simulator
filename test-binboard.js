/* Check of binboard.js - one Software and one Board simulator talk through a real
 * (embedded aedes) broker on a spare port, and the take is checked at both ends.
 *   node test-binboard.js
 * Exits non-zero if anything is wrong. Takes ~15 s (the board reads once a second). */
'use strict';
const broker = require('./mqttbroker');
const { createBinBoard } = require('./binboard');

const PORT = 18830;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);
  if (!ok) failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(100); }
  return false;
}

(async () => {
  const origLog = console.log;
  console.log = (...a) => { if (/^(PASS|FAIL)/.test(String(a[0]))) origLog(...a); };   // keep the output to results
  await broker.start(PORT);
  await wait(200);

  const sw = createBinBoard({ embeddedPort: PORT });
  const bd = createBinBoard({ embeddedPort: PORT });
  sw.setRole('software'); bd.setRole('board');
  sw.connect({ target: 'embedded', clientId: 't-software' });
  bd.connect({ target: 'embedded', clientId: 't-board' });
  check('both connect', await until(() => sw.getStatus().link.connected && bd.getStatus().link.connected));
  await wait(300);   // subscriptions settle

  const swBin = (n) => sw.getStatus().bins.find((b) => b.bin === n);
  const bdBin = (n) => bd.getStatus().bins.find((b) => b.bin === n);

  /* bin weights: the board sends every bin's scale in grams; the software takes them as kg */
  await bd.action({ action: 'weight', bin: 1, set: 89.26 });
  await bd.action({ action: 'weight', bin: 2, set: 0 });
  check('software takes bin weights from the weights topic', await until(() => swBin(1).weight === 89.26 && swBin(2).weight === 0 && swBin(3).weight === 10000),
        `B1=${swBin(1).weight} B2=${swBin(2).weight} B3=${swBin(3).weight}`);
  const data = bd.getStatus().log.filter((e) => e.dir === 'out' && e.topic === 'melting/board1/weights').pop();
  check('the bin weights have the ESP32 shape', data &&
        /^\{"B1":"89260","B2":"0","B3":"10000000",.*"B8":"10000000","sec":0,"onl":255,"hook":0,"hookConv":0,"hookOk":0\}$/.test(data.payload),
        data && data.payload);
  check('software ignores sec, onl and the hook fields', sw.getStatus().bins.every((b) => b.bin >= 1 && b.bin <= 8));
  await bd.action({ action: 'weight', bin: 1, set: 10000 });
  await bd.action({ action: 'weight', bin: 2, set: 10000 });
  await until(() => swBin(1).weight === 10000 && swBin(2).weight === 10000);

  /* charge mix: Si 2 and Mn 1.5 at 0.5 kg/s, and Cu 0 - every row is sent as typed */
  await bd.action({ action: 'settings', rate: 0.5, overshoot: 0 });
  await sw.action({ action: 'charge', furnace: 1, heat: 'H1', bins: [{ bin: 3, need: 2 }, { bin: 6, need: 1.5 }, { bin: 1, need: 0 }] });
  const sent = sw.getStatus().log.find((e) => e.dir === 'out');
  check('charge is sent with the protocol shape',
    sent && JSON.stringify(JSON.parse(sent.payload)) ===
      '{"cmd":"charge","furnace":1,"heat":"H1","bins":[{"bin":3,"el":"Si","need":2},{"bin":6,"el":"Mn","need":1.5},{"bin":1,"el":"Cu","need":0}]}',
    sent && sent.payload);
  check('broker acknowledged the charge (PUBACK)', sent && sent.ack === true);
  check('board opened bins 3, 6 and 1 (need 0)', await until(() => bdBin(3).open && bdBin(6).open && bdBin(1).open && !bdBin(8).open));
  check('board knows the need', bdBin(3).need === 2 && bdBin(6).need === 1.5);

  /* the board drains to need; the software follows the readings */
  check('software sees Si 2 taken', await until(() => swBin(3).taken === 2, 10000), `taken=${swBin(3).taken}`);
  check('software sees Mn 1.5 taken', swBin(6).taken === 1.5, `taken=${swBin(6).taken}`);
  const tookCombined = bd.getStatus().log.some((e) => e.dir === 'out' && /"cmd":"took".*"bins":\[[^\]]*\{"bin":3,/.test(e.payload) && /"furnace":1/.test(e.payload));
  check('board sends one took with a bins list and the furnace', tookCombined);
  check('a bin does not close itself at its need', swBin(3).open && bdBin(3).open);

  /* operator puts 0.3 back into Si: taken falls */
  await bd.action({ action: 'settings', autoTake: false });
  await bd.action({ action: 'weight', bin: 3, delta: 0.3 });
  check('putting back lowers the take', await until(() => swBin(3).taken === 1.7), `taken=${swBin(3).taken}`);
  /* and takes 1 more: over the need */
  await bd.action({ action: 'weight', bin: 3, delta: -1 });
  check('taking past need shows it', await until(() => swBin(3).taken === 2.7), `taken=${swBin(3).taken}`);

  /* spectrum stage wants Mn only: Si gets a close, both settle */
  await sw.action({ action: 'charge', furnace: 1, heat: 'H1', stage: 'BATH 1', bins: [{ bin: 6, need: 1 }] });
  check('Si closed on the board by the stage', await until(() => !bdBin(3).open && bdBin(6).open));
  const saved = () => sw.getStatus().software.saved;
  const si = saved().find((s) => s.el === 'Si' && s.label === 'Charge mix');
  check('Si 2.7 kg saved on the charge mix', si && si.qtyTaken === 2.7, JSON.stringify(si));
  check('Mn 1.5 saved on the charge mix', saved().some((s) => s.el === 'Mn' && s.label === 'Charge mix' && s.qtyTaken === 1.5));
  check('the Si stock becomes its last weight', swBin(3).weight === 9997.3, `stock=${swBin(3).weight}`);

  /* board button opens Cr by hand, reporting furnace 1: the take goes on BATH 1, added */
  await bd.action({ action: 'settings', furnace: '1' });
  await bd.action({ action: 'open', bin: 5 });
  check('software sees the hand-opened bin', await until(() => swBin(5).open && swBin(5).manual));
  await bd.action({ action: 'weight', bin: 5, delta: -2 });
  check('hand-opened bin tied to heat H1', await until(() => swBin(5).heat === 'H1' && swBin(5).taken === 2), `heat=${swBin(5).heat} taken=${swBin(5).taken}`);
  await bd.action({ action: 'close', bin: 5 });
  check('Cr 2 kg added on BATH 1', await until(() => saved().some((s) => s.el === 'Cr' && s.label === 'BATH 1' && s.qtyTaken === 2)));

  /* grams */
  await bd.action({ action: 'settings', unit: 'g' });
  await bd.action({ action: 'weight', bin: 6, delta: -0.25 });
  check('a reading in grams is read as kg', await until(() => swBin(6).taken === 0.25), `taken=${swBin(6).taken}`);

  /* Finished from the software closes everything at both ends */
  await sw.action({ action: 'done' });
  check('done closes the board', await until(() => bd.getStatus().bins.every((b) => !b.open)));
  check('Mn 0.25 saved on BATH 1', saved().some((s) => s.el === 'Mn' && s.label === 'BATH 1' && s.qtyTaken === 0.25));

  /* testing-only Continuous send: the same charge again and again, until Finished */
  const charges = () => bd.getStatus().log.filter((e) => e.dir === 'in' && /"cmd":"charge"/.test(e.payload) && /"heat":"H2"/.test(e.payload)).length;
  await sw.action({ action: 'repeat', every: 0.3, furnace: 1, heat: 'H2', bins: [{ bin: 4, need: 1 }] });
  check('continuous send repeats the charge', await until(() => charges() >= 4, 4000), `board got ${charges()}`);
  check('the repeats change nothing else: one bin open', sw.getStatus().bins.filter((b) => b.open).length === 1);
  await sw.action({ action: 'done' });
  const atStop = charges();
  await wait(1200);
  check('Finished stops continuous send', charges() === atStop && sw.getStatus().software.repeat === null, `${atStop} -> ${charges()}`);

  sw.disconnect(); bd.disconnect();
  console.log = origLog;
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
