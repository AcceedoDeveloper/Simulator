/* Headless check of binsim.js - steps the engine with no timers or network.
 *   node test-binsim.js
 * Exits non-zero if anything is wrong. Re-run after editing the script table. */
'use strict';
const assert = require('assert');
const { Board, buildPayload, CYCLE_MS, TARGET, SCRIPT } = require('./binsim');

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);
  if (!ok) failed++;
};

/* run two full cycles, 10 ms at a time, keeping a 1 Hz payload series and a fine section trace */
const bd = new Board();
const sections = [];              // section after every 10 ms step
const secPayloads = [];           // what the app would see, once a second
const snaps = [];
for (let n = 0; n < (2 * CYCLE_MS) / 10 + 500; n++) {
  bd.step();
  const s = bd.snapshot();
  sections.push(s.sec);
  if (bd.t % 1000 === 0) { snaps.push(s); secPayloads.push(buildPayload(s)); }
}

check('cycle length is 163.6 s', CYCLE_MS === 163600, `(${CYCLE_MS} ms, ${SCRIPT.length} segments)`);

/* 1. section sequence */
const comp = sections.filter((s, i) => i === 0 || s !== sections[i - 1]);
const one = [0, 1, 2, 3, 2, 1, 0, 1, 0, 1, 2, 3, 2, 1, 0];
const want = one.concat(one.slice(1));
check('section sequence over two cycles', JSON.stringify(comp.slice(0, want.length)) === JSON.stringify(want),
      `[${comp.slice(0, want.length).join(',')}]`);

/* 2. payload format: same keys, same order, B values quoted, others numeric */
const RX = /^\{"B1":"\d+","B2":"\d+","B3":"\d+","B4":"\d+","B5":"\d+","B6":"\d+","B7":"\d+","B8":"\d+","sec":[0-3],"onl":\d+,"hook":\d+,"hookConv":-?\d+,"hookOk":[01]\}$/;
check('every payload matches the ESP32 publishBins() format', secPayloads.every((p) => RX.test(p)));
check('every payload is valid JSON', secPayloads.every((p) => { try { JSON.parse(p); return true; } catch (e) { return false; } }));
check('payload size well under the ESP32 384-byte buffer', Math.max(...secPayloads.map((p) => p.length)) < 384,
      `(max ${Math.max(...secPayloads.map((p) => p.length))} bytes)`);

/* 3. dropouts (first cycle only) */
const c1 = snaps.filter((s) => s.cycle === 0 && s.t > 12000);
check('bin 3 drops out (onl bit 2 clears) and returns', c1.some((s) => !(s.onl & 4)) && c1[c1.length - 1].onl === 255);
check('every other bin stays online after the first round', c1.every((s) => (s.onl | 4) === 255));
check('hookOk clears during the hook dropout and returns', c1.some((s) => s.hookOk === 0) && c1[c1.length - 1].hookOk === 1);

/* 4. weights and hook */
const atLoaded = snaps.find((s) => s.t >= 5000 + 30000 + 4000);
check('bins reach the recipe', atLoaded.bins.every((w, i) => Math.abs(w - TARGET[i]) <= 5), `[${atLoaded.bins.join(',')}]`);
const cyc0 = snaps.filter((s) => s.t <= CYCLE_MS);
const peak = Math.max(...cyc0.map((s) => s.hookConv)), low = Math.min(...cyc0.map((s) => s.hookConv));
check('hook peaks near 4200', peak >= 4188 && peak <= 4212, `(${peak})`);
const lowSnap = cyc0.find((s) => s.hookConv === low);
check('hook dips to about -350 with raw >= 8000 (sign-threshold path)', low >= -362 && low <= -338 && lowSnap.hook >= 8000,
      `(conv ${low}, raw ${lowSnap.hook})`);
check('bins are empty again before the cycle ends', snaps.find((s) => s.t >= CYCLE_MS - 20000).bins.every((w) => w === 0));

/* 5. seam: nothing odd where the loop wraps */
const seam = sections.slice(Math.floor(CYCLE_MS / 10) - 20, Math.floor(CYCLE_MS / 10) + 20);
check('loop seam is clean (section stays 0)', seam.every((s) => s === 0));

/* 6. X position topic: same keys/order as the ESP32 publishDistData(), follows the section */
const { PosModel, POS_ANCHOR_CM } = require('./binsim');
const pm = new PosModel();
const posMsgs = snaps.map((s) => pm.next(s.sec, Math.floor(s.t / 1000)));
const PRX = /^\{"X":\d+,"XS":\d+,"XV":1,"Y":\d+,"YS":\d+,"YV":1,"status":"ok","age_ms":\d+,"seq":\d+,"up_s":\d+\}$/;
check('position payloads match the ESP32 publishDistData() format', posMsgs.every((p) => PRX.test(p)) && posMsgs.every((p) => { try { JSON.parse(p); return true; } catch (e) { return false; } }));
check('position payload fits the ESP32 224-byte buffer', Math.max(...posMsgs.map((p) => p.length)) < 224, `(max ${Math.max(...posMsgs.map((p) => p.length))})`);
check('position seq increments by 1', posMsgs.every((p, i) => JSON.parse(p).seq === i + 1));
const xs = posMsgs.map((p) => JSON.parse(p).X);
const at3 = snaps.findIndex((s) => s.sec === 3);
check('X heads to the section-3 anchor and starts near section 0', Math.abs(xs[0] - POS_ANCHOR_CM[0]) < 10 && at3 >= 0 && Math.max(...xs) > POS_ANCHOR_CM[2]);

/* 7. seq1 */
const { SEQUENCES, compileSeq, evalSeq } = require('./binsim');
const cs = compileSeq(SEQUENCES.seq1);
const at = (s) => evalSeq(cs, s * 1000);
const osc = Array.from({ length: 50 }, (_, i) => at(i / 10).hook);                 // first 5 s, 100 ms steps
check('seq1: hook oscillates within 100..200 for the first 5 s', osc.every((h) => h >= 100 && h <= 200) && Math.max(...osc) - Math.min(...osc) > 60, `(${Math.min(...osc)}..${Math.max(...osc)})`);
check('seq1: starts in section 1 at X 1500', at(0).sec === 1 && at(0).x === 1500 && at(4.9).x === 1500);
const lowH = Math.min(...Array.from({ length: 60 }, (_, i) => at(5 + i / 10).hook));
check('seq1: hook reaches about -4235', lowH <= -4000, `(${lowH})`);
check('seq1: hook is 110 from 11 s and holds still for 10 s', [11, 15, 20, 20.9].every((s) => at(s).hook === 110));
check('seq1: crane moves section 1 -> 2 -> 3 while the hook holds 110', at(21.5).sec === 1 && at(26).sec === 2 && at(30).sec === 3 && at(21.5).hook === 110 && at(30).hook === 110 && at(21).x === 1500 && at(33).x === 3000);
check('seq1: weight holds 110 for 10 s at section 3, then drops to 0', at(36).hook === 110 && at(42.9).hook === 110 && at(44.5).hook > 0 && at(44.5).hook < 110 && at(45).hook === 0 && at(45).done, `(total ${cs.total / 1000} s)`);

/* 8. seq2 */
const c2 = compileSeq(SEQUENCES.seq2);
const at2 = (s) => evalSeq(c2, s * 1000);
check('seq2: starts section 1, X 2800, hook 0', at2(0).sec === 1 && at2(0).x === 2800 && at2(0).hook === 0 && at2(1.9).hook === 0);
check('seq2: hook jumps to -1100 and rises to -300 in 2 s', at2(2).hook === -1100 && at2(3).hook === -700 && at2(3.99).hook >= -310 && at2(3.99).hook <= -300);
check('seq2: ramps to 400 over 3 s, then to 800 over 4 s', at2(4).hook === -300 && at2(7).hook === 400 && at2(11).hook === 800 && at2(9).hook === 600);
check('seq2: settles at 710 and holds while crane goes section 1 -> 2 -> 3', at2(12).hook === 710 && at2(14).sec === 1 && at2(18).sec === 2 && at2(22).sec === 3 && at2(22).hook === 710 && at2(12).x === 2800 && at2(24).x === 3400);
check('seq2: drops 710 -> 0 in 3 s and finishes', at2(24).hook === 710 && at2(25.5).hook === 355 && at2(27).hook === 0 && at2(27).done, `(total ${c2.total / 1000} s)`);

/* 9. seq3 */
const c3 = compileSeq(SEQUENCES.seq3);
const at3s = (s) => evalSeq(c3, s * 1000);
const o3 = Array.from({ length: 50 }, (_, i) => at3s(2 + i / 10).hook);
check('seq3: starts section 3, X 2100, hook 0 for 2 s', at3s(0).sec === 3 && at3s(0).x === 2100 && at3s(1.9).hook === 0);
check('seq3: oscillates 100..200 for 5 s, then dips to -4235 and settles at 110', o3.every((h) => h >= 100 && h <= 200) && at3s(10).hook === -4235 && at3s(13).hook === 110);
check('seq3: holds 110 for 10 s, then moves section 3 -> 2 -> 1 (X falling)', [13, 18, 22.9].every((s) => at3s(s).hook === 110) && at3s(24).sec === 3 && at3s(28).sec === 2 && at3s(32).sec === 1 && at3s(23).x === 2100 && at3s(35).x === 600);
check('seq3: waits 10 s at section 1 then drops 110 -> 0', at3s(36).hook === 110 && at3s(44.9).hook === 110 && at3s(47).hook === 0 && at3s(47).done, `(total ${c3.total / 1000} s)`);

/* 10. seq4 */
const c4 = compileSeq(SEQUENCES.seq4);
const a4 = (s) => evalSeq(c4, s * 1000);
check('seq4: hook 0 while crane goes section 3 -> 2 -> 1, ending at X 1550', [0, 6, 11.9].every((s) => a4(s).hook === 0) && a4(0).sec === 3 && a4(5).sec === 2 && a4(9).sec === 1 && a4(12).x === 1550);
check('seq4: waits 3 s at X 1550 with hook 0', [12, 13.5, 14.99].every((s) => a4(s).hook === 0 && a4(s).x === 1550 && a4(s).sec === 1));
check('seq4: hook 0 -> 200 in 2 s, then -1000 rising to -200 in 5 s', a4(16).hook === 100 && a4(16.999).hook >= 199 && a4(17).hook === -1000 && a4(19.5).hook === -600 && a4(21.99).hook >= -205);
check('seq4: -200 -> 170 in 5 s, then waits 2 s at 170', a4(22).hook === -200 && a4(27).hook === 170 && a4(28.9).hook === 170 && a4(28).sec === 1);
check('seq4: crane goes 1 -> 2 -> 3 holding 170, then drops to 0 in 2 s', a4(31).sec === 1 && a4(35).sec === 2 && a4(39).sec === 3 && a4(40).hook === 170 && a4(41).hook === 170 && a4(42).hook === 85 && a4(43).hook === 0 && a4(43).done, `(total ${c4.total / 1000} s)`);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
