/**
 * SPI chip models of the parts catalogue on an ESP32 (partsCatalog/models/
 * spi.ts): the guest runs in a QEMU worker and asks for MISO synchronously, so
 * the chip has to travel to the worker in the bus map. A catalogue chip goes
 * as the name of its Python twin (backend/app/services/catalog_spi_models.py)
 * with the bus legs under their role names, and every panel change follows as
 * `esp32_bus_attrs`.
 *
 * The rig is board-buses-f4-qemu-lane.test.ts's: the real store, the real
 * Esp32Bridge behind the real shim, a scripted socket for the WebSocket, and
 * the card's part as the canvas attaches it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
vi.stubGlobal('document', { getElementById: () => null });

class ScriptedSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: ScriptedSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  sent: Array<{ type: string; data?: Record<string, unknown> }> = [];
  constructor(_url: string) {
    ScriptedSocket.last = this;
  }
  send(frame: string): void {
    this.sent.push(JSON.parse(frame));
  }
  close(): void {
    this.readyState = ScriptedSocket.CLOSED;
  }
  open(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.onopen?.();
  }
  receive(type: string, data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import { useSimulatorStore, getBoardSimulator, getEsp32Bridge } from '../store/useSimulatorStore';
import { busRegistry, type RemoteSpiMapEntry } from '../simulation/buses';
import { PartSimulationRegistry, type AnySimulator } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { registerCardSimulations } from '../partsCatalog/simulation';
import type { PartCard } from '../partsCatalog/types';

const CATALOG = path.resolve(__dirname, '../../../parts-catalog');
const card = (id: string) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
  busRegistry.resetDiagnostics();
});

function qemuBoard() {
  const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
  const bridge = getEsp32Bridge(id)!;
  bridge.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return { id, ws };
}

/** The card's part on the board, its pins on the given ESP32 pads. */
function part(boardId: string, id: string, componentId: string, pads: Record<string, number>): void {
  registerCardSimulations([card(id)]);
  const wires = Object.entries(pads).map(([pinName, gpio], i) => ({
    id: `${componentId}-w${i}`,
    start: { componentId, pinName, x: 0, y: 0 },
    end: { componentId: boardId, pinName: `D${gpio}`, x: 0, y: 0 },
    waypoints: [],
    color: '#0a0',
  }));
  useSimulatorStore.setState((s) => ({ wires: [...s.wires, ...wires] }) as never);
  const logic = PartSimulationRegistry.get(id);
  const cleanup = logic!.attachEvents!(
    {} as HTMLElement,
    getBoardSimulator(boardId) as unknown as AnySimulator,
    (pin) => pads[pin] ?? null,
    componentId,
  );
  cleanups.push(() => (cleanup as (() => void) | undefined)?.());
}

function lastEntry(ws: ScriptedSocket, owner: string): RemoteSpiMapEntry | undefined {
  for (const m of [...ws.sent].reverse()) {
    const spi =
      m.type === 'start_esp32'
        ? (m.data?.bus_map as { spi?: unknown[] })?.spi
        : m.type === 'esp32_bus_map'
          ? (m.data?.spi as unknown[] | undefined)
          : undefined;
    const e = (spi ?? []).find((x) => (x as RemoteSpiMapEntry).owner === owner);
    if (e) return e as RemoteSpiMapEntry;
  }
  return undefined;
}

const attrsSent = (ws: ScriptedSocket, owner: string) =>
  ws.sent.filter((m) => m.type === 'esp32_bus_attrs' && m.data?.owner === owner).map((m) => m.data?.attrs);

describe('catalogue SPI chips on an ESP32: the bus map entry', () => {
  it('MAX6675 (bit-banged, any GPIOs) travels as its twin with its legs by role and the panel value', () => {
    const { id, ws } = qemuBoard();
    part(id, 'max6675', 'max6675-1', { SCK: 25, CS: 27, SO: 26 });
    const e = lastEntry(ws, 'max6675-1');
    expect(e).toBeDefined();
    expect(e!.model.catalog).toBe('max6675');
    expect(e!.model.wasm_b64).toBe('');
    expect(e!.model.pin_map).toEqual({ SCK: 25, MISO: 26, CS: 27 });
    expect(e!.model.attrs).toEqual({ temperature: 25 });
    expect(e!.cs).toEqual({ kind: 'pin', gpio: 27, active_low: true });

    dispatchSensorUpdate('max6675-1', { temperature: 432.75 });
    expect(attrsSent(ws, 'max6675-1').at(-1)).toEqual({ temperature: 432.75 });
  });

  it('MAX31865 and RC522 (hardware SPI) travel the same way, with every leg', () => {
    const { id, ws } = qemuBoard();
    const diags: string[] = [];
    cleanups.push(busRegistry.onDiagnostic((d) => diags.push(d.code)));
    part(id, 'max31865', 'max31865-1', { CLK: 18, SDI: 23, SDO: 19, CS: 5 });
    part(id, 'rc522', 'rc522-1', { SCK: 18, MOSI: 23, MISO: 19, SDA: 15, RST: 4 });
    const t = lastEntry(ws, 'max31865-1');
    expect(t!.model.catalog).toBe('max31865');
    expect(t!.model.pin_map).toEqual({ SCK: 18, MOSI: 23, MISO: 19, CS: 5 });
    const r = lastEntry(ws, 'rc522-1');
    expect(r!.model.catalog).toBe('rc522');
    expect(r!.model.pin_map).toEqual({ SCK: 18, MOSI: 23, MISO: 19, CS: 15 });
    expect(r!.cs).toEqual({ kind: 'pin', gpio: 15, active_low: true });

    dispatchSensorUpdate('rc522-1', { card: 0 });
    expect(attrsSent(ws, 'rc522-1').at(-1)).toEqual({ card: 0, tag: 0 });
    // Selected while the guest clocks it, and not a responder the worker lacks.
    ws.receive('gpio_change', { pin: 15, state: 0 });
    expect(diags).not.toContain('bus-remote-responder-missing');
  });
});
