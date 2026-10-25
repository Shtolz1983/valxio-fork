/**
 * Bosch environmental sensors behind generic catalog modules: BME280, BMP180
 * and BME680. Each holds a calibration block chosen here, and a measurement
 * puts in the data registers the raw ADC words that the card's library turns
 * back into the panel's values: the driver's own compensation, run backwards
 * by a search over the ADC word (the approach of VirtualBMP280 in
 * simulation/I2CBusManager.ts).
 *
 * Common to all three, as on the chip:
 *  - a write is pairs of register address and data, the address does not
 *    count up (the Bosch drivers write a whole config block as such pairs);
 *    a read counts up from the last address written;
 *  - the soft reset word 0xB6 at 0xE0 puts the control and data registers
 *    back to their reset values; the calibration is NVM and the panel is the
 *    world around the chip, so both survive it;
 *  - a conversion takes no time: forced mode is back at sleep at once, with
 *    the data of that instant; normal mode answers each read from the panel
 *    at the START of that read, so one burst is one measurement.
 *
 * No IIR filter and no measurement timing are modelled. In-browser boards
 * (Uno, Nano, Mega, Pico), and all three on an ESP32 through their Python
 * twins: the BME280 in backend/app/services/catalog_i2c_models.py, the BMP180
 * and BME680 in catalog_i2c_bosch.py.
 */
import { i2cModel, registerModuleModel, type ValueI2cDevice } from './registry';

const f = Math.fround;
const trunc = Math.trunc;
/** C int32 wrap-around of an exact (|x| < 2^53) product or sum. */
const i32 = (x: number) => x | 0;
const u32 = (x: number) => ((x % 4294967296) + 4294967296) % 4294967296;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The integer in [lo, hi] whose `fn` is closest to `target`, for `fn`
 * monotonic (rising, or falling with `falling`).
 */
export function invertMonotonic(
  fn: (x: number) => number,
  target: number,
  lo: number,
  hi: number,
  falling = false,
): number {
  const g = falling ? (x: number) => -fn(x) : fn;
  const t = falling ? -target : target;
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    if (g(mid) < t) a = mid + 1;
    else b = mid;
  }
  if (a > lo && Math.abs(g(a - 1) - t) <= Math.abs(g(a) - t)) return a - 1;
  return a;
}

/** 20-bit ADC word as msb, lsb, xlsb (bits 7:4). */
const adc20 = (v: number): number[] => [(v >> 12) & 0xff, (v >> 4) & 0xff, (v & 0x0f) << 4];

/**
 * A Bosch register file on I2C: pairs written, auto-increment read, and a
 * `latch` hook at the start of every read for chips that measure by
 * themselves (normal mode).
 */
abstract class BoschRegisterDevice implements ValueI2cDevice {
  address: number;
  values: Record<string, number> = {};
  protected readonly regs = new Uint8Array(256);
  private pointer = 0;
  /** The next byte written is a register address. */
  private firstByte = true;
  /** No START was heard for the read that comes next: latch on its first byte. */
  private latchDue = true;

  constructor(address: number) {
    this.address = address;
  }

  start(read: boolean): void {
    if (read) {
      this.latch();
      this.latchDue = false;
    }
  }

  writeByte(value: number): boolean {
    this.latchDue = true;
    if (this.firstByte) {
      this.pointer = value & 0xff;
      this.firstByte = false;
      return true;
    }
    this.firstByte = true;
    this.writeRegister(this.pointer, value & 0xff);
    return true;
  }

  readByte(): number {
    if (this.latchDue) {
      this.latch();
      this.latchDue = false;
    }
    const reg = this.pointer;
    this.pointer = (reg + 1) & 0xff;
    return this.readRegister(reg);
  }

  stop(): void {
    this.firstByte = true;
    this.latchDue = true;
  }

  protected value(key: string, fallback: number): number {
    const v = this.values[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  /** A read begins. */
  protected latch(): void {}

  protected readRegister(reg: number): number {
    return this.regs[reg];
  }

  protected abstract writeRegister(reg: number, value: number): void;
}

/** A tiny memo of the last ADC words computed, keyed by the panel values they answer. */
class Memo<T> {
  private key = '';
  private value: T | null = null;
  get(key: string, make: () => T): T {
    if (this.value === null || key !== this.key) {
      this.key = key;
      this.value = make();
    }
    return this.value;
  }
}

// ── BME280 ──────────────────────────────────────────────────────────────────

/** BMP280 datasheet example T/P trimming (as VirtualBMP280), typical humidity trimming. */
const BME280_CAL = {
  T1: 27504, T2: 26435, T3: -1000,
  P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7, P7: 15500, P8: -14600, P9: 6000,
  H1: 75, H2: 362, H3: 0, H4: 313, H5: 50, H6: 30,
} as const;

const BME280 = {
  ID: 0xd0,
  RESET: 0xe0,
  CTRL_HUM: 0xf2,
  STATUS: 0xf3,
  CTRL_MEAS: 0xf4,
  CONFIG: 0xf5,
  DATA: 0xf7,
} as const;

/** Adafruit_BME280::readTemperature's t_fine (C int32 arithmetic, `/` truncating). */
export function bme280TFine(adcT: number): number {
  const c = BME280_CAL;
  let var1 = trunc(adcT / 8) - c.T1 * 2;
  var1 = trunc(i32(var1 * c.T2) / 2048);
  let var2 = trunc(adcT / 16) - c.T1;
  var2 = trunc(i32(trunc(i32(var2 * var2) / 4096) * c.T3) / 16384);
  return var1 + var2;
}

/** Adafruit_BME280::readPressure (int64 path), in Pa. */
export function bme280Pressure(adcP: number, tFine: number): number {
  const c = BME280_CAL;
  const B = BigInt;
  let var1 = B(tFine) - 128000n;
  let var2 = var1 * var1 * B(c.P6);
  var2 = var2 + var1 * B(c.P5) * 131072n;
  var2 = var2 + B(c.P4) * 34359738368n;
  var1 = (var1 * var1 * B(c.P3)) / 256n + var1 * B(c.P2) * 4096n;
  const var3 = 140737488355328n;
  var1 = ((var3 + var1) * B(c.P1)) / 8589934592n;
  if (var1 === 0n) return 0;
  let var4 = 1048576n - B(adcP);
  var4 = ((var4 * 2147483648n - var2) * 3125n) / var1;
  var1 = (B(c.P9) * (var4 / 8192n) * (var4 / 8192n)) / 33554432n;
  var2 = (B(c.P8) * var4) / 524288n;
  var4 = (var4 + var1 + var2) / 256n + B(c.P7) * 16n;
  return f(Number(var4)) / 256;
}

/** Adafruit_BME280::readHumidity (C int32 arithmetic), in %. */
export function bme280Humidity(adcH: number, tFine: number): number {
  const c = BME280_CAL;
  const var1 = tFine - 76800;
  let var2 = i32(adcH * 16384);
  let var3 = i32(c.H4 * 1048576);
  let var4 = i32(c.H5 * var1);
  let var5 = trunc(i32(var2 - var3 - var4 + 16384) / 32768);
  var2 = trunc(i32(var1 * c.H6) / 1024);
  var3 = trunc(i32(var1 * c.H3) / 2048);
  var4 = trunc(i32(var2 * (var3 + 32768)) / 1024) + 2097152;
  var2 = trunc(i32(var4 * c.H2 + 8192) / 16384);
  var3 = i32(var5 * var2);
  var4 = trunc(i32(trunc(var3 / 32768) * trunc(var3 / 32768)) / 128);
  var5 = var3 - trunc(i32(var4 * c.H1) / 16);
  var5 = clamp(var5, 0, 419430400);
  return Math.floor(var5 / 4096) / 1024;
}

/**
 * BME280 as Adafruit BME280 Library reads it: chip id 0x60 at 0xD0 (begin()
 * fails on anything else), soft reset at 0xE0, status bit 0 (im_update) clear
 * so the calibration wait ends, T/P trimming at 0x88-0x9F and humidity
 * trimming at 0xA1 and 0xE1-0xE7 with H4/H5 packed in nibbles as the library
 * unpacks them. ctrl_hum (0xF2) takes effect at the next ctrl_meas write, as
 * the library's comment on DS 5.4.3 says; a skipped channel (osrs = 0) reads
 * its reset value (0x80000, humidity 0x8000). Forced mode measures once and
 * returns to sleep; takeForcedMeasurement() sees status bit 3 (measuring) once
 * and then clear. Before any mode is selected the data registers hold their
 * reset values.
 */
export class Bme280Model extends BoschRegisterDevice {
  /** osrs_h as of the last ctrl_meas write. */
  private osrsH = 0;
  private measuring = false;
  private readonly memo = new Memo<{ t: number; p: number; h: number }>();

  constructor(address: number) {
    super(address);
    this.writeCalibration();
    this.powerOn();
  }

  private writeCalibration(): void {
    const c = BME280_CAL;
    const r = this.regs;
    const le = (a: number, v: number) => {
      r[a] = v & 0xff;
      r[a + 1] = (v >> 8) & 0xff;
    };
    le(0x88, c.T1);
    le(0x8a, c.T2);
    le(0x8c, c.T3);
    le(0x8e, c.P1);
    le(0x90, c.P2);
    le(0x92, c.P3);
    le(0x94, c.P4);
    le(0x96, c.P5);
    le(0x98, c.P6);
    le(0x9a, c.P7);
    le(0x9c, c.P8);
    le(0x9e, c.P9);
    r[0xa1] = c.H1;
    le(0xe1, c.H2);
    r[0xe3] = c.H3;
    r[0xe4] = (c.H4 >> 4) & 0xff;
    r[0xe5] = ((c.H5 & 0x0f) << 4) | (c.H4 & 0x0f);
    r[0xe6] = (c.H5 >> 4) & 0xff;
    r[0xe7] = c.H6 & 0xff;
  }

  private powerOn(): void {
    const r = this.regs;
    r[BME280.ID] = 0x60;
    r[BME280.CTRL_HUM] = 0;
    r[BME280.STATUS] = 0;
    r[BME280.CTRL_MEAS] = 0;
    r[BME280.CONFIG] = 0;
    r.set([0x80, 0, 0, 0x80, 0, 0, 0x80, 0], BME280.DATA);
    this.osrsH = 0;
    this.measuring = false;
  }

  private get mode(): number {
    return this.regs[BME280.CTRL_MEAS] & 0x03;
  }

  /** The raw words of a measurement taken now. */
  private adcWords(): { t: number; p: number; h: number } {
    const T = this.value('temperature', 24);
    const H = this.value('humidity', 50);
    const P = this.value('pressure', 1013.25);
    return this.memo.get(`${T}|${H}|${P}`, () => {
      const centi = Math.round(T * 100);
      const t = invertMonotonic((a) => trunc((bme280TFine(a) * 5 + 128) / 256), centi, 0, 0xfffff);
      const tf = bme280TFine(t);
      const p = invertMonotonic((a) => bme280Pressure(a, tf), P * 100, 0, 0xfffff, true);
      const h = invertMonotonic((a) => bme280Humidity(a, tf), clamp(H, 0, 100), 0, 0xffff);
      return { t, p, h };
    });
  }

  private measure(ctrlMeas: number): void {
    const osrsT = (ctrlMeas >> 5) & 7;
    const osrsP = (ctrlMeas >> 2) & 7;
    const w = this.adcWords();
    const press = osrsP ? adc20(w.p) : [0x80, 0, 0];
    const temp = osrsT ? adc20(w.t) : [0x80, 0, 0];
    const hum = this.osrsH ? [(w.h >> 8) & 0xff, w.h & 0xff] : [0x80, 0];
    this.regs.set([...press, ...temp, ...hum], BME280.DATA);
  }

  protected override latch(): void {
    if (this.mode === 3) this.measure(this.regs[BME280.CTRL_MEAS]);
  }

  protected override readRegister(reg: number): number {
    if (reg === BME280.STATUS) {
      const status = this.measuring ? 0x08 : 0;
      this.measuring = false;
      return status;
    }
    return this.regs[reg];
  }

  protected writeRegister(reg: number, value: number): void {
    switch (reg) {
      case BME280.RESET:
        if (value === 0xb6) this.powerOn();
        return;
      case BME280.CTRL_HUM:
        this.regs[reg] = value & 0x07;
        return;
      case BME280.CONFIG:
        this.regs[reg] = value;
        return;
      case BME280.CTRL_MEAS:
        break;
      default:
        return;
    }
    this.osrsH = this.regs[BME280.CTRL_HUM] & 0x07;
    const mode = value & 0x03;
    if (mode === 0) {
      // It measured until now, so what it holds asleep is this instant.
      if (this.mode === 3) this.measure(this.regs[reg]);
      this.measuring = false;
      this.regs[reg] = value;
      return;
    }
    this.measuring = true;
    if (mode === 3) {
      this.regs[reg] = value;
      return;
    }
    this.measure(value);
    this.regs[reg] = value & ~0x03;
  }
}

// ── BMP180 ──────────────────────────────────────────────────────────────────

/** BMP180 datasheet example calibration (BST-BMP180-DS000, 3.5). */
const BMP180_CAL = {
  AC1: 408, AC2: -72, AC3: -14383, AC4: 32741, AC5: 32757, AC6: 23153,
  B1: 6190, B2: 4, MB: -32768, MC: -8711, MD: 2868,
} as const;

/** Adafruit_BMP085::computeB5. */
export function bmp180B5(ut: number): number {
  const c = BMP180_CAL;
  const x1 = ((ut - c.AC6) * c.AC5) >> 15;
  const x2 = trunc((c.MC * 2048) / (x1 + c.MD));
  return x1 + x2;
}

/** Adafruit_BMP085::readTemperature, in 0.1 °C. */
export function bmp180Tenths(ut: number): number {
  return (bmp180B5(ut) + 8) >> 4;
}

/** Adafruit_BMP085::readPressure, in Pa (C int32 / uint32 arithmetic). */
export function bmp180Pressure(up: number, ut: number, oss: number): number {
  const c = BMP180_CAL;
  const b5 = bmp180B5(ut);
  const b6 = b5 - 4000;
  let x1 = (c.B2 * ((b6 * b6) >> 12)) >> 11;
  let x2 = (c.AC2 * b6) >> 11;
  let x3 = x1 + x2;
  const b3 = trunc((((c.AC1 * 4 + x3) << oss) + 2) / 4);
  x1 = (c.AC3 * b6) >> 13;
  x2 = (c.B1 * ((b6 * b6) >> 12)) >> 16;
  x3 = (x1 + x2 + 2) >> 2;
  const b4 = Math.floor(u32(c.AC4 * u32(x3 + 32768)) / 32768);
  const b7 = u32(u32(up - b3) * (50000 >> oss));
  let p = b7 < 0x80000000 ? Math.floor((b7 * 2) / b4) : Math.floor(b7 / b4) * 2;
  p = i32(p);
  x1 = (p >> 8) * (p >> 8);
  x1 = i32(x1 * 3038) >> 16;
  x2 = i32(-7357 * p) >> 16;
  return p + ((x1 + x2 + 3791) >> 4);
}

/** The lowest UT with X1 + MD > 0: below it B5 is not monotonic (the datasheet's division). */
const BMP180_UT_MIN = (() => {
  let ut = BMP180_CAL.AC6;
  while (((ut - 1 - BMP180_CAL.AC6) * BMP180_CAL.AC5 >> 15) + BMP180_CAL.MD > 0) ut--;
  return ut;
})();

/**
 * BMP180 (BMP085 protocol) as Adafruit BMP085 Library reads it: chip id 0x55
 * at 0xD0, eleven big-endian calibration words at 0xAA-0xBF, a command
 * written to 0xF4 (0x2E temperature, 0x34 + (oss << 6) pressure) and the
 * result at 0xF6-0xF8: UT as 16 bits, UP as UP << (8 - oss) in 24 bits, the
 * way readRawPressure() shifts it back. The conversion is done at once, so
 * the start bit (sco, bit 5 of 0xF4) reads clear. The result registers hold
 * 0x80 0x00 0x00 until the first command.
 */
export class Bmp180Model extends BoschRegisterDevice {
  private readonly memoT = new Memo<number>();
  private readonly memoP = new Memo<number>();

  constructor(address: number) {
    super(address);
    const c = BMP180_CAL;
    [c.AC1, c.AC2, c.AC3, c.AC4, c.AC5, c.AC6, c.B1, c.B2, c.MB, c.MC, c.MD].forEach((v, i) => {
      this.regs[0xaa + 2 * i] = (v >> 8) & 0xff;
      this.regs[0xab + 2 * i] = v & 0xff;
    });
    this.powerOn();
  }

  private powerOn(): void {
    this.regs[0xd0] = 0x55;
    this.regs[0xf4] = 0;
    this.regs.set([0x80, 0, 0], 0xf6);
  }

  private ut(): number {
    const T = this.value('temperature', 24);
    return this.memoT.get(String(T), () =>
      invertMonotonic(bmp180Tenths, Math.round(T * 10), BMP180_UT_MIN, 0xffff),
    );
  }

  private up(oss: number): number {
    const P = this.value('pressure', 1013.25);
    const ut = this.ut();
    return this.memoP.get(`${ut}|${P}|${oss}`, () =>
      invertMonotonic((a) => bmp180Pressure(a, ut, oss), Math.round(P * 100), 0, (1 << (16 + oss)) - 1),
    );
  }

  protected writeRegister(reg: number, value: number): void {
    if (reg === 0xe0) {
      if (value === 0xb6) this.powerOn();
      return;
    }
    if (reg !== 0xf4) return;
    if (value === 0x2e) {
      const ut = this.ut();
      this.regs.set([(ut >> 8) & 0xff, ut & 0xff], 0xf6);
    } else if ((value & 0x3f) === 0x34) {
      const oss = value >> 6;
      const raw = this.up(oss) << (8 - oss);
      this.regs.set([(raw >> 16) & 0xff, (raw >> 8) & 0xff, raw & 0xff], 0xf6);
    }
    this.regs[reg] = value & ~0x20;
  }
}

// ── BME680 ──────────────────────────────────────────────────────────────────

/** Trimming of a typical BME680 (values seen on production parts). */
const BME680_CAL = {
  T1: 26041, T2: 26170, T3: 3,
  P1: 36174, P2: -10335, P3: 88, P4: 7166, P5: -144, P6: 30, P7: 41, P8: -3127, P9: -2600, P10: 30,
  H1: 790, H2: 1007, H3: 0, H4: 45, H5: 20, H6: 120, H7: -100,
  GH1: -30, GH2: -12000, GH3: 18,
  RES_HEAT_VAL: 41, RES_HEAT_RANGE: 1, RANGE_SW_ERR: 0,
} as const;

/** bme68x.c (float path, BME68X_USE_FPU) calc_temperature: [°C, t_fine]. */
export function bme680Temperature(adc: number): [number, number] {
  const c = BME680_CAL;
  const a = f(adc);
  const var1 = f(f(f(a / 16384) - f(c.T1 / 1024)) * c.T2);
  const d = f(f(a / 131072) - f(c.T1 / 8192));
  const var2 = f(f(d * d) * f(c.T3 * 16));
  const tFine = f(var1 + var2);
  return [f(tFine / 5120), tFine];
}

/** bme68x.c calc_pressure (float), in Pa. */
export function bme680Pressure(adc: number, tFine: number): number {
  const c = BME680_CAL;
  let var1 = f(f(tFine / 2) - 64000);
  let var2 = f(f(var1 * var1) * f(c.P6 / 131072));
  var2 = f(var2 + f(f(var1 * c.P5) * 2));
  var2 = f(f(var2 / 4) + f(c.P4 * 65536));
  var1 = f(f(f(f(f(c.P3 * var1) * var1) / 16384) + f(c.P2 * var1)) / 524288);
  var1 = f(f(1 + f(var1 / 32768)) * c.P1);
  let p = f(1048576 - adc);
  if (trunc(var1) === 0) return 0;
  p = f(f(f(p - f(var2 / 4096)) * 6250) / var1);
  var1 = f(f(f(c.P9 * p) * p) / 2147483648);
  var2 = f(p * f(c.P8 / 32768));
  const q = f(p / 256);
  const var3 = f(f(f(q * q) * q) * f(c.P10 / 131072));
  return f(p + f(f(f(f(var1 + var2) + var3) + f(c.P7 * 128)) / 16));
}

/** bme68x.c calc_humidity (float), in %. */
export function bme680Humidity(adc: number, tFine: number): number {
  const c = BME680_CAL;
  const tc = f(tFine / 5120);
  const var1 = f(adc - f(f(c.H1 * 16) + f(f(c.H3 / 2) * tc)));
  const k = f(f(1 + f(f(c.H4 / 16384) * tc)) + f(f(f(c.H5 / 1048576) * tc) * tc));
  const var2 = f(var1 * f(f(c.H2 / 262144) * k));
  const var3 = f(c.H6 / 16384);
  const var4 = f(c.H7 / 2097152);
  const h = f(var2 + f(f(f(var3 + f(var4 * tc)) * var2) * var2));
  return clamp(h, 0, 100);
}

const K1 = [0, 0, 0, 0, 0, -1, 0, -0.8, 0, 0, -0.2, -0.5, 0, -1, 0, 0].map(f);
const K2 = [0, 0, 0, 0, 0.1, 0.7, 0, -0.8, -0.1, 0, 0, 0, 0, 0, 0, 0].map(f);

/** bme68x.c calc_gas_resistance_low (the BME680, variant 0), in Ω. */
export function bme680GasLow(adc: number, range: number): number {
  const var1 = f(1340 + f(5 * BME680_CAL.RANGE_SW_ERR));
  const var2 = f(var1 * f(1 + f(K1[range] / 100)));
  const var3 = f(1 + f(K2[range] / 100));
  return f(1 / f(f(f(var3 * f(0.000000125)) * (1 << range)) * f(f(f(adc - 512) / var2) + 1)));
}

const BME680 = {
  FIELD0: 0x1d,
  CTRL_GAS_0: 0x70,
  CTRL_GAS_1: 0x71,
  CTRL_HUM: 0x72,
  CTRL_MEAS: 0x74,
  ID: 0xd0,
  RESET: 0xe0,
  VARIANT: 0xf0,
} as const;

/**
 * BME680 as Adafruit BME680 Library (Bosch bme68x driver, float path) reads
 * it: chip id 0x61 at 0xD0 and variant 0x00 at 0xF0 (gas low: resistance from
 * gas_r at 0x2A/0x2B with range_sw_err), the three calibration blocks
 * 0x8A-0xA0, 0xE1-0xEE and 0x00-0x04 in the driver's index layout. Writes
 * to 0x50-0x75 (heater set-points, ctrl_gas, ctrl_hum, ctrl_meas, config) are
 * kept. A forced-mode write to ctrl_meas measures at once: field 0
 * (0x1D-0x2D) gets new_data, a meas_index, the T/P/H words, and with run_gas
 * set a gas word and range with gas_valid, plus heat_stab while the heater is
 * on; the mode bits read sleep again, which is what bme68x_set_op_mode polls
 * for. ctrl_hum takes effect at the ctrl_meas write; a skipped channel reads
 * its reset value. Until the first measurement new_data is clear, so
 * bme68x_get_data reports no new data.
 */
export class Bme680Model extends BoschRegisterDevice {
  private osrsH = 0;
  private measIndex = 0;
  private readonly memo = new Memo<{ t: number; p: number; h: number }>();
  private readonly memoGas = new Memo<{ adc: number; range: number }>();

  constructor(address: number) {
    super(address);
    this.writeCalibration();
    this.powerOn();
  }

  private writeCalibration(): void {
    const c = BME680_CAL;
    const r = this.regs;
    const le = (a: number, v: number) => {
      r[a] = v & 0xff;
      r[a + 1] = (v >> 8) & 0xff;
    };
    le(0x8a, c.T2);
    r[0x8c] = c.T3 & 0xff;
    le(0x8e, c.P1);
    le(0x90, c.P2);
    r[0x92] = c.P3 & 0xff;
    le(0x94, c.P4);
    le(0x96, c.P5);
    r[0x98] = c.P7 & 0xff;
    r[0x99] = c.P6 & 0xff;
    le(0x9c, c.P8);
    le(0x9e, c.P9);
    r[0xa0] = c.P10 & 0xff;
    r[0xe1] = (c.H2 >> 4) & 0xff;
    r[0xe2] = ((c.H2 & 0x0f) << 4) | (c.H1 & 0x0f);
    r[0xe3] = (c.H1 >> 4) & 0xff;
    r[0xe4] = c.H3 & 0xff;
    r[0xe5] = c.H4 & 0xff;
    r[0xe6] = c.H5 & 0xff;
    r[0xe7] = c.H6 & 0xff;
    r[0xe8] = c.H7 & 0xff;
    le(0xe9, c.T1);
    le(0xeb, c.GH2);
    r[0xed] = c.GH1 & 0xff;
    r[0xee] = c.GH3 & 0xff;
    r[0x00] = c.RES_HEAT_VAL & 0xff;
    r[0x02] = (c.RES_HEAT_RANGE & 0x03) << 4;
    r[0x04] = (c.RANGE_SW_ERR & 0x0f) << 4;
  }

  private powerOn(): void {
    const r = this.regs;
    r.fill(0, 0x50, 0x76);
    r.fill(0, BME680.FIELD0, BME680.FIELD0 + 17);
    r.set([0x80, 0, 0, 0x80, 0, 0, 0x80, 0], BME680.FIELD0 + 2);
    r[BME680.ID] = 0x61;
    r[BME680.VARIANT] = 0x00;
    this.osrsH = 0;
    this.measIndex = 0;
  }

  private adcWords(): { t: number; p: number; h: number } {
    const T = this.value('temperature', 24);
    const H = this.value('humidity', 50);
    const P = this.value('pressure', 1013.25);
    return this.memo.get(`${T}|${H}|${P}`, () => {
      const t = invertMonotonic((a) => bme680Temperature(a)[0], T, 0, 0xfffff);
      const tf = bme680Temperature(t)[1];
      const p = invertMonotonic((a) => bme680Pressure(a, tf), P * 100, 0, 0xfffff, true);
      const lo = Math.max(0, Math.floor(bme680HumidityZero(tf)));
      const h = invertMonotonic((a) => bme680Humidity(a, tf), clamp(H, 0, 100), lo, 0xffff);
      return { t, p, h };
    });
  }

  /** The gas ADC word and range whose resistance is closest to the panel's (kΩ). */
  private gasWord(): { adc: number; range: number } {
    const G = clamp(this.value('gas', 50), 0.001, 1e6) * 1000;
    return this.memoGas.get(String(G), () => {
      let best = { adc: 512, range: 0, err: Infinity };
      for (let range = 0; range < 16; range++) {
        const adc = invertMonotonic((a) => bme680GasLow(a, range), G, 0, 1023, true);
        const err = Math.abs(bme680GasLow(adc, range) - G);
        if (err < best.err) best = { adc, range, err };
      }
      return { adc: best.adc, range: best.range };
    });
  }

  private measure(ctrlMeas: number): void {
    const r = this.regs;
    const osrsT = (ctrlMeas >> 5) & 7;
    const osrsP = (ctrlMeas >> 2) & 7;
    const w = this.adcWords();
    const press = osrsP ? adc20(w.p) : [0x80, 0, 0];
    const temp = osrsT ? adc20(w.t) : [0x80, 0, 0];
    const hum = this.osrsH ? [(w.h >> 8) & 0xff, w.h & 0xff] : [0x80, 0];
    const runGas = (r[BME680.CTRL_GAS_1] & 0x10) !== 0;
    const heaterOn = (r[BME680.CTRL_GAS_0] & 0x08) === 0;
    let gas = [0, 0];
    if (runGas) {
      const g = this.gasWord();
      const flags = 0x20 | (heaterOn ? 0x10 : 0);
      gas = [(g.adc >> 2) & 0xff, ((g.adc & 0x03) << 6) | flags | g.range];
    }
    this.measIndex = (this.measIndex + 1) & 0xff;
    r.set([0x80, this.measIndex, ...press, ...temp, ...hum, 0, 0, 0, ...gas, ...gas], BME680.FIELD0);
  }

  protected writeRegister(reg: number, value: number): void {
    if (reg === BME680.RESET) {
      if (value === 0xb6) this.powerOn();
      return;
    }
    if (reg < 0x50 || reg > 0x75) return;
    if (reg !== BME680.CTRL_MEAS) {
      this.regs[reg] = value;
      return;
    }
    this.osrsH = this.regs[BME680.CTRL_HUM] & 0x07;
    if ((value & 0x03) === 0x01) {
      this.measure(value);
      this.regs[reg] = value & ~0x03;
      return;
    }
    this.regs[reg] = value;
  }
}

/** The humidity ADC word where bme68x's var1 is 0: below it the curve folds back. */
function bme680HumidityZero(tFine: number): number {
  const c = BME680_CAL;
  return c.H1 * 16 + (c.H3 / 2) * (tFine / 5120);
}

registerModuleModel('bme280', i2cModel(['temperature', 'humidity', 'pressure'], (a) => new Bme280Model(a), 'bme280'));
registerModuleModel('bmp180', i2cModel(['temperature', 'pressure'], (a) => new Bmp180Model(a), 'bmp180'));
registerModuleModel('bme680', i2cModel(['temperature', 'humidity', 'pressure', 'gas'], (a) => new Bme680Model(a), 'bme680'));
