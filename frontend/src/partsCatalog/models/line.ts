/**
 * Single-wire chips behind generic modules: the model owns the module's data
 * line through the LINE framework (simulation/line). The module model asks the
 * board for a line lease with `requestLine`, exactly as the canvas DHT22 does,
 * and forwards every panel change to it; the line model answers the guest's
 * pad events with edges at exact guest cycles.
 *
 * Registered here (not under simulation/line/models) because these sensor
 * types only exist as catalog cards: `dht11` and `ds18b20`.
 */
import { releaseLineGap, requestLine } from '../../simulation/line/requestLine';
import {
  numberField,
  registerLineModel,
  type LineClock,
  type LineModel,
  type LineSensorRecord,
} from '../../simulation/line/lineModels';
import { assertedLow, releasedLow } from '../../simulation/line/padEvent';
import type { HostEdgeFrame } from '../../simulation/line/LineTimeline';
import { dht22Frame } from '../../simulation/line/models/dht22';
import { registerModuleModel, type ModuleModel } from './registry';

// ── Module side: lease the data line ────────────────────────────────────────

/**
 * A module model whose chip is a line model of `sensorType` on the card's
 * bidirectional data pin. `extra` adds fields to the line record.
 */
function lineModule(
  sensorType: string,
  keys: string[],
  extra: (componentId: string) => Record<string, unknown> = () => ({}),
): ModuleModel {
  return {
    keys,
    attach(ctx) {
      const dataPin =
        ctx.card.pins.find((p) => p.role === 'bidir') ??
        ctx.card.pins.find((p) => p.role !== 'power' && p.role !== 'ground');
      const pin = dataPin ? ctx.getArduinoPin(dataPin.name) : null;
      if (pin === null || pin < 0) return { update() {}, dispose() {} };
      const answer = requestLine(
        ctx.simulator,
        { sensor_type: sensorType, pin, ...ctx.values, ...extra(ctx.componentId) },
        { componentId: ctx.componentId },
      );
      return {
        update(values) {
          if (answer.mode !== 'none') answer.update({ ...values });
        },
        dispose() {
          if (answer.mode !== 'none') answer.release();
          else releaseLineGap(ctx.componentId);
        },
      };
    },
  };
}

// ── DHT11 ───────────────────────────────────────────────────────────────────

export const DHT11_DEFAULT_TEMPERATURE_C = 25;
export const DHT11_DEFAULT_HUMIDITY_PCT = 50;

/**
 * The DHT11's 5 bytes: humidity integer, humidity tenths, temperature integer,
 * temperature tenths (bit 7 = below zero, Adafruit DHT.h's reading of it:
 * t = -1 - int + tenths/10), checksum = low byte of the sum of the four.
 */
export function dht11Payload(temperatureC: number, humidityPct: number): Uint8Array {
  const h = Math.max(0, Math.min(2559, Math.round(humidityPct * 10)));
  const hInt = Math.floor(h / 10);
  const hDec = h % 10;
  const t = Math.max(-2559, Math.min(2559, Math.round(temperatureC * 10)));
  let tInt: number;
  let tDec: number;
  if (t >= 0) {
    tInt = Math.floor(t / 10);
    tDec = t % 10;
  } else {
    tInt = Math.ceil(-t / 10) - 1;
    tDec = 0x80 | ((tInt + 1) * 10 + t);
  }
  const chk = (hInt + hDec + tInt + tDec) & 0xff;
  return new Uint8Array([hInt, hDec, tInt, tDec, chk]);
}

/**
 * DHT11 line model: the same start signal and wire timing as the DHT22 (the
 * master holds DATA low for >= 18 ms and releases it; the sensor answers
 * 80 us low, 80 us high, then 40 bits of 50 us low + 26/70 us high), built by
 * the DHT22 model's own frame builder — only the payload differs
 * ({@link dht11Payload}). While its frame is on the wire it ignores the master.
 */
registerLineModel('dht11', (rec) => {
  const pin = rec.pin;
  let temperatureC = numberField(rec.temperature, DHT11_DEFAULT_TEMPERATURE_C);
  let humidityPct = numberField(rec.humidity, DHT11_DEFAULT_HUMIDITY_PCT);
  let wasLow = false;
  let busyUntil = -Infinity;
  const model: LineModel = {
    listens: [pin],
    drives: [pin],
    rest: () => [{ pin, level: true, driven: false }],
    onPad(e, clock) {
      const now = clock.now();
      if (now < busyUntil) return null;
      if (assertedLow(e)) {
        wasLow = true;
        return null;
      }
      if (!releasedLow(e) || !wasLow) return null;
      wasLow = false;
      const frame = dht22Frame(pin, now, dht11Payload(temperatureC, humidityPct), clock.us);
      busyUntil = frame.releaseAtCycle ?? frame.edges[frame.edges.length - 1].atCycle;
      return frame;
    },
    update(props) {
      if ('temperature' in props) temperatureC = numberField(props.temperature, temperatureC);
      if ('humidity' in props) humidityPct = numberField(props.humidity, humidityPct);
    },
    reset() {
      wasLow = false;
      busyUntil = -Infinity;
    },
  };
  return model;
});

registerModuleModel('dht11', lineModule('dht11', ['temperature', 'humidity']));

// ── DS18B20 ─────────────────────────────────────────────────────────────────

/** Dallas/Maxim 1-Wire CRC-8: x^8 + x^5 + x^4 + 1, LSB first (0x8C reflected). */
export function dallasCrc8(bytes: ArrayLike<number>, length = bytes.length): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    let b = bytes[i] & 0xff;
    for (let j = 0; j < 8; j++) {
      const mix = (crc ^ b) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      b >>= 1;
    }
  }
  return crc;
}

export const DS18B20_FAMILY = 0x28;

/**
 * A 64-bit ROM: family 0x28, a 48-bit serial (FNV-1a of `seed`, so each
 * component keeps its address across runs), CRC-8 of the first 7 bytes.
 */
export function ds18b20Rom(seed: string): Uint8Array {
  let h = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  const rom = new Uint8Array(8);
  rom[0] = DS18B20_FAMILY;
  for (let i = 0; i < 4; i++) rom[1 + i] = (h >>> (8 * i)) & 0xff;
  rom[5] = h2 & 0xff;
  rom[6] = (h2 >>> 8) & 0xff;
  rom[7] = dallasCrc8(rom, 7);
  return rom;
}

/** Resolution (9..12 bits) from the configuration register (R1 R0 in bits 6:5). */
export function ds18b20Resolution(config: number): number {
  return 9 + ((config >> 5) & 3);
}

/** Maximum conversion time per resolution (datasheet tCONV). */
export function ds18b20ConversionMs(resolution: number): number {
  return 750 / (1 << (12 - resolution));
}

/**
 * The 16-bit temperature register for °C at a resolution: two's complement in
 * 1/16 °C, clamped to −55…125 °C, bits below the resolution zero.
 */
export function ds18b20RawTemperature(temperatureC: number, resolution = 12): number {
  const t = Math.max(-55, Math.min(125, temperatureC));
  const shift = 12 - resolution;
  const raw = Math.round(t * (16 >> shift)) << shift;
  return raw & 0xffff;
}

/** The 9-byte scratchpad: temp LSB/MSB, TH, TL, config, 0xFF, byte 6, 0x10, CRC. */
export function ds18b20Scratchpad(raw: number, th: number, tl: number, config: number, byte6: number): Uint8Array {
  const sp = new Uint8Array([raw & 0xff, (raw >> 8) & 0xff, th & 0xff, tl & 0xff, config & 0xff, 0xff, byte6 & 0xff, 0x10, 0]);
  sp[8] = dallasCrc8(sp, 8);
  return sp;
}

/** The register at power-on: +85 °C. */
export const DS18B20_POWER_ON_RAW = 0x0550;

type Ds18b20Phase =
  | 'idle' // deselected: waits for the next reset
  | 'rom' // receiving a ROM command
  | 'match' // receiving the 8 ROM bytes of Match ROM
  | 'search' // Search ROM / Alarm Search
  | 'function' // receiving a function command
  | 'writeScratch' // receiving TH, TL, config
  | 'send' // transmitting bytes (Read ROM, Read Scratchpad)
  | 'busy' // Convert T / Copy Scratchpad: read slots answer 0 until done
  | 'power'; // Read Power Supply: read slots answer 1 (external supply)

/**
 * The DS18B20's 1-Wire slave logic at the slot level, independent of the
 * wire: the line model below tells it about resets and slots, it says what to
 * put on the wire. Times are guest cycles (`clock.now()`), durations go
 * through `clock.us`.
 *
 * ROM commands: 0x33 Read ROM, 0x55 Match ROM, 0xCC Skip ROM, 0xF0 Search
 * ROM, 0xEC Alarm Search (answers only while T >= TH or T <= TL). Function
 * commands: 0x44 Convert T (read slots return 0 for the resolution's tCONV,
 * then 1; the register takes the panel temperature at the end), 0xBE Read
 * Scratchpad (9 bytes with CRC, then 1s), 0x4E Write Scratchpad (TH, TL,
 * config — only R1 R0 are writable), 0x48 Copy Scratchpad (10 ms busy),
 * 0xB8 Recall E2, 0xB4 Read Power Supply (1: externally powered).
 */
export class Ds18b20Device {
  readonly rom: Uint8Array;
  temperatureC: number;
  private raw = DS18B20_POWER_ON_RAW;
  /** Reserved byte 6: 0x0C at power-on, 0x10 − (LSB & 0x0F) after a conversion, as genuine parts do. */
  private byte6 = 0x0c;
  private th = 0x4b;
  private tl = 0x46;
  private config = 0x7f;
  private eeprom = { th: 0x4b, tl: 0x46, config: 0x7f };
  private phase: Ds18b20Phase = 'idle';
  private rxByte = 0;
  private rxBits = 0;
  private rxBytes: number[] = [];
  private tx: number[] = [];
  private txIndex = 0;
  private txThen: Ds18b20Phase | null = null;
  private searchBit = 0;
  private searchStep = 0;
  private busyUntil = -Infinity;
  private pendingRaw: number | null = null;
  private convertUntil = -Infinity;

  constructor(rom: Uint8Array, temperatureC: number) {
    this.rom = rom;
    this.temperatureC = temperatureC;
  }

  /** The chip power-cycled with the board. */
  powerOn(): void {
    this.raw = DS18B20_POWER_ON_RAW;
    this.byte6 = 0x0c;
    ({ th: this.th, tl: this.tl, config: this.config } = this.eeprom);
    this.phase = 'idle';
    this.busyUntil = -Infinity;
    this.convertUntil = -Infinity;
    this.pendingRaw = null;
  }

  /** A reset pulse: every slave answers with presence and waits for a ROM command. */
  busReset(): void {
    this.phase = 'rom';
    this.rxByte = 0;
    this.rxBits = 0;
    this.rxBytes = [];
    this.tx = [];
    this.txIndex = 0;
  }

  /**
   * The master pulled the line low to open a slot. Returns `true` when the
   * chip holds the line low (it transmits a 0), `false` when it leaves it (it
   * transmits a 1, or is deselected), `null` when the chip is LISTENING: the
   * slot is a write slot and the master's low width is the bit
   * ({@link writeBit}).
   */
  slotStart(clock: LineClock): boolean | null {
    const now = clock.now();
    this.finishConversion(now);
    switch (this.phase) {
      case 'rom':
      case 'match':
      case 'function':
      case 'writeScratch':
        return null;
      case 'search': {
        if (this.searchStep === 2) return null;
        const bit = this.romBit(this.searchBit);
        const sent = this.searchStep === 0 ? bit : bit ^ 1;
        this.searchStep++;
        return sent === 0;
      }
      case 'send': {
        const bit = this.tx[this.txIndex++] ?? 1;
        if (this.txIndex >= this.tx.length && this.txThen) {
          this.phase = this.txThen;
          this.txThen = null;
        }
        return bit === 0;
      }
      case 'busy':
        return now < this.busyUntil;
      default:
        return false;
    }
  }

  /** The bit the master wrote in a listening slot. */
  writeBit(bit: number, clock: LineClock): void {
    if (this.phase === 'search') {
      if (bit !== this.romBit(this.searchBit)) {
        this.phase = 'idle';
        return;
      }
      this.searchStep = 0;
      if (++this.searchBit === 64) this.phase = 'function';
      return;
    }
    this.rxByte |= (bit & 1) << this.rxBits;
    if (++this.rxBits < 8) return;
    const byte = this.rxByte;
    this.rxByte = 0;
    this.rxBits = 0;
    this.onByte(byte, clock);
  }

  private onByte(byte: number, clock: LineClock): void {
    const now = clock.now();
    switch (this.phase) {
      case 'rom':
        return this.romCommand(byte);
      case 'match':
        this.rxBytes.push(byte);
        if (this.rxBytes.length === 8) {
          this.phase = this.rxBytes.every((b, i) => b === this.rom[i]) ? 'function' : 'idle';
          this.rxBytes = [];
        }
        return;
      case 'writeScratch':
        this.rxBytes.push(byte);
        if (this.rxBytes.length === 3) {
          [this.th, this.tl] = this.rxBytes;
          this.config = (this.rxBytes[2] & 0x60) | 0x1f;
          this.rxBytes = [];
          this.phase = 'idle';
        }
        return;
      case 'function':
        return this.functionCommand(byte, now, clock);
      default:
        return;
    }
  }

  private romCommand(cmd: number): void {
    switch (cmd) {
      case 0x33: // Read ROM
        return this.send(this.rom, 'function');
      case 0x55: // Match ROM
        this.phase = 'match';
        this.rxBytes = [];
        return;
      case 0xcc: // Skip ROM
        this.phase = 'function';
        return;
      case 0xf0: // Search ROM
        return this.startSearch();
      case 0xec: // Alarm Search
        if (this.alarm()) this.startSearch();
        else this.phase = 'idle';
        return;
      default:
        this.phase = 'idle';
    }
  }

  private functionCommand(cmd: number, now: number, clock: LineClock): void {
    switch (cmd) {
      case 0x44: // Convert T
        this.pendingRaw = ds18b20RawTemperature(this.temperatureC, ds18b20Resolution(this.config));
        this.convertUntil = now + clock.us(ds18b20ConversionMs(ds18b20Resolution(this.config)) * 1000);
        this.busyUntil = this.convertUntil;
        this.phase = 'busy';
        return;
      case 0xbe: // Read Scratchpad
        this.finishConversion(now);
        return this.send(this.scratchpad(), null);
      case 0x4e: // Write Scratchpad
        this.phase = 'writeScratch';
        this.rxBytes = [];
        return;
      case 0x48: // Copy Scratchpad
        this.eeprom = { th: this.th, tl: this.tl, config: this.config };
        this.busyUntil = now + clock.us(10_000);
        this.phase = 'busy';
        return;
      case 0xb8: // Recall E2
        ({ th: this.th, tl: this.tl, config: this.config } = this.eeprom);
        this.busyUntil = now;
        this.phase = 'busy';
        return;
      case 0xb4: // Read Power Supply
        this.phase = 'power';
        return;
      default:
        this.phase = 'idle';
    }
  }

  /** The scratchpad as a master reads it now. */
  scratchpad(): Uint8Array {
    return ds18b20Scratchpad(this.raw, this.th, this.tl, this.config, this.byte6);
  }

  private finishConversion(now: number): void {
    if (this.pendingRaw === null || now < this.convertUntil) return;
    this.raw = this.pendingRaw;
    this.byte6 = 0x10 - (this.raw & 0x0f);
    this.pendingRaw = null;
  }

  private send(bytes: ArrayLike<number>, then: Ds18b20Phase | null): void {
    this.tx = [];
    for (let i = 0; i < bytes.length; i++) for (let b = 0; b < 8; b++) this.tx.push((bytes[i] >> b) & 1);
    this.txIndex = 0;
    this.txThen = then;
    this.phase = 'send';
  }

  private startSearch(): void {
    this.phase = 'search';
    this.searchBit = 0;
    this.searchStep = 0;
  }

  private romBit(i: number): number {
    return (this.rom[i >> 3] >> (i & 7)) & 1;
  }

  /** T >= TH or T <= TL on the register's integer part (signed bytes). */
  private alarm(): boolean {
    const t = (this.raw << 16) >> 20; // sign-extend, drop the 4 fraction bits
    const th = (this.th << 24) >> 24;
    const tl = (this.tl << 24) >> 24;
    return t >= th || t <= tl;
  }

  /** Test access: the register's current raw value. */
  get temperatureRegister(): number {
    return this.raw;
  }
}

/** A low this long or longer is a reset pulse (spec 480 us; OneWire's measures ~479 us on a 16 MHz AVR). */
export const ONE_WIRE_RESET_MIN_US = 400;
/** A write slot whose low ends before the slave samples (typ. 30 us after the fall) writes a 1. */
export const ONE_WIRE_SAMPLE_US = 30;
/** Presence: wait 15–60 us after the reset's release, then hold low 60–240 us. */
export const ONE_WIRE_PRESENCE_WAIT_US = 30;
export const ONE_WIRE_PRESENCE_US = 120;
/** A transmitted 0 holds the line low this long from the slot's falling edge (spec ≤ 60 us). */
export const ONE_WIRE_ZERO_HOLD_US = 30;

/**
 * DS18B20 line model: a 1-Wire slave on the data pin. On the master's falling
 * edge it decides the slot from the protocol state — in a read slot it holds
 * the line low for {@link ONE_WIRE_ZERO_HOLD_US} from that edge when it sends
 * a 0 (the master samples ~13 us in); in a write slot it measures the
 * master's low at the release (shorter than {@link ONE_WIRE_SAMPLE_US} = 1).
 * A low of {@link ONE_WIRE_RESET_MIN_US} or more is a reset: presence pulse
 * 30 us after the release, 120 us long. The protocol is {@link Ds18b20Device}.
 */
registerLineModel('ds18b20', (rec: LineSensorRecord) => {
  const pin = rec.pin;
  const device = new Ds18b20Device(
    ds18b20Rom(String(rec.rom_seed ?? `ds18b20@${pin}`)),
    numberField(rec.temperature, 25),
  );
  let lowAt: number | null = null;
  let listening = false;
  let presenceUntil = -Infinity;

  const pull = (from: number, to: number): HostEdgeFrame => ({
    pin,
    edges: [
      { level: false, atCycle: from },
      { level: true, atCycle: to },
    ],
  });

  const model: LineModel = {
    listens: [pin],
    drives: [pin],
    rest: () => [{ pin, level: true, driven: false }],
    onPad(e, clock) {
      const now = clock.now();
      if (assertedLow(e)) {
        lowAt = now;
        listening = false;
        if (now < presenceUntil) return null;
        const answer = device.slotStart(clock);
        if (answer === null) listening = true;
        return answer ? pull(now, now + clock.us(ONE_WIRE_ZERO_HOLD_US)) : null;
      }
      if (!releasedLow(e) || lowAt === null) return null;
      const width = now - lowAt;
      lowAt = null;
      if (width >= clock.us(ONE_WIRE_RESET_MIN_US)) {
        device.busReset();
        listening = false;
        const from = now + clock.us(ONE_WIRE_PRESENCE_WAIT_US);
        presenceUntil = from + clock.us(ONE_WIRE_PRESENCE_US);
        return pull(from, presenceUntil);
      }
      if (listening) device.writeBit(width < clock.us(ONE_WIRE_SAMPLE_US) ? 1 : 0, clock);
      listening = false;
      return null;
    },
    update(props) {
      if ('temperature' in props) device.temperatureC = numberField(props.temperature, device.temperatureC);
    },
    reset() {
      lowAt = null;
      listening = false;
      presenceUntil = -Infinity;
      device.powerOn();
    },
  };
  return model;
});

registerModuleModel(
  'ds18b20',
  lineModule('ds18b20', ['temperature'], (componentId) => ({ rom_seed: componentId })),
);
