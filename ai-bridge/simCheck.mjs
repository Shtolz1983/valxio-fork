// The simulation check of a register-map card (sim.model "regmap"): the
// card's example, compiled by verifyCard, runs on an Arduino Nano (avr8js in
// a worker thread, the tab's own RegmapChip on its TWI / SPI) and on an ESP32
// (the backend's QEMU worker over its WebSocket, the Python twin of the chip).
// Each run sets the panel to values A, reads Serial, moves the panel to B and
// reads again: every control's value has to show up as a printed number in
// both phases, which proves Serial follows the panel through the register map.
//
// Problems are written for the AI that wrote the card. A run that fails for
// reasons of its own (backend down, worker crash, no Serial at all) is a step
// marked "skipped", never a problem: the card is not blocked by the harness.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import * as avr from 'avr8js';

import { RegmapChip, regmapNumber } from '../frontend/src/partsCatalog/regmap.ts';

const AVR_HZ = 16_000_000;
/** Guest time per phase on the Nano. */
const NANO_PHASE_S = 6;
/** Wall time per phase on the ESP32: the first one includes the boot. */
const ESP32_PHASE_MS = [60_000, 30_000];
/** Lines a phase must have before it can pass. */
const MIN_LINES = 2;
/** The ESP32 record's pin key: any number no GPIO uses. */
const ESP32_RECORD_PIN = 1000;

// ── Test values and number matching ───────────────────────────────────────

function decimals(x) {
  const s = String(x);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

/**
 * Two panel settings: A ≈ 30 % and B ≈ 70 % of each control's range, on its
 * step, distinct from each other and from the control's default (a sketch
 * that prints a constant must not pass).
 */
export function pickValues(controls) {
  const A = {};
  const B = {};
  for (const k of controls) {
    const dp = Math.max(decimals(k.step), decimals(k.min));
    const fix = (v) => Number(v.toFixed(Math.min(dp, 12)));
    const snap = (v) => fix(Math.min(k.max, Math.max(k.min, k.min + Math.round((v - k.min) / k.step) * k.step)));
    const same = (x, y) => Math.abs(x - y) < k.step / 2;
    const away = (v, avoid) => {
      for (let i = 1; i < 1000; i++) {
        for (const c of [v + i * k.step, v - i * k.step]) {
          const s = snap(c);
          if (s >= k.min && s <= k.max && !avoid.some((x) => same(s, x))) return s;
        }
      }
      return v;
    };
    let a = snap(k.min + 0.3 * (k.max - k.min));
    if (same(a, k.default)) a = away(a, [k.default]);
    let b = snap(k.min + 0.7 * (k.max - k.min));
    if (same(b, k.default) || same(b, a)) b = away(b, [k.default, a]);
    A[k.key] = a;
    B[k.key] = b;
  }
  return { A, B };
}

/** The numbers on a line, each with the decimals it was printed with. Hex (0x1F) is skipped. */
export function numbersIn(line) {
  const out = [];
  const clean = line.replace(/0x[0-9a-fA-F]+/g, ' ');
  for (const m of clean.matchAll(/(?<![\d.])-?\d+(?:\.\d+)?/g)) {
    out.push({ n: Number(m[0]), d: decimals(m[0].replace(/^-/, '')), text: m[0] });
  }
  return out;
}

/** How far a printed number may be from the panel value: print rounding, the step, 1.5 % of the range. */
export function tolerance(control, d) {
  return Math.max(0.6 * 10 ** -d, control.step, 0.015 * (control.max - control.min));
}

/** Whether `line` shows `value` of `control`. */
export function lineShows(line, control, value) {
  return numbersIn(line).some(({ n, d }) => Math.abs(n - value) <= tolerance(control, d) + 1e-9);
}

/** ESP-IDF / ROM boot chatter: not the sketch's output. */
const BOOT_LINE = /^(ets |rst:|configsip|clk_drv|mode:|load:|entry |ho \d|[IWEDV] \(\d+\))/;

export function sketchLines(lines) {
  return lines.filter((l) => l.trim() && !BOOT_LINE.test(l));
}

/** Controls whose value no line of the phase shows. */
export function missingIn(lines, controls, values) {
  return controls.filter((k) => !lines.some((l) => lineShows(l, k, values[k.key]))).map((k) => k.key);
}

/**
 * A phase ends when Serial shows its values, or when it has printed enough
 * lines that waiting longer would not change the verdict.
 */
function phaseDone(lines, controls, values) {
  const own = sketchLines(lines);
  if (own.length >= Math.max(10, 4 * controls.length + 2)) return true;
  return own.length >= MIN_LINES && missingIn(own, controls, values).length === 0;
}

// ── Arduino Nano: avr8js ──────────────────────────────────────────────────

/** Intel HEX → flash bytes. */
export function parseHex(text, size = 0x8000) {
  const flash = new Uint8Array(size);
  let base = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(':')) continue;
    const len = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (type === 0) {
      for (let i = 0; i < len; i++) {
        const at = base + addr + i;
        if (at < size) flash[at] = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
      }
    } else if (type === 2) {
      base = parseInt(line.slice(9, 13), 16) << 4;
    } else if (type === 4) {
      base = parseInt(line.slice(9, 13), 16) << 16;
    } else if (type === 1) {
      break;
    }
  }
  return flash;
}

/**
 * The example on an ATmega328P at 16 MHz with the chip on its bus: TWI at
 * `addr` for an I2C map, SPI with CS on D10 (PB2, active low) for an SPI one.
 * Each phase runs until Serial shows its values (and at least MIN_LINES
 * lines) or NANO_PHASE_S of guest time. Synchronous: run it in a worker.
 */
export function runNano({ hex, spec, addr, controls, phases, phaseSeconds = NANO_PHASE_S }) {
  const flash = parseHex(hex);
  const cpu = new avr.CPU(new Uint16Array(flash.buffer));
  const chip = new RegmapChip(spec);
  chip.values = { ...phases[0] };
  // millis() / delay(); the peripherals live on through the CPU's hooks.
  new avr.AVRTimer(cpu, avr.timer0Config);
  new avr.AVRTimer(cpu, avr.timer1Config);
  new avr.AVRTimer(cpu, avr.timer2Config);
  let text = '';
  const usart = new avr.AVRUSART(cpu, avr.usart0Config, AVR_HZ);
  usart.onByteTransmit = (b) => {
    text += String.fromCharCode(b);
  };
  const stats = { i2c: 0, spi: 0 };

  // I2C: the chip answers its address, anything else NACKs (as the tab's bus does).
  const twi = new avr.AVRTWI(cpu, avr.twiConfig, AVR_HZ);
  let onChip = false;
  twi.eventHandler = {
    start: () => twi.completeStart(),
    stop: () => {
      if (onChip) chip.stop();
      onChip = false;
      twi.completeStop();
    },
    connectToSlave: (a, write) => {
      onChip = spec.bus === 'i2c' && a === addr;
      if (onChip) {
        stats.i2c++;
        chip.start(!write);
      }
      twi.completeConnect(onChip);
    },
    writeByte: (v) => twi.completeWrite(onChip ? chip.writeByte(v) : false),
    readByte: () => twi.completeRead(onChip ? chip.readByte() & 0xff : 0xff),
  };

  // SPI: CS is D10 = PB2, driven low by the sketch to select the chip.
  const portB = new avr.AVRIOPort(cpu, avr.portBConfig);
  let selected = false;
  portB.addListener((value) => {
    const now = spec.bus === 'spi' && (cpu.data[avr.portBConfig.DDR] & 4) !== 0 && (value & 4) === 0;
    if (now === selected) return;
    selected = now;
    if (now) chip.select();
    else chip.deselect();
  });
  const spi = new avr.AVRSPI(cpu, avr.spiConfig, AVR_HZ);
  spi.onByte = (mosi) => {
    if (selected) stats.spi++;
    spi.completeTransfer(selected ? chip.transfer(mosi) & 0xff : 0xff);
  };

  const lines = () => text.split('\n').slice(0, -1).map((l) => l.replace(/\r$/, ''));
  const out = [];
  const t0 = Date.now();
  const slice = 160_000; // 10 ms of guest time between checks
  for (let p = 0; p < phases.length; p++) {
    chip.values = { ...phases[p] };
    // A line half printed when the panel moved belongs to the old values.
    const from = lines().length + (text.endsWith('\n') || text === '' ? 0 : 1);
    const start = cpu.cycles;
    const end = start + phaseSeconds * AVR_HZ;
    let phaseLines = [];
    while (cpu.cycles < end) {
      const stopAt = Math.min(end, cpu.cycles + slice);
      while (cpu.cycles < stopAt) {
        avr.avrInstruction(cpu);
        cpu.tick();
      }
      phaseLines = lines().slice(from);
      if (phaseDone(phaseLines, controls, phases[p])) break;
    }
    out.push({ lines: phaseLines, guestS: (cpu.cycles - start) / AVR_HZ });
  }
  return { phases: out, wallMs: Date.now() - t0, stats };
}

/** runNano in a worker thread, so the bridge's event loop stays free. */
function runNanoInWorker(opts, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { simCheckNano: opts } });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ error: `no result in ${timeoutMs / 1000} s` });
    }, timeoutMs);
    worker.once('message', (m) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(m);
    });
    worker.once('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.message });
    });
  });
}

if (!isMainThread && workerData?.simCheckNano) {
  try {
    parentPort.postMessage(runNano(workerData.simCheckNano));
  } catch (e) {
    parentPort.postMessage({ error: e.message });
  }
}

// ── ESP32: the backend's QEMU worker ──────────────────────────────────────

/** The SPI bus map entry the tab sends for a regmap chip on VSPI, CS GPIO5. */
function spiEntry(owner, spec, values) {
  return {
    owner,
    bus_id: 3,
    cs: { kind: 'hw', index: 0, gpio: 5, active_low: true },
    model: {
      wasm_b64: '',
      catalog: 'regmap',
      regmap: spec,
      pin_map: { SCK: 18, MOSI: 23, MISO: 19, CS: 5 },
      attrs: values,
      blobs: {},
      blob_ids: {},
    },
  };
}

async function runEsp32({ velxioUrl, firmware, spec, addr, controls, phases, owner, phaseMs = ESP32_PHASE_MS }) {
  const t0 = Date.now();
  const url = `${velxioUrl.replace(/^http/, 'ws')}/api/simulation/ws/${encodeURIComponent(`${owner}-${Date.now()}`)}`;
  let ws;
  try {
    ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no connection in 10 s')), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e?.message || 'WebSocket error'));
      };
    });
  } catch (e) {
    try {
      ws?.close();
    } catch {}
    return { error: `WebSocket ${url}: ${e.message}` };
  }
  let text = '';
  const errors = [];
  let closed = false;
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === 'serial_output' && !(m.data?.uart > 0)) text += m.data?.data ?? '';
    else if (m.type === 'error') errors.push(String(m.data?.message ?? JSON.stringify(m.data)));
    else if (m.type === 'system' && m.data?.event === 'crash') errors.push(`crash: ${JSON.stringify(m.data).slice(0, 200)}`);
  };
  ws.onclose = () => {
    closed = true;
  };
  const send = (type, data) => ws.send(JSON.stringify({ type, data }));
  if (spec.bus === 'i2c') {
    send('start_esp32', {
      board: 'esp32',
      firmware_b64: firmware,
      sensors: [{ sensor_type: 'catalog-i2c', pin: ESP32_RECORD_PIN, model: 'regmap', regmap: spec, addr, owner, ...phases[0] }],
    });
  } else {
    send('start_esp32', {
      board: 'esp32',
      firmware_b64: firmware,
      sensors: [],
      bus_map: { spi: [spiEntry(owner, spec, phases[0]), { sinks: { all: false, cs: [] } }] },
    });
  }
  const lines = () => text.split('\n').slice(0, -1).map((l) => l.replace(/\r$/, ''));
  const out = [];
  for (let p = 0; p < phases.length; p++) {
    if (p > 0) {
      if (spec.bus === 'i2c') send('esp32_sensor_update', { pin: ESP32_RECORD_PIN, ...phases[p] });
      else send('esp32_bus_attrs', { owner, attrs: phases[p] });
    }
    const from = lines().length + (text.endsWith('\n') || text === '' ? 0 : 1);
    const start = Date.now();
    const end = start + phaseMs[p];
    let phaseLines = [];
    while (Date.now() < end && !closed && !errors.length) {
      await new Promise((r) => setTimeout(r, 200));
      phaseLines = lines().slice(from);
      if (phaseDone(phaseLines, controls, phases[p]) || phaseLines.some((l) => CRASH.test(l))) break;
    }
    out.push({ lines: phaseLines, wallS: (Date.now() - start) / 1000 });
    // A crash loop prints no readings in the next phase either.
    if (closed || errors.length || phaseLines.some((l) => CRASH.test(l))) break;
  }
  try {
    send('stop_esp32', {});
    ws.close();
  } catch {}
  const all = sketchLines(lines());
  if (errors.length) return { error: `the ESP32 worker reported: ${errors.join('; ').slice(0, 300)}`, phases: out };
  const crashed = out.some((p) => p.lines.some((l) => CRASH.test(l)));
  if (closed && !crashed && out.length < phases.length) return { error: 'the backend closed the WebSocket', phases: out };
  if (!all.length) return { error: `no Serial output in ${phaseMs[0] / 1000} s`, phases: out };
  return { phases: out, wallMs: Date.now() - t0 };
}

// ── Verdict ───────────────────────────────────────────────────────────────

/** A guest crash as the ESP32 core reports it. */
const CRASH = /Guru Meditation|panic'ed|abort\(\) was called|^Backtrace:/;

const clip = (s, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

function quote(lines, max = 6) {
  const own = sketchLines(lines);
  if (!own.length) return '  (nothing)';
  // Repeats fold into one line with a count.
  const runs = [];
  for (const l of own) {
    if (runs.length && runs[runs.length - 1].l === l) runs[runs.length - 1].n++;
    else runs.push({ l, n: 1 });
  }
  return runs
    .slice(-max)
    .map(({ l, n }) => `  | ${clip(l)}${n > 1 ? `   (×${n})` : ''}`)
    .join('\n');
}

const fmt = (v) => String(Number(v.toFixed(6)));

/** Lines of the same shape (numbers aside) in both phases: the numbers that moved with the panel. */
function movedNumbers(linesA, linesB) {
  const shape = (l) => l.replace(/0x[0-9a-fA-F]+/g, 'H').replace(/(?<![\d.])-?\d+(?:\.\d+)?/g, '#');
  const moved = [];
  const seen = new Set();
  for (const b of sketchLines(linesB).slice().reverse()) {
    const a = sketchLines(linesA).slice().reverse().find((l) => shape(l) === shape(b));
    if (!a || seen.has(shape(b))) continue;
    seen.add(shape(b));
    const na = numbersIn(a);
    const nb = numbersIn(b);
    na.forEach((x, i) => {
      if (nb[i] && nb[i].n !== x.n) moved.push({ from: x.text, to: nb[i].text, a: x.n, b: nb[i].n, line: b });
    });
  }
  return moved;
}

/** What the AI should fix, from the two phases of one board's run. */
export function boardProblems(board, card, phases, A, B) {
  const controls = card.sim.controls;
  const spec = card.sim.regmap;
  const [pa, pb] = [phases[0]?.lines ?? [], phases[1]?.lines ?? []];
  const crash = [...pa, ...pb].filter((l) => CRASH.test(l));
  if (crash.length) {
    return [
      `simulation on ${board}: the sketch crashes and the board reboots:\n` +
        crash.slice(0, 3).map((l) => `  | ${clip(l)}`).join('\n') +
        '\nThis is the example or its library, not sim.regmap. A "Coprocessor exception" at boot is a library doing ' +
        'floating point in a global object\'s constructor: create the object inside setup() (a pointer and `new`), ' +
        'or pick a library that does not; otherwise check the example for null pointers and stack-heavy locals.',
    ];
  }
  const missA = missingIn(sketchLines(pa), controls, A);
  const missB = missingIn(sketchLines(pb), controls, B);
  const failed = controls.filter((k) => missA.includes(k.key) || missB.includes(k.key));
  if (!failed.length) return [];
  const all = [...sketchLines(pa), ...sketchLines(pb)];
  const hints = [];
  if (all.some((l) => /not found|fail|error|could not|couldn't|no sensor|not detected|check wiring|invalid/i.test(l))) {
    hints.push(
      'the library printed an error ("not found"/"failed") → it reads a chip ID / WHO_AM_I, a status or a calibration register ' +
        'that is missing from sim.regmap.registers (or holds the wrong byte); give it the value the datasheet lists',
    );
  }
  const moved = movedNumbers(pa, pb);
  const parts = [];
  for (const k of failed) {
    const which = (spec?.values ?? []).map((v, i) => (v.from === k.key ? `sim.regmap.values[${i}]` : null)).filter(Boolean);
    const where = which.length ? which.join(', ') : 'no sim.regmap.values entry reads it';
    let s = `"${k.key}" was set to ${fmt(A[k.key])} then ${fmt(B[k.key])} (${where}); `;
    s += missA.includes(k.key) && missB.includes(k.key) ? 'no printed number matched either value' : missA.includes(k.key) ? `no printed number matched ${fmt(A[k.key])}` : `no printed number matched ${fmt(B[k.key])}`;
    s += ` (±${fmt(tolerance(k, 2))})`;
    // A number that moved with the panel and is no other control's value: the reading, scaled wrong.
    const cand = moved.filter((m) => !controls.some((o) => Math.abs(m.b - B[o.key]) <= tolerance(o, decimals(m.to.replace(/^-/, '')))));
    if (cand.length) {
      const m = cand[0];
      const ratio = (n, v) => (Math.abs(v) > 1e-9 ? ` (×${fmt(Number((n / v).toPrecision(3)))})` : '');
      s +=
        `. A number moved with the panel: ${m.from} at ${fmt(A[k.key])}${ratio(m.a, A[k.key])}, ${m.to} at ${fmt(B[k.key])}${ratio(m.b, B[k.key])}` +
        ' → the reading arrives but is converted wrong: check scale/offset/shift/bytes/signed of that value and width. ' +
        'The same ratio in both phases means scale is off by that factor; a ratio that differs because one end ' +
        'is stuck at a round limit means the raw number overflows its bytes (scale too large, or bytes/shift wrong); ' +
        'also check the example prints the value in the control\'s unit';
    } else if (all.length && !moved.length) {
      s +=
        '. Nothing Serial printed changed when the panel moved → the library reads other registers than sim.regmap.values[].reg ' +
        '(or a different byte count/order), or it never got past its init';
    }
    parts.push(s);
  }
  return [
    `simulation on ${board}: Serial does not follow the panel — ${parts.join('; ')}.` +
      (hints.length ? ` Hint: ${hints.join('; ')}.` : '') +
      `\nSerial with ${controls.map((k) => `${k.key}=${fmt(A[k.key])}`).join(', ')}:\n${quote(pa)}` +
      `\nSerial with ${controls.map((k) => `${k.key}=${fmt(B[k.key])}`).join(', ')}:\n${quote(pb)}`,
  ];
}

/**
 * Run the card's example with its register map on the Nano and the ESP32.
 * `firmware`: { uno: Intel HEX text, esp32: merged flash image base64 } from
 * the compile check; a board without firmware is skipped. Resolves
 * { ok, skipped, problems, steps } — never throws for a bad card.
 */
export async function simCheck(card, { velxioUrl, firmware = {}, log = () => {} } = {}) {
  const problems = [];
  const steps = [];
  const controls = card.sim?.controls ?? [];
  const spec = card.sim?.regmap;
  if (card.sim?.model !== 'regmap' || !spec || !controls.length) return { ok: true, skipped: true, problems, steps };
  const { A, B } = pickValues(controls);
  const addr = spec.bus === 'i2c' ? regmapNumber(card.i2c?.addresses?.[0] ?? NaN) : 0;
  const owner = `${card.id}-simcheck`;
  const change = controls.map((k) => `${k.key} ${fmt(A[k.key])} → ${fmt(B[k.key])}`).join(', ');
  let skipped = false;

  const nano = async () => {
    if (!firmware.uno) return { skip: 'no Uno firmware' };
    log('simulate on Nano');
    return runNanoInWorker({ hex: firmware.uno, spec, addr, controls, phases: [A, B] });
  };
  const esp32 = async () => {
    if (!firmware.esp32 || !velxioUrl) return { skip: 'no ESP32 firmware' };
    log('simulate on ESP32');
    return runEsp32({ velxioUrl, firmware: firmware.esp32, spec, addr, controls, phases: [A, B], owner });
  };
  const [n, e] = await Promise.all([nano().catch((err) => ({ error: err.message })), esp32().catch((err) => ({ error: err.message }))]);

  for (const [board, r] of [['Arduino Nano', n], ['ESP32', e]]) {
    if (r.skip || r.error) {
      skipped = true;
      steps.push(`simulation on ${board}: skipped — ${r.skip ?? r.error} (not a card problem)`);
      continue;
    }
    if (board === 'Arduino Nano' && !sketchLines(r.phases.flatMap((p) => p.lines)).length) {
      skipped = true;
      steps.push(
        `simulation on ${board}: skipped — no Serial output in ${r.phases.reduce((s, p) => s + p.guestS, 0).toFixed(1)} s of guest time ` +
          `(${spec.bus === 'i2c' ? `${r.stats.i2c} I2C transactions with 0x${addr.toString(16)}` : `${r.stats.spi} SPI bytes with CS on D10`}; not a card problem)`,
      );
      continue;
    }
    const time = r.wallMs !== undefined ? ` (${(r.wallMs / 1000).toFixed(1)} s)` : '';
    const found = boardProblems(board, card, r.phases, A, B);
    if (found.length) problems.push(...found);
    else steps.push(`simulation on ${board}: Serial follows the panel, ${change}${time}`);
  }
  return { ok: problems.length === 0, skipped, problems, steps };
}
