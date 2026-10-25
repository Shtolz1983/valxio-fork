/**
 * The circuit as text: for every part on the canvas, each of its pins and the
 * controller pin it ends up on ("DHT11 DATA → D4").
 *
 * Pure, like circuitValidator.ts: nets are built the same way (wires, the
 * strips of a breadboard, two pads of one GPIO as one node), and a pin that
 * reaches the board only through a series resistor says so ("A → D13 via
 * 220 Ω"), which is how a person reads an LED behind its resistor. A pin with
 * no board pin on its net names the parts it shares the net with instead.
 */
import { UnionFind } from '../simulation/spice/unionFind';
import { unionBreadboardGroups } from '../simulation/spice/NetlistBuilder';
import { boardPinToNumber } from '../utils/boardPinMapping';
import { isBreadboard } from '../utils/breadboardNets';
import { partKnowledge, type PinRole } from './partsKnowledge';

interface Endpoint {
  componentId: string;
  pinName: string;
}

export interface WiringInput {
  boards: ReadonlyArray<{ id: string; boardKind: string; name?: string }>;
  components: ReadonlyArray<{ id: string; metadataId: string; properties?: Record<string, unknown> }>;
  wires: ReadonlyArray<{ id: string; start: Endpoint; end: Endpoint }>;
  /** Display name of a part type ("DHT11"); defaults to the type id. */
  nameOf?: (metadataId: string) => string | undefined;
}

export interface PinTarget {
  /** Controller pin as printed on the board ("D4", "A4", "GPIO21", "5V", "GND"). */
  boardPin: string;
  /** Board id, when the canvas has more than one board. */
  board?: string;
  /** The series resistor the line passes through, e.g. "220 Ω". */
  via?: string;
}

export interface PinLine {
  pin: string;
  role?: PinRole;
  targets: PinTarget[];
  /** Other parts' pins on the net, when no board pin is on it. */
  peers: string[];
}

export interface PartWiring {
  id: string;
  name: string;
  pins: PinLine[];
}

const key = (componentId: string, pinName: string) => `${componentId}:${pinName}`;
const isResistor = (metadataId: string) => metadataId.startsWith('resistor');

const BUS_LABEL: Partial<Record<PinRole, string>> = {
  'i2c-sda': 'I2C SDA',
  'i2c-scl': 'I2C SCL',
  'spi-sck': 'SPI SCK',
  'spi-mosi': 'SPI MOSI',
  'spi-miso': 'SPI MISO',
  'spi-cs': 'SPI CS',
};

/** "D4" on an Arduino, "GPIO4" elsewhere; the ".2" of a second pad dropped. */
export function boardPinLabel(boardKind: string, pinName: string): string {
  const name = pinName.replace(/\.\d+$/, '');
  if (/^\d+$/.test(name)) return boardKind.startsWith('arduino') ? `D${name}` : `GPIO${name}`;
  return name;
}

function ohms(props: Record<string, unknown> | undefined): string {
  const raw = String(props?.value ?? props?.resistance ?? '').trim();
  if (!raw) return 'R';
  return /[Ωω]|ohm/i.test(raw) ? raw : `${raw} Ω`;
}

export function wiringList(input: WiringInput): PartWiring[] {
  const boards = new Map(input.boards.map((b) => [b.id, b]));
  const comps = new Map(input.components.map((c) => [c.id, c]));
  const multiBoard = input.boards.length > 1;
  const uf = new UnionFind();

  // Two pads of one GPIO (Uno 'A4' and 'A4.2') are one node.
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

  // Per net: the board pins on it, and the part pins on it.
  const boardPins = new Map<string, PinTarget[]>();
  const partPins = new Map<string, Endpoint[]>();
  for (const e of endpoints.values()) {
    const root = uf.find(nodeOf(e));
    const board = boards.get(e.componentId);
    if (board) {
      const target: PinTarget = { boardPin: boardPinLabel(board.boardKind, e.pinName) };
      if (multiBoard) target.board = board.name?.trim() || board.id;
      const list = boardPins.get(root) ?? [];
      if (!list.some((t) => t.boardPin === target.boardPin && t.board === target.board)) list.push(target);
      boardPins.set(root, list);
    } else {
      partPins.set(root, [...(partPins.get(root) ?? []), e]);
    }
  }

  const pinsOfPart = (componentId: string) =>
    [...endpoints.values()].filter((e) => e.componentId === componentId);

  /** Board pins reached from a net through one series resistor. */
  const viaResistor = (root: string): PinTarget[] => {
    const out: PinTarget[] = [];
    for (const e of partPins.get(root) ?? []) {
      const r = comps.get(e.componentId);
      if (!r || !isResistor(r.metadataId)) continue;
      for (const leg of pinsOfPart(r.id)) {
        if (leg.pinName === e.pinName) continue;
        for (const t of boardPins.get(uf.find(nodeOf(leg))) ?? []) out.push({ ...t, via: ohms(r.properties) });
      }
    }
    return out;
  };

  const result: PartWiring[] = [];
  for (const comp of input.components) {
    if (isBreadboard(comp.metadataId)) continue;
    const knowledge = partKnowledge(comp.metadataId);
    const pins = pinsOfPart(comp.id);
    if (pins.length === 0) continue;
    // Pins in the part's own order when it is known, then the rest.
    const order = Object.keys(knowledge?.pins ?? {});
    pins.sort((a, b) => {
      const ia = order.indexOf(a.pinName);
      const ib = order.indexOf(b.pinName);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.pinName.localeCompare(b.pinName);
    });
    const lines: PinLine[] = pins.map((e) => {
      const root = uf.find(nodeOf(e));
      const direct = boardPins.get(root) ?? [];
      const targets = direct.length ? direct : isResistor(comp.metadataId) ? [] : viaResistor(root);
      const peers = targets.length
        ? []
        : (partPins.get(root) ?? [])
            .filter((p) => p.componentId !== comp.id)
            .map((p) => `${p.componentId}:${p.pinName}`);
      return { pin: e.pinName, role: knowledge?.pins[e.pinName], targets, peers };
    });
    result.push({ id: comp.id, name: input.nameOf?.(comp.metadataId) ?? comp.metadataId, pins: lines });
  }
  return result;
}

export interface WiringTextLabels {
  /** The pin reaches nothing at all. */
  notConnected: string;
  /** Prefix of the series resistor, e.g. "via". */
  via: string;
}

export function wiringText(parts: PartWiring[], labels: WiringTextLabels): string {
  const blocks = parts.map((part) => {
    const width = Math.max(...part.pins.map((p) => p.pin.length));
    const lines = part.pins.map((p) => {
      const target = p.targets.length
        ? p.targets
            .map((t) => `${t.board ? `${t.board} ` : ''}${t.boardPin}${t.via ? ` (${labels.via} ${t.via})` : ''}`)
            .join(', ')
        : p.peers.length
          ? p.peers.join(', ')
          : labels.notConnected;
      const bus = p.role && BUS_LABEL[p.role] && p.targets.length ? `  ${BUS_LABEL[p.role]}` : '';
      return `  ${p.pin.padEnd(width)} → ${target}${bus}`;
    });
    return [`${part.name} (${part.id})`, ...lines].join('\n');
  });
  return blocks.join('\n\n');
}
