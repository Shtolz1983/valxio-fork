/**
 * The first I2C models a parts-catalog card can name in `sim.model`
 * (models/registry.ts). Each answers the bytes its Arduino library reads (checked
 * against BH1750, Adafruit AHTX0 and Adafruit SHT31) from the values the
 * sensor panel sets; there is no timing, a measurement is ready at once.
 *
 * They run on the in-browser bus fabric (Uno, Nano, Mega, Pico); on an
 * ESP32 under QEMU their Python twins in backend/app/services/
 * catalog_i2c_models.py answer the guest.
 */
import type { I2CDevice } from '../simulation/I2CBusManager';
import { i2cModel, registerModuleModel } from './models/registry';

/** Sensirion / Aosong CRC-8: polynomial 0x31, init 0xFF. */
export function crc8(bytes: number[]): number {
  let crc = 0xff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A model that answers every read from the start of a frame its last command chose. */
export abstract class FrameDevice implements I2CDevice {
  values: Record<string, number> = {};
  /** Bytes of the last write phase: the command the next read answers. */
  protected command: number[] = [];
  private frame: number[] = [];
  private index = 0;
  /** The write phase ended; the next written byte starts a new command. */
  private closed = true;

  address: number;

  constructor(address: number) {
    this.address = address;
  }

  /** The frame a read returns after the command bytes written so far. */
  protected abstract frameFor(): number[];

  writeByte(value: number): boolean {
    if (this.closed) this.command = [];
    this.closed = false;
    this.command.push(value & 0xff);
    this.index = 0;
    return true;
  }

  start(read: boolean): void {
    this.closed = true;
    if (read) this.index = 0;
  }

  readByte(): number {
    this.closed = true;
    if (this.index === 0) this.frame = this.frameFor();
    return this.index < this.frame.length ? this.frame[this.index++] : 0xff;
  }

  stop(): void {
    this.closed = true;
    this.index = 0;
  }
}

/** BH1750 ambient light: one opcode per write, a 16-bit big-endian count per read. */
export class Bh1750Model extends FrameDevice {
  private mode = 0x10;
  private mtreg = 69;

  override writeByte(value: number): boolean {
    const op = value & 0xff;
    if ((op & 0xf8) === 0x40) this.mtreg = ((op & 0x07) << 5) | (this.mtreg & 0x1f);
    else if ((op & 0xe0) === 0x60) this.mtreg = (this.mtreg & 0xe0) | (op & 0x1f);
    else if ([0x10, 0x11, 0x13, 0x20, 0x21, 0x23].includes(op)) this.mode = op;
    return super.writeByte(value);
  }

  protected frameFor(): number[] {
    const lux = this.values.lux ?? 0;
    const hiRes2 = this.mode === 0x11 || this.mode === 0x21;
    const raw = Math.round(clamp(lux * 1.2 * (this.mtreg / 69) * (hiRes2 ? 2 : 1), 0, 0xffff));
    return [raw >> 8, raw & 0xff];
  }
}

/** AHT20: a status byte (calibrated, never busy), then 20-bit humidity and temperature, then CRC. */
export class Aht20Model extends FrameDevice {
  protected frameFor(): number[] {
    const status = 0x18;
    if (this.command[0] !== 0xac) return [status];
    const h = Math.round(clamp((this.values.humidity ?? 0) / 100, 0, 1) * 0xfffff);
    const t = Math.round(clamp(((this.values.temperature ?? 0) + 50) / 200, 0, 1) * 0xfffff);
    const data = [status, (h >> 12) & 0xff, (h >> 4) & 0xff, ((h & 0x0f) << 4) | ((t >> 16) & 0x0f), (t >> 8) & 0xff, t & 0xff];
    return [...data, crc8(data)];
  }
}

/** SHT3x: 16-bit commands; a measurement reads T, CRC, RH, CRC; the status register reads 0x0000. */
export class Sht31Model extends FrameDevice {
  protected frameFor(): number[] {
    const cmd = ((this.command[0] ?? 0) << 8) | (this.command[1] ?? 0);
    const word = (v: number) => {
      const bytes = [(v >> 8) & 0xff, v & 0xff];
      return [...bytes, crc8(bytes)];
    };
    if (cmd === 0xf32d) return word(0);
    const t = Math.round(clamp(((this.values.temperature ?? 0) + 45) / 175, 0, 1) * 0xffff);
    const h = Math.round(clamp((this.values.humidity ?? 0) / 100, 0, 1) * 0xffff);
    return [...word(t), ...word(h)];
  }
}

registerModuleModel('bh1750', i2cModel(['lux'], (a) => new Bh1750Model(a), 'bh1750'));
registerModuleModel('aht20', i2cModel(['temperature', 'humidity'], (a) => new Aht20Model(a), 'aht20'));
registerModuleModel('sht31', i2cModel(['temperature', 'humidity'], (a) => new Sht31Model(a), 'sht31'));
