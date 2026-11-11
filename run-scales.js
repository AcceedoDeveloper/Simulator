/* ============================================================================
 * IotBench - scale simulator runner
 *
 * Starts the 6-scale Modbus RTU slave and gives you a live console to set
 * weights while the STM32 master is polling.
 *
 *   node run-scales.js <PORT> [baud]
 *   e.g.  node run-scales.js COM5
 *         node run-scales.js /dev/ttyUSB0 9600
 *
 * Or via env:  SERIAL_PORT=COM5 SERIAL_BAUD=9600 node run-scales.js
 * ========================================================================== */

'use strict';
const readline = require('readline');
const { startScaleSim, setBinWeight, getWeights } = require('./scales');

const path = process.argv[2] || process.env.SERIAL_PORT || 'COM5';
const baud = Number(process.argv[3] || process.env.SERIAL_BAUD || 9600);

startScaleSim({ path, baud });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'scales> ' });

function help() {
  console.log(`
Live commands:
  set <bin> <grams>   set bin (1..6) weight in grams      e.g.  set 3 12480
  kg  <bin> <kg>      set bin weight in kilograms          e.g.  kg 3 12.48
  list                show all bin weights
  help                show this help
  quit                exit
`);
}

function showList() {
  const w = getWeights();
  Object.keys(w).forEach((k) => console.log(`  bin ${k}: ${w[k]} g (${(w[k] / 1000).toFixed(3)} kg)`));
}

help();
rl.prompt();

rl.on('line', (line) => {
  const a = line.trim().split(/\s+/);
  const cmd = (a[0] || '').toLowerCase();
  try {
    if (cmd === 'set') setBinWeight(a[1], a[2]);
    else if (cmd === 'kg') setBinWeight(a[1], Math.round(Number(a[2]) * 1000));
    else if (cmd === 'list') showList();
    else if (cmd === 'help') help();
    else if (cmd === 'quit' || cmd === 'exit') { rl.close(); process.exit(0); }
    else if (cmd !== '') console.log(`unknown command: ${cmd} (type 'help')`);
  } catch (e) {
    console.log(`error: ${e.message}`);
  }
  rl.prompt();
});
