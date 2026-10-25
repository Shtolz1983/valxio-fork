/**
 * Display models: the driver chip behind a display module, decoded from what
 * the sketch puts on the wires and painted on the module itself
 * (`<velxio-sensor-module>`'s `moduleDisplay`, see SensorModuleElement.ts).
 *
 *   - tm1637: the 4-digit 7-segment module. Two-wire, not I2C: start / stop
 *     conditions, LSB-first bytes, an ACK clock per byte; decoded from the
 *     drive state of the board pads its CLK and DIO are wired to.
 *   - max7219: the 8x8 LED matrix module (FC-16 layout). An SPI device on the
 *     bus fabric, so it hears both SPI.transfer() and a bit-banged shiftOut().
 */
import { attachSpiDevice } from '../../simulation/buses';
import type { PadState } from '../../simulation/line/padEvent';
import type { ModuleDisplay } from '../../components/velxio-components/SensorModuleElement';
import type { PartCard } from '../types';
import { registerModuleModel, type ModuleModelContext, type ModuleModelInstance } from './registry';

/** The display state a model hands the module, painted only when it changed. */
function displayPainter(element: HTMLElement) {
  let last = '';
  return (display: ModuleDisplay) => {
    const key = JSON.stringify(display);
    if (key === last) return;
    last = key;
    (element as unknown as { moduleDisplay: ModuleDisplay }).moduleDisplay = display;
  };
}

/** A card pin by role, else by one of its usual names. */
function cardPin(card: PartCard, roles: string[], names: string[]): string | undefined {
  return (
    card.pins.find((p) => roles.includes(p.role))?.name ??
    card.pins.find((p) => names.includes(p.name.toUpperCase()))?.name
  );
}

// ── TM1637 ──────────────────────────────────────────────────────────────────

/** Display-control pulse widths of the TM1637 (datasheet), sixteenths. */
const TM1637_PULSE = [1, 2, 4, 10, 11, 12, 13, 14];

export interface Tm1637State {
  /** The six display registers (grids 1..6), segment bytes. */
  grids: number[];
  on: boolean;
  /** Display-control brightness 0..7. */
  brightness: number;
}

/**
 * The TM1637's serial interface as a state machine over the two line levels.
 *
 * START is DIO falling while CLK is high, STOP is DIO rising while CLK is
 * high; a bit is sampled on CLK rising, LSB first. After the 8th bit the chip
 * pulls DIO low from the 8th falling clock edge to the 9th (its ACK), which
 * is part of the line level here: the avishorp library answers an ACK by
 * driving DIO low itself while CLK is still high, which against a released
 * line would read as a START.
 *
 * Commands (first byte after START): 0x40 data command (bit 2 fixed
 * address, bits 1..0 = 10 key read), 0xC0 | addr address command followed by
 * data bytes, 0x80 | 0x08(on) | brightness display control.
 */
export class Tm1637Decoder {
  readonly state: Tm1637State = { grids: [0, 0, 0, 0, 0, 0], on: false, brightness: 0 };
  /** Called when the chip starts / ends its ACK: the line it holds low. */
  onAck: (holdingLow: boolean) => void = () => {};
  /** Called at a STOP that changed the display. */
  onChange: () => void = () => {};

  private clk = true;
  private dioMcu = true;
  private ackLow = false;
  private inTx = false;
  private bit = 0;
  private byte = 0;
  private byteIndex = 0;
  private addressed = false;
  private address = 0;
  private autoIncrement = true;
  private dirty = false;

  private get dio(): boolean {
    return this.dioMcu && !this.ackLow;
  }

  /** The level the MCU (and the module's pull-up) put on CLK. */
  setClk(level: boolean): void {
    if (level === this.clk) return;
    this.clk = level;
    if (!this.inTx) return;
    if (level) {
      if (this.bit < 8) {
        if (this.dio) this.byte |= 1 << this.bit;
        this.bit++;
        if (this.bit === 8) this.receive(this.byte);
      } else if (this.bit === 8) {
        this.bit = 9; // the ACK clock
      }
    } else if (this.bit === 8 && !this.ackLow) {
      this.ackLow = true;
      this.onAck(true);
    } else if (this.bit === 9) {
      this.endAck();
      this.bit = 0;
      this.byte = 0;
    }
  }

  /** The level the MCU (and the module's pull-up) put on DIO. */
  setDio(level: boolean): void {
    const before = this.dio;
    this.dioMcu = level;
    const now = this.dio;
    if (now === before || !this.clk) return;
    if (!now) this.start();
    else this.stop();
  }

  private endAck(): void {
    if (!this.ackLow) return;
    this.ackLow = false;
    this.onAck(false);
  }

  private start(): void {
    this.endAck();
    this.inTx = true;
    this.bit = 0;
    this.byte = 0;
    this.byteIndex = 0;
    this.addressed = false;
  }

  private stop(): void {
    this.endAck();
    this.inTx = false;
    if (this.dirty) {
      this.dirty = false;
      this.onChange();
    }
  }

  private receive(b: number): void {
    const first = this.byteIndex++ === 0;
    if (first) {
      switch (b & 0xc0) {
        case 0x40:
          // Key read (bits 1..0 = 10) is not modelled: DIO stays on its
          // pull-up while the sketch clocks the answer in, which reads as
          // "no key".
          this.autoIncrement = (b & 0x04) === 0;
          break;
        case 0xc0:
          this.addressed = true;
          this.address = b & 0x07;
          break;
        case 0x80: {
          const on = (b & 0x08) !== 0;
          const brightness = b & 0x07;
          if (on !== this.state.on || brightness !== this.state.brightness) this.dirty = true;
          this.state.on = on;
          this.state.brightness = brightness;
          break;
        }
      }
      return;
    }
    if (!this.addressed) return;
    if (this.address < this.state.grids.length && this.state.grids[this.address] !== b) {
      this.state.grids[this.address] = b;
      this.dirty = true;
    }
    if (this.autoIncrement) this.address++;
  }
}

/** The module's display for a TM1637 state: 4 digits, colon = bit 7 of digit 2. */
export function tm1637Display(state: Tm1637State, digits = 4): ModuleDisplay {
  return {
    kind: '7seg',
    digits: state.grids.slice(0, digits),
    colon: (state.grids[1] & 0x80) !== 0,
    on: state.on,
    brightness: TM1637_PULSE[state.brightness] / 14,
  };
}

function attachTm1637(ctx: ModuleModelContext): ModuleModelInstance {
  const { simulator, element } = ctx;
  const pm = simulator.pinManager;
  const clkName = cardPin(ctx.card, [], ['CLK', 'SCLK']) ?? 'CLK';
  const dioName = cardPin(ctx.card, ['bidir'], ['DIO', 'DATA']) ?? 'DIO';
  const clk = ctx.getArduinoPin(clkName);
  const dio = ctx.getArduinoPin(dioName);
  const paint = displayPainter(element);
  const decoder = new Tm1637Decoder();
  paint(tm1637Display(decoder.state));
  if (clk === null || clk < 0 || dio === null || dio < 0) {
    return { update() {}, dispose() {} };
  }

  // The module's pull-ups: a released pad is HIGH, only a pad the MCU drives
  // low pulls the line down (the library drives the pins open-drain style,
  // pinMode(OUTPUT) with the latch at 0 / pinMode(INPUT)).
  const level = (pad: Readonly<PadState> | undefined) => pad?.drive !== 'low';
  const inject = (pin: number, high: boolean) => {
    try {
      simulator.setPinState(pin, high);
    } catch {
      // the board has no such pad
    }
  };
  decoder.setClk(level(pm.peekPad(clk)));
  decoder.setDio(level(pm.peekPad(dio)));
  decoder.onAck = (low) => inject(dio, !low);
  decoder.onChange = () => paint(tm1637Display(decoder.state));
  inject(clk, true);
  inject(dio, true);

  // A board in a backend worker (ESP32 under QEMU) has no pad channel: it
  // reports the direction the guest programs and the latch of an output pad.
  // The library leaves both latches at 0 and only flips pinMode, so there a
  // line is low exactly while its pad is an output whose latch is low. The
  // guest reads the ACK on its own side, so this side injects nothing.
  let padSeen = false;
  const latch = new Map<number, boolean>();
  const fromDirection = (pin: number, set: (high: boolean) => void) => {
    const dir = pm.getPinDirection(pin);
    if (padSeen || dir === undefined) return;
    decoder.onAck = () => {};
    set(dir === 0 || (latch.get(pin) ?? false));
  };
  const watch = (pin: number, set: (high: boolean) => void) => [
    pm.onPadChange(pin, (e) => {
      padSeen = true;
      set(level(e));
    }),
    pm.onPinConfigChange(pin, () => fromDirection(pin, set)),
    pm.onPinChange(pin, (_, state) => {
      if (pm.getPinDirection(pin) !== 1) return;
      latch.set(pin, state);
      fromDirection(pin, set);
    }),
  ];
  const offs = [
    ...watch(clk, (high) => decoder.setClk(high)),
    ...watch(dio, (high) => decoder.setDio(high)),
  ];
  return {
    update() {},
    dispose() {
      offs.forEach((off) => off());
    },
  };
}

registerModuleModel('tm1637', { keys: [], attach: attachTm1637 });

// ── MAX7219 ─────────────────────────────────────────────────────────────────

/** MAX7219 Code B font (decode mode), as D7..D0 = DP A B C D E F G. */
const CODE_B = [0x7e, 0x30, 0x6d, 0x79, 0x33, 0x5b, 0x5f, 0x70, 0x7f, 0x7b, 0x01, 0x4f, 0x37, 0x0e, 0x67, 0x00];

export interface Max7219State {
  /** Digit registers 0x01..0x08. */
  digits: number[];
  decode: number;
  intensity: number;
  scanLimit: number;
  shutdown: boolean;
  test: boolean;
}

/** The MAX7219's register file, written one 16-bit word per LOAD (CS) rise. */
export class Max7219Chip {
  // Power-on: shut down, scan limit 0, no decode, minimum intensity.
  readonly state: Max7219State = {
    digits: [0, 0, 0, 0, 0, 0, 0, 0],
    decode: 0,
    intensity: 0,
    scanLimit: 0,
    shutdown: true,
    test: false,
  };

  /** Latch one word: `op` the register address byte, `data` its value. */
  write(op: number, data: number): boolean {
    const s = this.state;
    const reg = op & 0x0f;
    const before = JSON.stringify(s);
    if (reg >= 1 && reg <= 8) s.digits[reg - 1] = data;
    else if (reg === 0x09) s.decode = data;
    else if (reg === 0x0a) s.intensity = data & 0x0f;
    else if (reg === 0x0b) s.scanLimit = data & 0x07;
    else if (reg === 0x0c) s.shutdown = (data & 0x01) === 0;
    else if (reg === 0x0f) s.test = (data & 0x01) !== 0;
    return JSON.stringify(s) !== before;
  }

  /** What each digit drives: its register, or the Code B glyph in decode mode. */
  segments(i: number): number {
    const v = this.state.digits[i];
    return this.state.decode & (1 << i) ? (v & 0x80) | CODE_B[v & 0x0f] : v;
  }
}

/**
 * The module's matrix for a MAX7219 state. On the FC-16 module (the one the
 * card's example selects, MD_MAX72XX::FC16_HW) digit register k drives row
 * k-1 from the top and segment bit 7 (DP) the LEFT column, bit 0 (G) the
 * right one: MD_MAX72XX's setPoint(0, 0) is the top-right LED.
 */
export function max7219Display(chip: Max7219Chip): ModuleDisplay {
  const s = chip.state;
  if (s.test) return { kind: 'matrix', rows: Array(8).fill(0xff), on: true, brightness: 1 };
  const rows = s.digits.map((_, i) => (i <= s.scanLimit ? chip.segments(i) : 0));
  return { kind: 'matrix', rows, on: !s.shutdown, brightness: (s.intensity + 1) / 16 };
}

function attachMax7219(ctx: ModuleModelContext): ModuleModelInstance {
  const { card, componentId, element } = ctx;
  const paint = displayPainter(element);
  const chip = new Max7219Chip();
  paint(max7219Display(chip));

  const sck = cardPin(card, ['spi-sck'], ['CLK', 'SCK']) ?? 'CLK';
  const mosi = cardPin(card, ['spi-mosi'], ['DIN', 'MOSI']) ?? 'DIN';
  const cs = cardPin(card, ['spi-cs'], ['CS', 'LOAD']) ?? 'CS';
  // The 16-bit shift register: only the last word clocked before LOAD rises
  // is latched (earlier ones went out on DOUT to the next module of a chain).
  let bytes: number[] = [];
  const handle = attachSpiDevice(
    { owner: componentId, pins: { sck, mosi, cs }, modes: [0], bitOrder: 'msb' },
    {
      writeOnly: true,
      select() {
        bytes = [];
      },
      transfer(value: number) {
        bytes.push(value & 0xff);
        if (bytes.length > 2) bytes.shift();
        return null;
      },
      transferBlock(block: Uint8Array) {
        for (const b of block.subarray(Math.max(0, block.length - 2))) {
          bytes.push(b);
          if (bytes.length > 2) bytes.shift();
        }
      },
      deselect() {
        if (bytes.length === 2 && chip.write(bytes[0], bytes[1])) paint(max7219Display(chip));
        bytes = [];
      },
      boardReset() {
        bytes = [];
      },
    },
  );
  return {
    update() {},
    dispose() {
      handle.dispose();
    },
  };
}

registerModuleModel('max7219', { keys: [], attach: attachMax7219 });
