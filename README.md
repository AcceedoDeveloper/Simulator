# IotBench

> 📖 Full design, requirements, and how-to-run-locally docs are in **[doc/](doc/README.md)**. &nbsp;·&nbsp; Quick start: double-click **`start.bat`** (or `node server.js COM9`).

A small Node.js bench-test toolkit for the SkyFast/Janatics IoT boards. Two independent
simulators:

1. **HTTP reply server** (`server.js`) — emulates the production server the ESP32 POSTs to,
   with a browser UI to edit/replay the `$…#` reply frames. Run: `npm start` → http://localhost:9010/
2. **Scale simulator** (`scales.js` / `run-scales.js`) — emulates 6 industrial weighing scales
   as Modbus RTU slaves, so an STM32 master can be tested without real scales. (This document.)
3. **GDC PLC simulator** (`plc.js`, page `/plc`) — the machine PLC for ProductionMonitorV2 (below).
4. **Bin / crane data publisher** (`binsim.js`, page `/crane`) — replays the melting-line field
   cycle and publishes the ESP32's `bin/data` JSON to a broker (below).

---

## Bin / crane data publisher (`/crane`) — topic `bin/data`

Publishes, once a second, exactly the JSON the melting-line ESP32 builds in `publishBins()`:

```json
{"B1":"7500","B2":"12300",...,"B8":"6000","sec":1,"onl":255,"hook":4200,"hookConv":4200,"hookOk":1}
```

It replays one 163.6 s field cycle on a loop (crane crossings of gates A and C, the walking
path, bins loading and draining, the hook lifting and dumping, a bin and the hook scale each
dropping off the bus, and four fast same-sample crossings). `sec`, `onl` and `hookOk` come out
of a port of the real firmware logic (section tie-break v4, 10 ms sampling, 100 ms scale
round-robin, 2 s freshness) - not hand-written values. The weights and hook values are
**synthetic**, and the hook unit is unknown.

Use it when the boards cannot be flashed or are not on the desk: open
http://localhost:9010/crane, pick a target, press **Start**.

| Target | What happens |
|---|---|
| **This IotBench's broker** | published onto the embedded broker; visible on `/mqtt`, and to any client connected to this PC on :1883 |
| **External broker** | a small built-in MQTT client publishes to the host:port you give (QoS 0, not retained, like the ESP32). Plain TCP only - no TLS |

`192.168.96.11` is the **plant** broker and is refused - simulated data must never reach it
(set `ALLOW_PLANT=1` before starting if you really mean it). Speed x1..x10 compresses the cycle
for demos; at x1 the cadence matches the field.

The script table is a port of `s_script[]` in `FieldTest/simulate_weight_cranesection/.../fieldsim.c`
- change one, change the other. `node test-binsim.js` checks the engine (sections, ONL/HOOKOK
dropouts, weights, payload format) without any timers or network.

---

## Charge-mix bin board (`/bin`) — topics `melting/software/set-weights` ⇄ `bin/chargemix/reply`

Open http://localhost:9010/bin (or press **Bin** in the Crane | Bin switch on `/crane`). It first asks
how to act:

| Role | Plays | Use it to test |
|---|---|---|
| **Software** | the melting server: pick Charge mix 1 / 2 (editable), **Save** sends `charge`; spectrum stages send `charge` + `stage`; Open by hand / Close / Finished send `open`, `close`, `done`; `took` weights become Qty Taken (weight when opened − weight now), saved on the heat when the bin closes | the real board |
| **Board** | the bin machine: opens bins on `charge` / `open`, closes on `close` / `done`, sends each open bin's weight every second as `took`. Auto take drains `rate` kg/s up to need (+ overshoot), or step / set weights by hand; machine buttons send `open`, `close`, `done` | the melting server |

Bin weights travel on a third topic, **`melting/board1/weights`** (blank = off): the Board sends every bin's scale
once a second in the ESP32 format (`{"B1":"89260",...,"B8":"0","sec":0,"onl":255,"hook":0,...}`, grams as
strings), and the Software reads `B<n>` as bin n's weight in kg, ignoring `sec`, `onl` and the hook fields.

Broker: this IotBench's own (:1883) or an external one with host, port, username, password and client
id typed on the page (plain TCP, QoS 1; the plant broker is refused unless `ALLOW_PLANT=1`). Every message
sent and received is listed with its PUBACK. Messages follow `docs/bin-board-protocol.md` in the melting
server. `node test-binboard.js` runs a Software and a Board against each other through a real broker.

---

## GDC PLC simulator (Modbus RTU slave 1) — for ProductionMonitorV2

Run `start.bat COM9 plc` (or `node server.js COM9 plc`), then open **http://localhost:9010/plc**.
One COM port runs either the scales or the PLC, not both.

- **19200 8N2**, slave 1, answers any **FC03** read (the STM32 reads 31 registers @ `0x00C6` every 1 s).
- Register map (offset from 0x00C6, station n = 0..3): production `16+4n`, rejection `18+4n`,
  temp left `8+2n`, temp right `9+2n` (°C ×10). Must match `ProductionMonitorV2/Core/App/Config/config.h`.
- Panel: +1/+3 parts, +1 reject, set/reset counters (wraps at 65535), temperatures, auto production
  (one part every N s, a reject every M parts).
- Fault injection: **No reply**, **Bad CRC**, reply delay. Use these to check the STM32 shows `PLC=0` / rising `PLCERR`.
- The HTTP side also accepts `POST /MultiSlave` (GDC path used by the new ESP32), alongside `/production`.

---

## Scale simulator (Modbus RTU slave, bins 1..6)

The STM32 is the Modbus RTU **master** and polls scale slave IDs 1..6 round-robin
(~one bin every 150 ms, ~100 ms read timeout). This tool is the **slave**: it listens on the
serial port and answers each poll with the weight you've configured for that bin.

### Wiring

```
        STM32 board                 USB-RS485 adapter               PC (this tool)
   ┌──────────────────┐          ┌────────────────────┐          ┌──────────────┐
   │  RS485 A  ───────────────────  A / D+             │          │              │
   │  RS485 B  ───────────────────  B / D-             │  USB ───▶│  COMx        │
   │  GND      ───────────────────  GND                │          │              │
   └──────────────────┘          └────────────────────┘          └──────────────┘
```

- Use an **auto-direction** USB-RS485 adapter (handles DE/RE itself) — the code just writes
  the reply, no manual direction control.
- **A↔A, B↔B**, common **GND**. If you get no traffic, try swapping A/B (most common mistake).
- Half-duplex, **9600 8N1**.

### Protocol

| | Bytes | Layout |
|---|---|---|
| Request (master → us) | 8 | `<id> 03 00 25 00 02 <crcLo> <crcHi>` — read 2 regs @ `0x0025` |
| Response (us → master) | 9 | `<id> 03 04 <w3> <w2> <w1> <w0> <crcLo> <crcHi>` |

- Weight is a **32-bit big-endian unsigned integer in grams** (`w3` = most significant byte).
  - `12.480 kg = 12480 g = 0x000030C0` → data bytes `00 00 30 C0`.
- We reply **only** when `id ∈ 1..6`, `fn == 0x03`, `addr == 0x0025`, `qty == 0x0002`; anything
  else is ignored.
- **CRC-16/MODBUS** (poly `0xA001`, init `0xFFFF`), appended **low byte first**. Incoming CRCs
  are validated; outgoing CRCs are computed.

Worked example (bin 1, weight 12480 g):

```
RX:  01 03 00 25 00 02 D5 C0
TX:  01 03 04 00 00 30 C0 EE 63
```

### Install

```bash
npm install          # pulls in the serialport package
```

### Run

```bash
node run-scales.js <PORT> [baud]
# examples:
node run-scales.js COM5
node run-scales.js /dev/ttyUSB0 9600
# or:  npm run scales -- COM5
```

If the port can't be opened, the tool lists the available serial ports so you can pick the
right one. (Find it in Windows Device Manager → *Ports (COM & LPT)*.)

### Set weights live

While it's running, type at the `scales>` prompt:

```
set 3 12480     # bin 3 = 12480 grams
kg  3 12.48     # same, expressed in kg
list            # show all six bin weights
help            # command list
quit            # exit
```

Every poll and reply is logged as hex, along with which bin/weight was served:

```
[15:38:03.120] RX  01 03 00 25 00 02 D5 C0
[15:38:03.121] TX  01 03 04 00 00 30 C0 EE 63   -> bin 1 = 12480 g (12.480 kg)
```

### Programmatic use

```js
const { startScaleSim, setBinWeight, getWeights } = require('./scales');
startScaleSim({ path: 'COM5', baud: 9600 });
setBinWeight(2, 5000);      // bin 2 = 5.000 kg
console.log(getWeights());  // { 1:0, 2:5000, 3:0, 4:0, 5:0, 6:0 }
```
