/**
 * Logic-level circuit validator: the microcontroller-side mistakes the SPICE
 * pre-flight (simulation/verify/circuitVerifier.ts) cannot see because they
 * are about what a pin can do, not about currents — an output on an
 * input-only GPIO, two I2C devices at one address, a 5 V sensor output into a
 * 3.3 V board, a bus on the wrong pins, a required signal left unwired.
 *
 * Pure: takes boards, components, wires (and optionally each board's sketch
 * for the code-aware rules) and returns findings in the verifier's
 * CircuitWarning shape, so both lists merge into one "Circuit check".
 * Knowledge about parts and boards lives in ./partsKnowledge.ts.
 */
import { UnionFind } from '../simulation/spice/unionFind';
import { unionBreadboardGroups } from '../simulation/spice/NetlistBuilder';
import type { CircuitWarning } from '../simulation/verify/circuitVerifier';
import { COMPONENT_RATINGS } from '../simulation/verify/componentRatings';
import { boardPinToNumber } from '../utils/boardPinMapping';
import {
  boardKnowledge,
  partKnowledge,
  parseI2cAddress,
  type BoardKnowledge,
  type PartKnowledge,
  type PinRole,
} from './partsKnowledge';

interface Endpoint {
  componentId: string;
  pinName: string;
}

export interface ValidatorInput {
  boards: ReadonlyArray<{ id: string; boardKind: string }>;
  components: ReadonlyArray<{ id: string; metadataId: string; properties?: Record<string, unknown> }>;
  wires: ReadonlyArray<{ id: string; start: Endpoint; end: Endpoint }>;
  /** Sketch source per board id (all files joined), for code-aware rules. */
  code?: Readonly<Record<string, string>>;
}

interface BoardPin {
  boardId: string;
  info: BoardKnowledge;
  pinName: string;
  gpio: number;
}

interface PartPin {
  componentId: string;
  label: string;
  pinName: string;
  role: PinRole;
}

interface Group {
  gpios: BoardPin[];
  /** Board supply pins in the group: volts, or 'gnd'. */
  rails: Array<number | 'gnd'>;
  parts: PartPin[];
}

// Lines the board must be able to drive.
const MCU_DRIVES = new Set<PinRole>(['mcu-out', 'bidir', 'i2c-sda', 'i2c-scl', 'spi-sck', 'spi-mosi', 'spi-cs']);
// Lines a part pulls or drives at any time (matter on boot-strap pins).
const PART_DRIVES = new Set<PinRole>(['mcu-in', 'analog-in', 'bidir', 'i2c-sda', 'i2c-scl', 'spi-miso']);
// One part per GPIO: everything except shared bus lines.
const EXCLUSIVE = new Set<PinRole>(['mcu-out', 'mcu-in', 'analog-in', 'bidir']);
// Push-pull outputs that carry the part's supply voltage into the board.
const PUSH_PULL_TO_MCU = new Set<PinRole>(['mcu-in', 'bidir', 'spi-miso']);

const key = (componentId: string, pinName: string) => `${componentId}:${pinName}`;

function railVolts(pinName: string): number | 'gnd' | null {
  const n = pinName.toUpperCase();
  if (/^(GND|VSS)/.test(n)) return 'gnd';
  if (/^(3V3|3\.3V)/.test(n)) return 3.3;
  if (/^(5V|VBUS|VUSB|VIN|VSYS)/.test(n)) return 5;
  return null;
}

const isPassThrough = (metadataId: string) => metadataId.startsWith('resistor');

/** Switches only hold a line while pressed, so they cannot jam a boot-strap pin at reset. */
function isMomentary(input: ValidatorInput, componentId: string): boolean {
  const comp = input.components.find((c) => c.id === componentId);
  return !!comp && !!partKnowledge(comp.metadataId)?.momentary;
}

function gpioLabel(p: BoardPin): string {
  return p.pinName === String(p.gpio) ? `GPIO${p.gpio}` : `${p.pinName} (GPIO${p.gpio})`;
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

/**
 * Nets over wires and breadboard strips. With `passThrough`, a resistor's
 * two legs count as one signal line (an LED behind its series resistor is
 * still "on GPIO 5").
 */
function buildGroups(input: ValidatorInput, passThrough: boolean): Map<string, Group> {
  const uf = new UnionFind();
  const boards = new Map(input.boards.map((b) => [b.id, b]));
  const comps = new Map(input.components.map((c) => [c.id, c]));

  // Board pads that are the same GPIO (Uno 'A4' and 'A4.2') are one node.
  const nodeOf = (e: Endpoint): string => {
    const board = boards.get(e.componentId);
    if (board) {
      const gpio = boardPinToNumber(board.boardKind, e.pinName);
      if (gpio !== null && gpio >= 0) return `${board.id}:gpio${gpio}`;
    }
    return key(e.componentId, e.pinName);
  };

  const endpoints = new Map<string, Endpoint>();
  for (const w of input.wires) {
    const a = nodeOf(w.start);
    const b = nodeOf(w.end);
    uf.add(a);
    uf.add(b);
    uf.union(a, b);
    endpoints.set(key(w.start.componentId, w.start.pinName), w.start);
    endpoints.set(key(w.end.componentId, w.end.pinName), w.end);
  }
  unionBreadboardGroups(uf, input.components, [...input.wires], key);

  if (passThrough) {
    // Only a SERIES resistor carries the signal: one leg on a GPIO line, the
    // other on a line with no board pin at all (the part it feeds). A pull-up
    // or pull-down (other leg on a rail) or a divider between two GPIOs keeps
    // its lines apart — joining through it would merge every pulled-down
    // button into one net.
    const boardFlags = new Map<string, { gpio: boolean; rail: boolean }>();
    for (const e of endpoints.values()) {
      const board = boards.get(e.componentId);
      if (!board) continue;
      const root = uf.find(nodeOf(e));
      const f = boardFlags.get(root) ?? { gpio: false, rail: false };
      const gpio = boardPinToNumber(board.boardKind, e.pinName);
      if (gpio !== null && gpio >= 0) f.gpio = true;
      else if (railVolts(e.pinName) !== null) f.rail = true;
      boardFlags.set(root, f);
    }
    const none = { gpio: false, rail: false };
    for (const c of input.components) {
      if (!isPassThrough(c.metadataId)) continue;
      const legs = [...endpoints.values()].filter((e) => e.componentId === c.id).map(nodeOf);
      if (legs.length !== 2) continue;
      const a = boardFlags.get(uf.find(legs[0])) ?? none;
      const b = boardFlags.get(uf.find(legs[1])) ?? none;
      const series = (a.gpio && !b.gpio && !b.rail) || (b.gpio && !a.gpio && !a.rail);
      if (series) uf.union(legs[0], legs[1]);
    }
  }

  const groups = new Map<string, Group>();
  const groupOf = (node: string) => {
    const root = uf.find(node);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { gpios: [], rails: [], parts: [] }));
    return g;
  };
  const seenGpio = new Set<string>();

  for (const e of endpoints.values()) {
    const node = nodeOf(e);
    const board = boards.get(e.componentId);
    if (board) {
      const info = boardKnowledge(board.boardKind);
      const gpio = boardPinToNumber(board.boardKind, e.pinName);
      if (info && gpio !== null && gpio >= 0) {
        if (seenGpio.has(node)) continue;
        seenGpio.add(node);
        groupOf(node).gpios.push({ boardId: board.id, info, pinName: e.pinName, gpio });
      } else {
        const rail = railVolts(e.pinName);
        if (rail !== null) groupOf(node).rails.push(rail);
      }
      continue;
    }
    const comp = comps.get(e.componentId);
    const knowledge = comp && partKnowledge(comp.metadataId);
    const role = knowledge?.pins[e.pinName];
    if (comp && knowledge && role) {
      groupOf(node).parts.push({ componentId: comp.id, label: knowledge.label, pinName: e.pinName, role });
    }
  }
  return groups;
}

/** Group lookup by part pin. */
function indexByPart(groups: Map<string, Group>): Map<string, Group> {
  const index = new Map<string, Group>();
  for (const g of groups.values()) for (const p of g.parts) index.set(key(p.componentId, p.pinName), g);
  return index;
}

function supplyOf(knowledge: PartKnowledge, componentId: string, elec: Map<string, Group>): number | undefined {
  let volts: number | undefined;
  for (const [pin, role] of Object.entries(knowledge.pins)) {
    if (role !== 'power') continue;
    for (const r of elec.get(key(componentId, pin))?.rails ?? []) {
      if (typeof r === 'number') volts = Math.max(volts ?? 0, r);
    }
  }
  return volts;
}

const WIRE_BEGIN_RE = /Wire\.begin\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*[,)]/;
// MicroPython picks its I2C pins in the constructor: I2C(0, sda=Pin(0), …).
const MICROPYTHON_RE = /\bfrom\s+machine\s+import\b|\bimport\s+machine\b/;
// Lines a part keeps HIGH at idle (pull-ups): harmless on straps that want HIGH.
const IDLE_HIGH = new Set<PinRole>(['i2c-sda', 'i2c-scl', 'bidir']);
const WIFI_RE =/#include\s*[<"](WiFi|WiFiClient|WiFiManager|HTTPClient|PubSubClient|ESPAsyncWebServer)[\w.]*[>"]|\bWiFi\.begin\s*\(/;

export function validateCircuit(input: ValidatorInput): CircuitWarning[] {
  const out: CircuitWarning[] = [];
  const add = (severity: CircuitWarning['severity'], code: CircuitWarning['code'], message: string, componentId?: string) =>
    out.push({ severity, code, message, componentId });

  const signal = buildGroups(input, true);
  const elec = indexByPart(buildGroups(input, false));
  const signalByPart = indexByPart(signal);
  const wiredPins = new Set(input.wires.flatMap((w) => [key(w.start.componentId, w.start.pinName), key(w.end.componentId, w.end.pinName)]));

  // ── Per-GPIO rules ─────────────────────────────────────────────────────
  for (const g of signal.values()) {
    if (g.gpios.length === 0) continue;

    if (g.gpios.length > 1) {
      const names = g.gpios.map((p) => `${p.boardId} ${gpioLabel(p)}`).join(' and ');
      add('warning', 'gpio-short', `${names} are wired together — two GPIOs on one line fight each other when both are outputs.`);
    }

    for (const bp of g.gpios) {
      const { info, boardId } = bp;
      const where = `${boardId} ${gpioLabel(bp)}`;
      const code = input.code?.[boardId] ?? '';

      for (const p of g.parts) {
        if (info.flash.includes(bp.gpio)) {
          add('error', 'flash-pin', `${p.componentId} ${p.pinName} is on ${where}, which the ${info.label} uses for its SPI flash — the board will not boot. Use another GPIO.`, p.componentId);
          continue;
        }
        if (info.inputOnly.includes(bp.gpio) && MCU_DRIVES.has(p.role)) {
          add('error', 'input-only-pin', `${p.componentId} ${p.pinName} needs the board to drive it, but ${where} is input-only on the ${info.label}. Move it to a GPIO that can output.`, p.componentId);
        }
        const harmlessHigh = IDLE_HIGH.has(p.role) && info.strappingHighOk.includes(bp.gpio);
        if (info.strapping.includes(bp.gpio) && PART_DRIVES.has(p.role) && !isMomentary(input, p.componentId) && !harmlessHigh) {
          add('warning', 'strapping-pin', `${p.componentId} ${p.pinName} is on ${where}, a boot-strapping pin of the ${info.label}: a part holding it at the wrong level during reset can stop the board from booting or from accepting uploads. Prefer another GPIO.`, p.componentId);
        }
        if (info.serial.includes(bp.gpio)) {
          add('warning', 'serial-pin', `${p.componentId} ${p.pinName} is on ${where}, which the ${info.label} shares with USB Serial — uploads and the Serial Monitor will interfere with it.`, p.componentId);
        }
        if (p.role === 'analog-in' && !info.analog.includes(bp.gpio)) {
          add('warning', 'no-adc', `${p.componentId} ${p.pinName} is an analog output, but ${where} has no ADC — analogRead() will not see it. Use an analog pin.`, p.componentId);
        }
        if (p.role === 'analog-in' && info.adc2.includes(bp.gpio) && WIFI_RE.test(code)) {
          add('warning', 'adc2-wifi', `${p.componentId} ${p.pinName} is on ${where}, an ADC2 channel; ADC2 stops working while Wi-Fi is on and this sketch uses Wi-Fi. Move it to an ADC1 pin.`, p.componentId);
        }
      }

      const exclusive = [...new Set(g.parts.filter((p) => EXCLUSIVE.has(p.role)).map((p) => p.componentId))];
      const driven = g.parts.some((p) => p.role === 'mcu-in' || p.role === 'analog-in' || p.role === 'bidir');
      if (exclusive.length > 1 && driven) {
        const who = g.parts.filter((p) => EXCLUSIVE.has(p.role)).map((p) => `${p.componentId} ${p.pinName}`).join(', ');
        add('error', 'pin-conflict', `${where} carries ${who} — one GPIO can serve one of these signals. Give each its own pin.`, exclusive[0]);
      }
      const selects = [...new Set(g.parts.filter((p) => p.role === 'spi-cs').map((p) => p.componentId))];
      if (selects.length > 1) {
        add('error', 'pin-conflict', `${where} is the chip-select of ${selects.join(' and ')} — every SPI device needs its own CS pin.`, selects[0]);
      }
    }
  }

  // ── Per-part rules ─────────────────────────────────────────────────────
  interface I2cDevice {
    componentId: string;
    address: number;
    alternatives: number[];
  }
  const buses = new Map<string, I2cDevice[]>();

  for (const comp of input.components) {
    const k = partKnowledge(comp.metadataId);
    if (!k) continue;
    const pins = Object.keys(k.pins);
    const wired = pins.some((p) => wiredPins.has(key(comp.id, p)));
    if (!wired) continue;

    // Required signal pins left open ("DO|MISO": either name counts).
    for (const req of k.required ?? []) {
      const names = req.split('|');
      if (!names.some((pin) => wiredPins.has(key(comp.id, pin)))) {
        add('warning', 'unwired-signal', `${comp.id} (${k.label}) has its ${names[0]} pin unconnected — it will not work until ${names[0]} is wired.`, comp.id);
      }
    }

    // Supply range and logic levels.
    const volts = supplyOf(k, comp.id, elec);
    if (k.supply && volts !== undefined) {
      if (volts > k.supply.max + 0.05 && !COMPONENT_RATINGS[comp.metadataId]) {
        add('warning', 'supply-range', `${comp.id} (${k.label}) is powered from ${volts} V, above its ${k.supply.max} V maximum. Power it from 3.3 V.`, comp.id);
      } else if (volts < k.supply.min - 0.05) {
        add('warning', 'supply-range', `${comp.id} (${k.label}) needs ${k.supply.min}–${k.supply.max} V but is powered from ${volts} V — it may not work reliably. Power it from 5 V.`, comp.id);
      }
    }
    if (volts !== undefined && volts > 3.6) {
      for (const [pin, role] of Object.entries(k.pins)) {
        if (!PUSH_PULL_TO_MCU.has(role)) continue;
        for (const bp of signalByPart.get(key(comp.id, pin))?.gpios ?? []) {
          if (bp.info.fiveVoltTolerant) continue;
          add('warning', 'logic-level', `${comp.id} ${pin} outputs ${volts} V (the part runs from ${volts} V) into ${bp.boardId} ${gpioLabel(bp)}, but the ${bp.info.label} is a 3.3 V board — add a voltage divider or level shifter on ${pin}.`, comp.id);
        }
      }
    }

    // I2C placement and address.
    if (k.i2c) {
      const sdaPin = pins.find((p) => k.pins[p] === 'i2c-sda');
      const sclPin = pins.find((p) => k.pins[p] === 'i2c-scl');
      const sda = sdaPin ? signalByPart.get(key(comp.id, sdaPin))?.gpios[0] : undefined;
      const scl = sclPin ? signalByPart.get(key(comp.id, sclPin))?.gpios[0] : undefined;
      if (sda && scl && sda.boardId === scl.boardId) {
        const { info, boardId } = sda;
        if (sda.gpio === info.i2c.scl && scl.gpio === info.i2c.sda) {
          add('error', 'i2c-pins', `${comp.id} has SDA and SCL swapped: SDA is on ${gpioLabel(sda)} (the ${info.label}'s SCL) and SCL on ${gpioLabel(scl)} (its SDA). Swap the two wires.`, comp.id);
        } else if (sda.gpio !== info.i2c.sda || scl.gpio !== info.i2c.scl) {
          if (!info.i2c.anyPins) {
            add('error', 'i2c-pins', `${comp.id} is on ${gpioLabel(sda)}/${gpioLabel(scl)}, but the ${info.label} has hardware I2C only on GPIO${info.i2c.sda} (SDA) / GPIO${info.i2c.scl} (SCL). Move the wires there.`, comp.id);
          } else {
            const code = input.code?.[boardId];
            const m = code ? WIRE_BEGIN_RE.exec(code) : null;
            const numeric = m && /^\d+$/.test(m[1]) && /^\d+$/.test(m[2]);
            const matches = numeric && Number(m![1]) === sda.gpio && Number(m![2]) === scl.gpio;
            // arduino-pico moves the bus with Wire.setSDA()/setSCL(); a second
            // bus object (Wire1, TwoWire) is configured in ways not parsed here.
            const otherSetup =
              !!code && (/\bWire1\b|\bTwoWire\b|\.setSDA\s*\(|\.setSCL\s*\(|\.setPins\s*\(/.test(code) || MICROPYTHON_RE.test(code));
            if (code !== undefined && !otherSetup && (!m || (numeric && !matches))) {
              add('warning', 'i2c-pins', `${comp.id} is on ${gpioLabel(sda)} (SDA) / ${gpioLabel(scl)} (SCL), not the ${info.label}'s default I2C pins (${info.i2c.sda}/${info.i2c.scl}). Call Wire.begin(${sda.gpio}, ${scl.gpio}) before using it, or move the wires.`, comp.id);
            }
          }
        }

        let address = k.i2c.addressProp ? parseI2cAddress(comp.properties?.[k.i2c.addressProp]) : undefined;
        if (address === undefined && k.i2c.addressPin) {
          const rails = elec.get(key(comp.id, k.i2c.addressPin.pin))?.rails ?? [];
          address = rails.some((r) => typeof r === 'number') ? k.i2c.addressPin.high : k.i2c.addresses[0];
        }
        address ??= k.i2c.addresses[0];
        const busKey = `${boardId}:${sda.gpio}:${scl.gpio}`;
        const list = buses.get(busKey) ?? [];
        list.push({ componentId: comp.id, address, alternatives: k.i2c.addresses });
        buses.set(busKey, list);
      }
    }
  }

  for (const devices of buses.values()) {
    const byAddress = new Map<number, I2cDevice[]>();
    for (const d of devices) byAddress.set(d.address, [...(byAddress.get(d.address) ?? []), d]);
    for (const [address, same] of byAddress) {
      if (same.length < 2) continue;
      const alt = same[1].alternatives.filter((a) => a !== address);
      add(
        'error',
        'i2c-address-conflict',
        `${same.map((d) => d.componentId).join(' and ')} share I2C address ${hex(address)} on one bus — only one of them will answer.` +
          (alt.length ? ` Set ${same[1].componentId} to ${alt.map(hex).join(' or ')}.` : ' Put one of them on a second I2C bus.'),
        same[1].componentId,
      );
    }
  }

  return out;
}
