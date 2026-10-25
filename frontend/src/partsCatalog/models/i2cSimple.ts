/**
 * Register-file I2C chips of the catalog cards whose library reads a few
 * registers and computes the reading itself: ADXL345, INA219, MLX90614,
 * QMC5883L and CCS811. Each answers what its card's library reads and checks
 * (Adafruit ADXL345 1.3, Adafruit INA219 1.2, Adafruit MLX90614 2.1,
 * QMC5883LCompass 1.2, Adafruit CCS811 1.1), from the sensor panel's values.
 *
 * Only the CCS811 keeps time (its drive mode sets when a sample is ready); the
 * others have a measurement ready at once. In-browser boards, and on an ESP32
 * through their Python twins in backend/app/services/catalog_i2c_simple.py.
 */
import type { GuestClock } from '../../simulation/buses/types';
import { i2cModel, registerModuleModel, type ValueI2cDevice } from './registry';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: number | undefined, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * The usual 8-bit register file: the first byte of a write is the register
 * pointer, the bytes after it are written there, and both directions move the
 * pointer on by one.
 */
abstract class PointerDevice implements ValueI2cDevice {
  values: Record<string, number> = {};
  address: number;
  protected pointer = 0;
  /** The next written byte is a register pointer. */
  private awaitingPointer = true;
  /** A read phase is under way (its sample latched). */
  private reading = false;

  constructor(address: number) {
    this.address = address;
  }

  protected abstract readRegister(reg: number): number;
  protected abstract writeRegister(reg: number, value: number): void;
  /** The register after `reg` in a burst. */
  protected next(reg: number): number {
    return (reg + 1) & 0xff;
  }
  /** A read phase begins: a chip that latches a sample for the burst does it here. */
  protected beginRead(): void {}

  writeByte(value: number): boolean {
    this.reading = false;
    if (this.awaitingPointer) {
      this.pointer = value & 0xff;
      this.awaitingPointer = false;
    } else {
      this.writeRegister(this.pointer, value & 0xff);
      this.pointer = this.next(this.pointer);
    }
    return true;
  }

  readByte(): number {
    // A host that does not report STARTs: the read began at its first byte.
    if (!this.reading) this.start(true);
    const v = this.readRegister(this.pointer) & 0xff;
    this.pointer = this.next(this.pointer);
    return v;
  }

  start(read: boolean): void {
    this.reading = read;
    if (read) this.beginRead();
    else this.awaitingPointer = true;
  }

  stop(): void {
    this.awaitingPointer = true;
    this.reading = false;
  }
}

// ── ADXL345 ─────────────────────────────────────────────────────────────────

/**
 * ADXL345 accelerometer. Adafruit_ADXL345_Unified::begin() wants DEVID 0xE5
 * and sets POWER_CTL.Measure; getX/Y/Z read DATAX0..DATAZ1 little-endian and
 * multiply by 4 mg per LSB whatever the range, and setRange() always sets
 * FULL_RES, where the chip keeps 4 mg per LSB too. So a count is 1/0.004 per g
 * (the datasheet's typical is 256, which the library would print 2 % high);
 * in 10-bit mode the count halves per range step and saturates at 10 bits,
 * at full resolution it saturates at 10 + range bits. JUSTIFY left-aligns the
 * count, OFSX/Y/Z add 15.6 mg per LSB. In standby the data registers keep the
 * last sample (zero from power-on).
 */
export class Adxl345Model extends PointerDevice {
  private regs = new Uint8Array(64);
  /** The six data bytes of the burst being read. */
  private sample = [0, 0, 0, 0, 0, 0];

  constructor(address: number) {
    super(address);
    this.reset();
  }

  private reset(): void {
    this.regs.fill(0);
    this.regs[0x00] = 0xe5; // DEVID
    this.regs[0x2c] = 0x0a; // BW_RATE: 100 Hz
    this.regs[0x30] = 0x02; // INT_SOURCE: watermark
  }

  private get measuring(): boolean {
    return (this.regs[0x2d] & 0x08) !== 0;
  }

  /** The count of one axis for `g`, as DATA_FORMAT sets it. */
  private count(g: number, offsetReg: number): number {
    const format = this.regs[0x31];
    const range = format & 0x03;
    const fullRes = (format & 0x08) !== 0;
    const bits = fullRes ? 10 + range : 10;
    const offsetG = ((this.regs[offsetReg] << 24) >> 24) * 0.0156;
    const lsbPerG = fullRes ? 250 : 250 / (1 << range);
    const raw = clamp(Math.round((g + offsetG) * lsbPerG), -(1 << (bits - 1)), (1 << (bits - 1)) - 1);
    // JUSTIFY: MSB-aligned in the 16 bits.
    return (format & 0x04 ? raw << (16 - bits) : raw) & 0xffff;
  }

  private latch(): void {
    if (!this.measuring) return;
    const axes = [
      this.count(num(this.values.accelX), 0x1e),
      this.count(num(this.values.accelY), 0x1f),
      this.count(num(this.values.accelZ, 1), 0x20),
    ];
    this.sample = axes.flatMap((c) => [c & 0xff, c >> 8]);
  }

  protected override beginRead(): void {
    if (this.pointer >= 0x32 && this.pointer <= 0x37) this.latch();
  }

  protected override next(reg: number): number {
    return (reg + 1) & 0x3f;
  }

  protected readRegister(reg: number): number {
    if (reg >= 0x32 && reg <= 0x37) return this.sample[reg - 0x32];
    // A new sample is always there while measuring: DATA_READY.
    if (reg === 0x30) return this.regs[0x30] | (this.measuring ? 0x80 : 0);
    return this.regs[reg];
  }

  protected writeRegister(reg: number, value: number): void {
    // DEVID, the tap/activity source, INT_SOURCE, the data and FIFO_STATUS are read-only.
    if (reg === 0x00 || (reg >= 0x01 && reg <= 0x1c) || reg === 0x2b || reg === 0x30 || (reg >= 0x32 && reg <= 0x37) || reg === 0x39) return;
    this.regs[reg] = value;
  }
}

// ── INA219 ──────────────────────────────────────────────────────────────────

/** The shunt of the usual INA219 breakout (Adafruit, CJMCU, GY-219). */
const INA219_SHUNT_OHMS = 0.1;

/**
 * INA219 current monitor with the module's 0.1 Ω shunt. Registers are 16-bit,
 * MSB first. The shunt register is the shunt voltage in 10 µV (clipped at the
 * PGA range of CONFIG), the bus register the bus voltage in 4 mV at bit 3
 * with CNVR, clipped at the 16 / 32 V range; the current register is
 * shunt × CALIBRATION / 4096 and the power register current × bus / 5000, as
 * the chip computes them. Adafruit_INA219 writes CALIBRATION before every
 * current and power read and divides by the LSB it chose, so the sketch reads
 * the panel's current and bus voltage, and their product as power. Power-down
 * and ADC-off modes hold the last conversion; RST in CONFIG resets.
 */
export class Ina219Model implements ValueI2cDevice {
  values: Record<string, number> = {};
  address: number;
  private config = 0x399f;
  private calibration = 0;
  private pointer = 0;
  /** Bytes after the pointer in this write phase. */
  private written: number[] = [];
  private awaitingPointer = true;
  /** Byte of the register word the next read returns: 0 = MSB. */
  private half = 0;
  private held = { shunt: 0, bus: 0 };

  constructor(address: number) {
    this.address = address;
  }

  /** Shunt and bus registers of the conversion the chip has now. */
  private conversion(): { shunt: number; bus: number } {
    const mode = this.config & 0x07;
    if (mode === 0 || mode === 4) return this.held;
    const pgaMv = 40 << ((this.config >> 11) & 0x03);
    const shuntMv = num(this.values.current) * INA219_SHUNT_OHMS;
    const shunt = clamp(Math.round(shuntMv * 100), -pgaMv * 100, pgaMv * 100);
    const fsr = this.config & 0x2000 ? 32 : 16;
    const bus = clamp(Math.round(clamp(num(this.values.busVoltage), 0, fsr) / 0.004), 0, 0x1fff);
    // Triggered modes (1-3) convert once per CONFIG write; the panel moves the
    // world, so the next trigger reads it: keep it simple and convert now.
    this.held = {
      shunt: mode & 0x01 ? shunt : this.held.shunt,
      bus: mode & 0x02 ? bus : this.held.bus,
    };
    return this.held;
  }

  private register(reg: number): number {
    const { shunt, bus } = this.conversion();
    const current = Math.trunc((shunt * this.calibration) / 4096);
    const power = Math.trunc((Math.abs(current) * bus) / 5000);
    const overflow = current > 0x7fff || current < -0x8000 || power > 0xffff;
    switch (reg) {
      case 0x00:
        return this.config;
      case 0x01:
        return shunt & 0xffff;
      case 0x02:
        return (bus << 3) | (this.calibration ? 0x02 : 0) | (overflow ? 0x01 : 0);
      case 0x03:
        return overflow ? 0 : power;
      case 0x04:
        return overflow ? 0 : current & 0xffff;
      case 0x05:
        return this.calibration;
      default:
        return 0;
    }
  }

  writeByte(value: number): boolean {
    if (this.awaitingPointer) {
      this.pointer = value & 0x07;
      this.awaitingPointer = false;
      this.written = [];
      this.half = 0;
      return true;
    }
    this.written.push(value & 0xff);
    if (this.written.length === 2) {
      const word = (this.written[0] << 8) | this.written[1];
      this.written = [];
      if (this.pointer === 0x00) {
        if (word & 0x8000) {
          this.config = 0x399f;
          this.calibration = 0;
        } else this.config = word;
      } else if (this.pointer === 0x05) this.calibration = word & 0xfffe;
    }
    return true;
  }

  readByte(): number {
    const word = this.register(this.pointer);
    const v = this.half === 0 ? word >> 8 : word & 0xff;
    this.half ^= 1;
    return v & 0xff;
  }

  start(read: boolean): void {
    this.half = 0;
    if (!read) this.awaitingPointer = true;
  }

  stop(): void {
    this.awaitingPointer = true;
    this.half = 0;
  }
}

// ── MLX90614 ────────────────────────────────────────────────────────────────

/** SMBus PEC: CRC-8, polynomial 0x07, init 0, over every byte on the wire. */
export function smbusPec(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

const MLX_EEPROM_DEFAULTS: Record<number, number> = {
  0x00: 0x9993, // To max
  0x01: 0x62e3, // To min
  0x02: 0x0201, // PWM control
  0x03: 0xf71c, // Ta range
  0x04: 0xffff, // emissivity 1.0
  0x05: 0x9fb4, // config register 1
  0x0e: 0xbe5a, // SMBus address 0x5A
  0x1c: 0x1234, // ID number
  0x1d: 0x5678,
  0x1e: 0x9abc,
  0x1f: 0xdef0,
};

/**
 * MLX90614 IR thermometer, SMBus "read word": a command (0x00-0x1F RAM,
 * 0x20-0x3F EEPROM), a repeated START, then LSB, MSB and the PEC over the
 * address, command, address+R and the two data bytes. TA (0x06) and TOBJ1
 * (0x07, also TOBJ2) are kelvin in 0.02 K, so a reading moves in 0.02 °C
 * steps. Adafruit_MLX90614 2.1 does not check the PEC on a read (it is right
 * anyway); a temperature reading 0 it calls NAN. A word written to EEPROM
 * (writeEmissivity) is taken only with a correct PEC, as the chip does.
 */
export class Mlx90614Model implements ValueI2cDevice {
  values: Record<string, number> = {};
  address: number;
  private eeprom = new Uint16Array(32);
  private command: number[] = [];
  private frame: number[] = [];
  private index = 0;
  private closed = true;
  private reading = false;

  constructor(address: number) {
    this.address = address;
    for (const [k, v] of Object.entries(MLX_EEPROM_DEFAULTS)) this.eeprom[Number(k)] = v;
    this.eeprom[0x0e] = (this.eeprom[0x0e] & 0xff00) | (address & 0x7f);
  }

  private kelvin(celsius: number): number {
    return clamp(Math.round((celsius + 273.15) / 0.02), 0, 0x7fff);
  }

  private word(cmd: number): number {
    if (cmd >= 0x20 && cmd <= 0x3f) return this.eeprom[cmd - 0x20];
    const ambient = num(this.values.ambientTemp, 25);
    const object = num(this.values.objectTemp, 25);
    switch (cmd) {
      case 0x04: // raw IR channel 1: grows with the object-to-ambient difference
      case 0x05:
        return Math.round(clamp((object - ambient) * 40, -0x7fff, 0x7fff)) & 0xffff;
      case 0x06:
        return this.kelvin(ambient);
      case 0x07:
      case 0x08:
        return this.kelvin(object);
      default:
        return 0;
    }
  }

  writeByte(value: number): boolean {
    this.reading = false;
    if (this.closed) this.command = [];
    this.closed = false;
    this.command.push(value & 0xff);
    return true;
  }

  start(read: boolean): void {
    this.closed = true;
    this.reading = read;
    if (!read) return;
    const cmd = this.command[0] ?? 0;
    const w = this.word(cmd);
    const lo = w & 0xff;
    const hi = w >> 8;
    const a = (this.address & 0x7f) << 1;
    this.frame = [lo, hi, smbusPec([a, cmd, a | 1, lo, hi])];
    this.index = 0;
  }

  readByte(): number {
    if (!this.reading) this.start(true);
    return this.index < this.frame.length ? this.frame[this.index++] : 0xff;
  }

  stop(): void {
    // A write word: command, LSB, MSB, PEC over address+W and those three.
    const c = this.command;
    if (!this.closed && c.length === 4 && c[0] >= 0x20 && c[0] <= 0x3f) {
      const a = (this.address & 0x7f) << 1;
      if (smbusPec([a, c[0], c[1], c[2]]) === c[3]) this.eeprom[c[0] - 0x20] = c[1] | (c[2] << 8);
    }
    this.closed = true;
    this.reading = false;
    this.index = 0;
  }
}

// ── QMC5883L ────────────────────────────────────────────────────────────────

/** Horizontal and vertical earth field the module sees, in gauss. */
const EARTH_HORIZONTAL_G = 0.3;
const EARTH_VERTICAL_G = -0.4;

/**
 * QMC5883L magnetometer (GY-271). QMC5883LCompass::init() writes SET/RESET
 * period 0x0B and CONTROL1 = continuous, 200 Hz, 8 G, OSR 512, then read()
 * takes six bytes from 0x00 (X, Y, Z, little-endian) and getAzimuth() is
 * (int)(atan2(Y, X) in degrees) % 360, truncated toward zero, with no
 * calibration or smoothing unless the sketch sets them. The model turns the
 * horizontal field (0.3 G, 3000 LSB/G at 8 G, 12000 at 2 G) so that atan2
 * falls in the middle of the panel's degree: the sketch prints the heading
 * itself, and above 180 the library's negative form (270 prints -90).
 * Standby holds the last sample; SOFT_RST in CONTROL2 resets the registers;
 * the chip id register 0x0D reads 0xFF.
 */
export class Qmc5883lModel extends PointerDevice {
  private regs = new Uint8Array(16);
  private sample = [0, 0, 0, 0, 0, 0];

  constructor(address: number) {
    super(address);
    this.reset();
  }

  private reset(): void {
    this.regs.fill(0);
    this.regs[0x0d] = 0xff;
    this.sample = [0, 0, 0, 0, 0, 0];
  }

  private get continuous(): boolean {
    return (this.regs[0x09] & 0x03) === 0x01;
  }

  /** X, Y, Z counts for a heading in degrees. */
  static fieldFor(heading: number, lsbPerGauss: number): [number, number, number] {
    const h = ((Math.round(heading) % 360) + 360) % 360;
    // What the library prints for this field: atan2 is in (-180, 180].
    const printed = h <= 180 ? h : h - 360;
    const horizontal = EARTH_HORIZONTAL_G * lsbPerGauss;
    const z = Math.round(EARTH_VERTICAL_G * lsbPerGauss);
    if (printed === 180) return [-Math.round(horizontal), 0, z];
    const deg = printed >= 0 ? printed + 0.5 : printed - 0.5;
    const rad = (deg * Math.PI) / 180;
    return [Math.round(horizontal * Math.cos(rad)), Math.round(horizontal * Math.sin(rad)), z];
  }

  private latch(): void {
    if (!this.continuous) return;
    const lsbPerGauss = this.regs[0x09] & 0x10 ? 3000 : 12000;
    const counts = Qmc5883lModel.fieldFor(num(this.values.heading), lsbPerGauss);
    this.sample = counts.flatMap((c) => [c & 0xff, (c >> 8) & 0xff]);
  }

  protected override beginRead(): void {
    if (this.pointer <= 0x05) this.latch();
  }

  protected override next(reg: number): number {
    // ROL_PNT or not, a burst from 0x00 reads the six data bytes and status.
    return (reg + 1) & 0x0f;
  }

  protected readRegister(reg: number): number {
    if (reg <= 0x05) return this.sample[reg];
    if (reg === 0x06) return this.continuous ? 0x01 : 0x00; // DRDY
    if (reg === 0x07) return 2500 & 0xff; // temperature: 100 LSB/°C, offset uncalibrated
    if (reg === 0x08) return 2500 >> 8;
    return this.regs[reg];
  }

  protected writeRegister(reg: number, value: number): void {
    if (reg === 0x0a && value & 0x80) {
      this.reset();
      return;
    }
    if (reg >= 0x09 && reg <= 0x0b) this.regs[reg] = value;
  }
}

// ── CCS811 ──────────────────────────────────────────────────────────────────

const CCS811_PERIOD_MS = [0, 1000, 10000, 60000, 250];
const CCS811_RESET_SEQUENCE = [0x11, 0xe5, 0x72, 0x8a];

/**
 * CCS811 air-quality sensor. Adafruit_CCS811::begin() soft-resets (0xFF with
 * 11 E5 72 8A), wants HW_ID 0x81, writes APP_START (0xF4, no data), then wants
 * STATUS with no ERROR and FW_MODE set, and writes MEAS_MODE drive mode 1.
 * available() reads STATUS.DATA_READY, readData() reads the eight bytes of
 * ALG_RESULT_DATA (eCO2, TVOC big-endian, STATUS, ERROR_ID, RAW_DATA), which
 * clears DATA_READY. A sample is ready one drive-mode period (1 s, 10 s,
 * 60 s, 250 ms) after the mode was set and every period after, on the guest's
 * clock; idle gives none. Without a clock a sample is always ready. Boot mode
 * answers only STATUS, the ids, ERROR_ID and the bootloader; a mailbox it
 * does not have, or a drive mode above 4, sets ERROR with the ERROR_ID bit,
 * which a read of ERROR_ID clears.
 */
export class Ccs811Model implements ValueI2cDevice {
  values: Record<string, number> = {};
  address: number;
  private appMode = false;
  private measMode = 0;
  private errorId = 0;
  private baseline = [0x84, 0x7b];
  private clock: GuestClock | null = null;
  /** Guest cycle the drive mode was set at. */
  private modeSince = 0;
  /** Samples taken up to the last ALG_RESULT_DATA read. */
  private samplesRead = 0;
  /** Without a clock: no sample read since the last one was taken. */
  private unread = true;

  private mailbox = 0;
  private awaitingMailbox = true;
  private written: number[] = [];
  private frame: number[] = [];
  private index = 0;
  private reading = false;

  constructor(address: number) {
    this.address = address;
  }

  setClock(clock: GuestClock | null): void {
    this.clock = clock;
    this.modeSince = this.now();
    this.samplesRead = 0;
  }

  private now(): number {
    return this.clock ? this.clock.now() : 0;
  }

  private get timed(): boolean {
    return !!this.clock && this.clock.clockHz() > 0;
  }

  private get driveMode(): number {
    return (this.measMode >> 4) & 0x07;
  }

  private samplesTaken(): number {
    const period = CCS811_PERIOD_MS[this.driveMode] ?? 0;
    if (!this.appMode || period === 0 || !this.timed) return 0;
    const cycles = (period / 1000) * this.clock!.clockHz();
    return Math.floor((this.now() - this.modeSince) / cycles);
  }

  private get dataReady(): boolean {
    if (!this.appMode || this.driveMode === 0) return false;
    return this.timed ? this.samplesTaken() > this.samplesRead : this.unread;
  }

  private status(): number {
    return (this.appMode ? 0x80 : 0) | 0x10 | (this.dataReady ? 0x08 : 0) | (this.errorId ? 0x01 : 0);
  }

  private reset(): void {
    this.appMode = false;
    this.measMode = 0;
    this.errorId = 0;
    this.samplesRead = 0;
    this.unread = true;
  }

  private setMeasMode(value: number): void {
    if (((value >> 4) & 0x07) > 4) {
      this.errorId |= 0x04; // MEASMODE_INVALID
      return;
    }
    this.measMode = value & 0x7c;
    this.modeSince = this.now();
    this.samplesRead = 0;
    this.unread = true;
  }

  /** The bytes a read of `mailbox` returns, or null when this mode has no such mailbox. */
  private frameFor(mailbox: number): number[] | null {
    switch (mailbox) {
      case 0x00:
        return [this.status()];
      case 0x20:
        return [0x81];
      case 0x21:
        return [0x12];
      case 0x23:
        return [0x10, 0x00];
      case 0x24:
        return [0x20, 0x00];
      case 0xe0: {
        const e = this.errorId;
        this.errorId = 0;
        return [e];
      }
    }
    if (!this.appMode) return null;
    const eco2 = Math.round(clamp(num(this.values.eco2, 400), 400, 8192));
    const tvoc = Math.round(clamp(num(this.values.tvoc), 0, 1187));
    // RAW_DATA: 16 µA through the sensor, its voltage falling as VOCs rise.
    const adc = Math.round(clamp(600 - tvoc * 0.3, 0, 1023));
    const raw = [(16 << 2) | (adc >> 8), adc & 0xff];
    switch (mailbox) {
      case 0x01:
        return [this.measMode];
      case 0x02: {
        const out = [eco2 >> 8, eco2 & 0xff, tvoc >> 8, tvoc & 0xff, this.status(), this.errorId, ...raw];
        this.samplesRead = this.samplesTaken();
        this.unread = false;
        return out;
      }
      case 0x03:
        return raw;
      case 0x06:
        return [0x04, 0x00, 0x04, 0x00]; // NTC: Vref = Vntc, 25 °C on the reference resistor
      case 0x11:
        return [...this.baseline];
      default:
        return null;
    }
  }

  private commitWrite(): void {
    const data = this.written;
    const m = this.mailbox;
    if (m === 0xff) {
      if (data.length === 4 && data.every((b, i) => b === CCS811_RESET_SEQUENCE[i])) this.reset();
      return;
    }
    if (!this.appMode) {
      if (m === 0xf4 && data.length === 0) {
        this.appMode = true;
        this.modeSince = this.now();
        this.samplesRead = 0;
      } else if (m < 0xf1 || m > 0xf4) this.errorId |= 0x01; // WRITE_REG_INVALID
      return;
    }
    if (m === 0x01 && data.length >= 1) this.setMeasMode(data[0]);
    else if (m === 0x11 && data.length >= 2) this.baseline = data.slice(0, 2);
    else if (m === 0x05 || m === 0x10) return; // ENV_DATA, THRESHOLDS: taken, not used
    else if (m !== 0x01 && m !== 0x11) this.errorId |= 0x01;
  }

  writeByte(value: number): boolean {
    this.reading = false;
    if (this.awaitingMailbox) {
      this.mailbox = value & 0xff;
      this.awaitingMailbox = false;
      this.written = [];
    } else this.written.push(value & 0xff);
    return true;
  }

  start(read: boolean): void {
    this.reading = read;
    if (!read) {
      this.awaitingMailbox = true;
      return;
    }
    // The write phase before a repeated START only chose the mailbox to read.
    this.awaitingMailbox = true;
    const frame = this.frameFor(this.mailbox);
    if (frame === null) {
      this.errorId |= 0x02; // READ_REG_INVALID
      this.frame = [];
    } else this.frame = frame;
    this.index = 0;
  }

  readByte(): number {
    if (!this.reading) this.start(true);
    return this.index < this.frame.length ? this.frame[this.index++] : 0x00;
  }

  stop(): void {
    if (!this.awaitingMailbox) this.commitWrite();
    this.awaitingMailbox = true;
    this.reading = false;
    this.written = [];
  }
}

registerModuleModel('adxl345', i2cModel(['accelX', 'accelY', 'accelZ'], (a) => new Adxl345Model(a), 'adxl345'));
registerModuleModel('ina219', i2cModel(['busVoltage', 'current'], (a) => new Ina219Model(a), 'ina219'));
registerModuleModel('mlx90614', i2cModel(['objectTemp', 'ambientTemp'], (a) => new Mlx90614Model(a), 'mlx90614'));
registerModuleModel('qmc5883l', i2cModel(['heading'], (a) => new Qmc5883lModel(a), 'qmc5883l'));
registerModuleModel('ccs811', i2cModel(['eco2', 'tvoc'], (a) => new Ccs811Model(a), 'ccs811'));
