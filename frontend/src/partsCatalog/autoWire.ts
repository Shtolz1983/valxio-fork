/**
 * Place a catalogue part and wire it to a board without the AI: power and
 * ground by the part's supply range, I2C/SPI to the board's default bus
 * pins, every other signal to a free GPIO that suits its direction (no
 * strapping, flash, serial or input-only pins for outputs, no ADC2 for analog
 * reads on an ESP32), plus the card's pull-up resistors.
 *
 * planPins() is pure (unit-tested); placeOnCanvas() does it through the same
 * recorded store actions as the AI tools, so Ctrl+Z undoes it.
 */
import type { BoardInstance } from '../types/board';
import { boardKnowledge, type BoardKnowledge } from '../validation/partsKnowledge';
import { boardPinToNumber } from '../utils/boardPinMapping';
import { readPinInfo } from '../utils/readPinInfo';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { AI_TOOLS } from '../ai/tools';
import { cardComponentId, type PartCard } from './types';

export interface PinPlan {
  /** Card pin → board pin name and GPIO number (-1 for supply/ground). */
  assignment: Record<string, { boardPin: string; gpio: number }>;
  warnings: string[];
}

interface BoardPin {
  name: string;
  gpio: number | null;
}

const isGround = (n: string) => /^GND/i.test(n);
const isFive = (n: string) => /^(5V|VBUS|VUSB|VIN)$/i.test(n);
const isThree = (n: string) => /^(3V3|3\.3V)$/i.test(n);

/** The board pin name for a GPIO: the plainest of its aliases ("A4" over "A4.2"). */
function nameOf(pins: BoardPin[], gpio: number): string | undefined {
  return pins
    .filter((p) => p.gpio === gpio)
    .map((p) => p.name)
    .sort((a, b) => Number(a.includes('.')) - Number(b.includes('.')) || a.length - b.length)[0];
}

function supplyPin(pins: BoardPin[], card: PartCard, bk: BoardKnowledge, warnings: string[]): string | undefined {
  const five = pins.find((p) => p.name === '5V')?.name ?? pins.find((p) => isFive(p.name))?.name;
  const three = pins.find((p) => isThree(p.name))?.name;
  const wantThree = bk.logicVolts === 3.3 ? card.supply.min <= 3.3 : card.supply.max < 5;
  const pick = wantThree ? (three ?? five) : (five ?? three);
  if (!pick) warnings.push('The board has no supply pin for the module — wire VCC by hand.');
  else if ((pick === three && card.supply.min > 3.3) || (pick === five && card.supply.max < 5)) {
    warnings.push(`${card.name} needs ${card.supply.min}–${card.supply.max} V; the board offers ${pick}.`);
  }
  return pick;
}

/**
 * Pick a board pin for every card pin. `used` = GPIOs already wired to
 * something; the plan never reuses them for a signal.
 */
export function planPins(card: PartCard, boardKind: string, boardPins: string[], used: Set<number>): PinPlan {
  const bk = boardKnowledge(boardKind);
  if (!bk) throw new Error(`Auto-wiring knows Uno, Nano, Mega, ESP32 and Pico boards, not "${boardKind}".`);
  const pins: BoardPin[] = boardPins.map((name) => {
    const n = boardPinToNumber(boardKind, name);
    return { name, gpio: n !== null && n >= 0 ? n : null };
  });
  const warnings: string[] = [];
  const assignment: PinPlan['assignment'] = {};
  const taken = new Set(used);
  const gpios = [...new Set(pins.map((p) => p.gpio).filter((n): n is number => n !== null))].sort((a, b) => a - b);

  const busPins = new Set([bk.i2c.sda, bk.i2c.scl, ...(bk.spi ? [bk.spi.sck, bk.spi.miso, bk.spi.mosi] : [])]);
  const avoid = new Set([...bk.serial, ...bk.flash, ...bk.strapping]);
  const analogLast = (a: number, b: number) => Number(bk.analog.includes(a)) - Number(bk.analog.includes(b)) || a - b;
  const digitalFor = (output: boolean) =>
    gpios
      .filter((n) => !taken.has(n) && !avoid.has(n) && !busPins.has(n))
      .filter((n) => !output || !bk.inputOnly.includes(n))
      .sort(analogLast)[0];
  const analogFree = () =>
    bk.analog.filter((n) => gpios.includes(n) && !taken.has(n) && !busPins.has(n) && !bk.adc2.includes(n) && !bk.flash.includes(n))[0];

  const assign = (cardPin: string, gpio: number | undefined, what: string) => {
    const boardPin = gpio === undefined ? undefined : nameOf(pins, gpio);
    if (gpio === undefined || !boardPin) {
      warnings.push(`No free ${what} pin left for ${cardPin}.`);
      return;
    }
    taken.add(gpio);
    assignment[cardPin] = { boardPin, gpio };
  };

  const ground = pins.find((p) => isGround(p.name))?.name;
  const supply = supplyPin(pins, card, bk, warnings);

  for (const pin of card.pins) {
    switch (pin.role) {
      case 'ground':
        if (ground) assignment[pin.name] = { boardPin: ground, gpio: -1 };
        break;
      case 'power':
        if (supply) assignment[pin.name] = { boardPin: supply, gpio: -1 };
        break;
      case 'i2c-sda':
      case 'i2c-scl': {
        // The bus is shared by design: no "taken" check.
        const gpio = pin.role === 'i2c-sda' ? bk.i2c.sda : bk.i2c.scl;
        const boardPin = nameOf(pins, gpio);
        if (boardPin) assignment[pin.name] = { boardPin, gpio };
        break;
      }
      case 'spi-sck':
      case 'spi-mosi':
      case 'spi-miso': {
        if (!bk.spi) {
          warnings.push(`${bk.label} has no default SPI pins for ${pin.name}.`);
          break;
        }
        const gpio = pin.role === 'spi-sck' ? bk.spi.sck : pin.role === 'spi-mosi' ? bk.spi.mosi : bk.spi.miso;
        const boardPin = nameOf(pins, gpio);
        if (boardPin) assignment[pin.name] = { boardPin, gpio };
        break;
      }
      case 'spi-cs':
        assign(pin.name, bk.spi && !taken.has(bk.spi.cs) ? bk.spi.cs : digitalFor(true), 'chip-select');
        break;
      case 'analog-in':
        assign(pin.name, analogFree(), 'analog');
        break;
      case 'mcu-in':
        assign(pin.name, digitalFor(false), 'digital');
        break;
      case 'mcu-out':
      case 'bidir':
        assign(pin.name, digitalFor(true), 'digital');
        break;
      default:
        break; // passive / nc: left for the user
    }
  }

  const signalVolts = card.supply.min > 3.6 ? 5 : null;
  if (signalVolts && bk.logicVolts === 3.3 && card.pins.some((p) => p.role === 'mcu-in' || p.role === 'analog-in' || p.role === 'bidir')) {
    warnings.push(`${card.name} runs at 5 V: its outputs may exceed the ${bk.label}'s 3.3 V inputs — add a divider.`);
  }
  return { assignment, warnings };
}

const AVR_ANALOG_BASE: Record<string, number> = { 'arduino-uno': 14, 'arduino-nano': 14, 'arduino-mega': 54 };

/** How a sketch names a GPIO: A0… for AVR analog pins, the number otherwise. */
export function pinLiteral(boardKind: string, gpio: number): string {
  const base = AVR_ANALOG_BASE[boardKind];
  return base !== undefined && gpio >= base ? `A${gpio - base}` : String(gpio);
}

/** The card's example with each {{PIN}} replaced by the wired board pin. */
export function fillExample(card: PartCard, boardKind: string, plan: PinPlan): string {
  return card.example.replace(/\{\{([A-Za-z0-9+_-]+)\}\}/g, (whole, name: string) => {
    const a = plan.assignment[name];
    return a && a.gpio >= 0 ? pinLiteral(boardKind, a.gpio) : whole;
  });
}

const sim = () => useSimulatorStore.getState();

function boardPinNames(board: BoardInstance): string[] {
  return (readPinInfo<{ name: string }>(document.getElementById(board.id)) ?? []).map((p) => p.name);
}

/** GPIOs of `board` that already have a wire. */
function usedGpios(board: BoardInstance): Set<number> {
  const used = new Set<number>();
  for (const w of sim().wires) {
    for (const end of [w.start, w.end]) {
      if (end.componentId !== board.id) continue;
      const n = boardPinToNumber(board.boardKind, end.pinName);
      if (n !== null && n >= 0) used.add(n);
    }
  }
  return used;
}

export function targetBoard(): BoardInstance {
  const s = sim();
  const board = s.boards.find((b) => b.id === s.activeBoardId) ?? s.boards[0];
  if (!board) throw new Error('Put a board on the canvas first.');
  return board;
}

/**
 * The pins a placed part of this card is wired to, read from the canvas
 * (for "Insert example" after the user wired it by hand). Null when the card
 * has no part on the canvas.
 */
export function planFromCanvas(card: PartCard, board: BoardInstance): PinPlan | null {
  const type = cardComponentId(card);
  const part = sim().components.find((c) => c.metadataId === type);
  if (!part) return null;
  const assignment: PinPlan['assignment'] = {};
  for (const w of sim().wires) {
    const ends = [w.start, w.end];
    const mine = ends.find((e) => e.componentId === part.id);
    const other = ends.find((e) => e.componentId === board.id);
    if (!mine || !other) continue;
    const n = boardPinToNumber(board.boardKind, other.pinName);
    assignment[mine.pinName] = { boardPin: other.pinName, gpio: n ?? -1 };
  }
  return { assignment, warnings: [] };
}

/** Plan for a board the part is not placed on yet (fills the example's pins). */
export function planForBoard(card: PartCard, board: BoardInstance): PinPlan {
  return planPins(card, board.boardKind, boardPinNames(board), usedGpios(board));
}

const WIRE_COLOR: Record<string, string> = {
  ground: 'black',
  power: 'red',
  'i2c-sda': 'blue',
  'i2c-scl': 'yellow',
  'analog-in': 'orange',
};

/** Place the card's part next to the board, wire it, add its pull-ups. */
export async function placeOnCanvas(card: PartCard): Promise<{ componentId: string; plan: PinPlan }> {
  const board = targetBoard();
  const plan = planForBoard(card, board);
  const placed = (await AI_TOOLS.add_component({ type: cardComponentId(card) })) as { id: string };
  for (const pin of card.pins) {
    const a = plan.assignment[pin.name];
    if (!a) continue;
    await AI_TOOLS.connect({ from: `${placed.id}:${pin.name}`, to: `${board.id}:${a.boardPin}`, color: WIRE_COLOR[pin.role] ?? 'green' });
  }
  const supplyPinName = card.pins.find((p) => p.role === 'power')?.name;
  const part = sim().components.find((c) => c.id === placed.id);
  for (const pull of card.pullups ?? []) {
    if (!supplyPinName || !part) break;
    const r = (await AI_TOOLS.add_component({
      type: 'resistor',
      x: part.x,
      y: part.y - 70,
      properties: { value: String(pull.ohms) },
    })) as { id: string };
    await AI_TOOLS.connect({ from: `${r.id}:1`, to: `${placed.id}:${pull.pin}`, color: 'green' });
    await AI_TOOLS.connect({ from: `${r.id}:2`, to: `${placed.id}:${supplyPinName}`, color: 'red' });
  }
  return { componentId: placed.id, plan };
}
