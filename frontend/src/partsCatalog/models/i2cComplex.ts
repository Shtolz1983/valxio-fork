/**
 * I2C chips whose libraries do more than read a register: they poll for a
 * measurement to finish (VL53L0X) or drain a sample FIFO the chip fills at
 * its own rate (MAX30102). Both keep time on the guest's clock (setClock), so
 * a sketch that waits 100 ms finds 100 ms of chip activity however fast the
 * emulator ran it. On a board that keeps no time (clockHz() 0) a measurement
 * is ready at the first poll and the FIFO gains one sample per poll.
 *
 * On an ESP32 the worker answers the guest with the Python twins in
 * backend/app/services/catalog_i2c_complex.py: change both together.
 */
import type { GuestClock } from '../../simulation/buses/types';
import { i2cModel, registerModuleModel, type ValueI2cDevice } from './registry';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The guest's time in ns, or null when the board keeps none. */
function guestNs(clock: GuestClock | null): number | null {
  if (!clock) return null;
  const hz = clock.clockHz();
  if (!(hz > 0)) return null;
  return (clock.now() * 1e9) / hz;
}

/**
 * A register-pointer chip: the first byte of a write phase is the register,
 * every byte after it goes to the next register, and a read continues from
 * the pointer (except where `pointerStays` holds it, a FIFO port).
 */
abstract class PointerDevice implements ValueI2cDevice {
  values: Record<string, number> = {};
  protected clock: GuestClock | null = null;
  protected pointer = 0;
  /** The next written byte is a register pointer. */
  private expectPointer = true;

  address: number;

  constructor(address: number) {
    this.address = address;
  }

  protected abstract readReg(reg: number): number;
  protected abstract writeReg(reg: number, value: number): void;
  /** True for a register whose reads do not move the pointer. */
  protected holdsPointer(_reg: number): boolean {
    return false;
  }

  setClock(clock: GuestClock | null): void {
    this.clock = clock;
  }

  start(read: boolean): void {
    if (!read) this.expectPointer = true;
  }

  stop(): void {
    this.expectPointer = true;
  }

  writeByte(value: number): boolean {
    if (this.expectPointer) {
      this.pointer = value & 0xff;
      this.expectPointer = false;
    } else {
      this.writeReg(this.pointer, value & 0xff);
      this.pointer = (this.pointer + 1) & 0xff;
    }
    return true;
  }

  readByte(): number {
    this.expectPointer = true;
    const reg = this.pointer;
    const v = this.readReg(reg) & 0xff;
    if (!this.holdsPointer(reg)) this.pointer = (this.pointer + 1) & 0xff;
    return v;
  }

  protected nowNs(): number | null {
    return guestNs(this.clock);
  }
}

// ── VL53L0X ──────────────────────────────────────────────────────────────────

const VL_SYSRANGE_START = 0x00;
const VL_SEQUENCE_CONFIG = 0x01;
const VL_INTERMEASUREMENT = 0x04;
const VL_INTERRUPT_CLEAR = 0x0b;
const VL_INTERRUPT_STATUS = 0x13;
const VL_RANGE_STATUS = 0x14;
const VL_PAGE = 0xff;
/** Out of range: what Pololu's library returns when no target is seen. */
export const VL53L0X_OUT_OF_RANGE = 8190;
/** Farthest distance the model still reports, in mm; above it the reading is out of range. */
export const VL53L0X_MAX_MM = 2000;

/**
 * VL53L0X time-of-flight ranger, as Pololu's VL53L0X library drives it.
 *
 * - init(): model ID 0xC0 reads 0xEE; every tuning register written reads
 *   back; register 0xFF selects a page (0x91 on page 1 is the stop variable,
 *   0x83 / 0x92 on pages 6 and 7 the NVM SPAD read: 0x83 reads non-zero once
 *   the read is "done", 0x92 gives 8 aperture SPADs); the timing budget the
 *   library reads back is computed from the same registers it computes it
 *   from (about 33 ms after init).
 * - A measurement starts on a SYSRANGE_START (0x00) write: single shot (bit 0,
 *   the reference calibrations too), back-to-back (0x02) or timed (0x04, the
 *   period from 0x04..0x07 over OSC_CALIBRATE_VAL). It completes one timing
 *   budget later on the guest clock (a calibration 1 ms later) and sets
 *   RESULT_INTERRUPT_STATUS (0x13) to 0x04 until SYSTEM_INTERRUPT_CLEAR
 *   (0x0B) is written; SYSRANGE_START reads back with bit 0 already cleared.
 * - RESULT_RANGE_STATUS + 10 (0x1E, big-endian) is the panel's `distance`
 *   (clamped to 30 mm), and 8190 with a phase-fail status above 2000 mm.
 *
 * Not modelled: XSHUT, the address change (0x8A: the part keeps its address
 * on the bus), the GPIO interrupt pin, signal / ambient rates.
 */
export class Vl53l0xModel extends PointerDevice {
  /** Register pages: 0 is the user map, others the ones 0xFF selects. */
  private pages = new Map<number, Uint8Array>();
  private page = 0;
  /** SYSRANGE_START mode of the measurement in progress: 0 none, 1 single, 2 back-to-back, 4 timed. */
  private mode = 0;
  private startNs = 0;
  private periodNs = 0;
  /** Completions counted when the interrupt was last cleared. */
  private cleared = 0;
  /** No clock: the measurements that completed (one per status poll). */
  private polled = 0;

  constructor(address: number) {
    super(address);
    this.powerOn();
  }

  private regs(page: number): Uint8Array {
    let r = this.pages.get(page);
    if (!r) {
      r = new Uint8Array(256);
      this.pages.set(page, r);
    }
    return r;
  }

  private powerOn(): void {
    this.pages.clear();
    const p0 = this.regs(0);
    p0[0xc0] = 0xee; // IDENTIFICATION_MODEL_ID
    p0[0xc1] = 0xaa;
    p0[0xc2] = 0x10; // revision
    p0[0x50] = 0x06; // pre-range VCSEL period 14 PCLKs
    p0[0x70] = 0x04; // final-range VCSEL period 10 PCLKs
    p0[0x46] = 0x25;
    p0[0x51] = 0x00;
    p0[0x52] = 0x96;
    p0[0x71] = 0x01;
    p0[0x72] = 0xfe;
    p0[0x84] = 0x11; // GPIO_HV_MUX_ACTIVE_HIGH
    p0[0x89] = 0x00;
    p0[0xf8] = 0x00; // OSC_CALIBRATE_VAL: the library then takes the period as ms
    p0[0xf9] = 0x00;
    p0.fill(0xff, 0xb0, 0xb6); // reference SPAD map: every SPAD present
    this.regs(1)[0x91] = 0x3c; // stop variable
    this.regs(7)[0x92] = 0x88; // SPAD info: aperture, 8 SPADs
  }

  protected writeReg(reg: number, value: number): void {
    if (reg === VL_PAGE) {
      this.page = value;
      return;
    }
    this.regs(this.page)[reg] = value;
    if (this.page !== 0) return;
    if (reg === VL_SYSRANGE_START) this.startRanging(value);
    else if (reg === VL_INTERRUPT_CLEAR && value & 0x01) this.cleared = this.completions();
  }

  protected readReg(reg: number): number {
    if (reg === VL_PAGE) return this.page;
    const r = this.regs(this.page);
    if (this.page === 7 && reg === 0x83) return r[0x83] === 0 ? 0x10 : r[0x83];
    if (this.page !== 0) return r[reg];
    switch (reg) {
      case VL_SYSRANGE_START:
        return r[reg] & ~0x01;
      case VL_INTERRUPT_STATUS:
        return this.ready() ? 0x04 : 0x00;
      case VL_RANGE_STATUS:
        return this.outOfRange() ? 0x20 : 0x58;
      case VL_RANGE_STATUS + 10:
        return this.rangeMm() >> 8;
      case VL_RANGE_STATUS + 11:
        return this.rangeMm() & 0xff;
      default:
        return r[reg];
    }
  }

  private outOfRange(): boolean {
    return (this.values.distance ?? 0) > VL53L0X_MAX_MM;
  }

  private rangeMm(): number {
    if (this.outOfRange()) return VL53L0X_OUT_OF_RANGE;
    return Math.round(clamp(this.values.distance ?? 0, 30, VL53L0X_MAX_MM));
  }

  private startRanging(value: number): void {
    const r = this.regs(0);
    const now = this.nowNs() ?? 0;
    if (value & 0x01) {
      // A reference calibration runs the VHV or phase step only: short.
      const calibration = (r[VL_SEQUENCE_CONFIG] & 0x80) === 0;
      this.mode = 1;
      this.periodNs = calibration ? 1e6 : this.budgetUs() * 1e3;
    } else if (value & 0x02) {
      this.mode = 2;
      this.periodNs = this.budgetUs() * 1e3;
    } else if (value & 0x04) {
      const at = VL_INTERMEASUREMENT;
      const raw = (r[at] << 24) | (r[at + 1] << 16) | (r[at + 2] << 8) | r[at + 3];
      const osc = (r[0xf8] << 8) | r[0xf9];
      const periodMs = (raw >>> 0) / (osc || 1);
      this.mode = 4;
      this.periodNs = Math.max(this.budgetUs() * 1e3, periodMs * 1e6);
    } else {
      this.mode = 0; // stop
    }
    this.startNs = now;
    this.cleared = 0;
    this.polled = 0;
  }

  /** Measurements completed since the last SYSRANGE_START. */
  private completions(): number {
    if (this.mode === 0) return this.cleared;
    const now = this.nowNs();
    if (now === null) return this.polled;
    const n = Math.floor((now - this.startNs) / Math.max(1, this.periodNs));
    return this.mode === 1 ? Math.min(1, n) : n;
  }

  private ready(): boolean {
    if (this.mode !== 0 && this.nowNs() === null && this.polled === this.cleared) {
      // No clock: the measurement the poll waits for is done.
      if (this.mode !== 1 || this.polled === 0) this.polled++;
    }
    return this.completions() > this.cleared;
  }

  /** The timing budget in µs, from the registers getMeasurementTimingBudget() reads. */
  budgetUs(): number {
    const r = this.regs(0);
    const seq = r[VL_SEQUENCE_CONFIG];
    const macroNs = (pclks: number) => Math.floor((2304 * pclks * 1655 + 500) / 1000);
    const mclksToUs = (mclks: number, pclks: number) => Math.floor((mclks * macroNs(pclks) + 500) / 1000);
    const decode = (v: number) => ((v & 0xff) << ((v >> 8) & 0xff)) + 1;
    const preVcsel = (r[0x50] + 1) << 1;
    const finalVcsel = (r[0x70] + 1) << 1;
    const msrcUs = mclksToUs(r[0x46] + 1, preVcsel);
    const preMclks = decode((r[0x51] << 8) | r[0x52]) & 0xffff;
    const preUs = mclksToUs(preMclks, preVcsel);
    let finalMclks = decode((r[0x71] << 8) | r[0x72]) & 0xffff;
    if (seq & 0x40) finalMclks -= preMclks;
    const finalUs = mclksToUs(finalMclks & 0xffff, finalVcsel);
    let budget = 1910 + 960;
    if (seq & 0x10) budget += msrcUs + 590;
    if (seq & 0x08) budget += 2 * (msrcUs + 690);
    else if (seq & 0x04) budget += msrcUs + 660;
    if (seq & 0x40) budget += preUs + 660;
    if (seq & 0x80) budget += finalUs + 550;
    return budget;
  }
}

// ── MAX30102 ─────────────────────────────────────────────────────────────────

const MX_INTSTAT1 = 0x00;
const MX_INTSTAT2 = 0x01;
const MX_FIFO_WR = 0x04;
const MX_FIFO_OVF = 0x05;
const MX_FIFO_RD = 0x06;
const MX_FIFO_DATA = 0x07;
const MX_FIFO_CONFIG = 0x08;
const MX_MODE = 0x09;
const MX_SPO2 = 0x0a;
const MX_LED1 = 0x0c;
const MX_LED2 = 0x0d;
const MX_SLOTS1 = 0x11;
const MX_SLOTS2 = 0x12;
const MX_TEMP_INT = 0x1f;
const MX_TEMP_FRAC = 0x20;
const MX_TEMP_CONFIG = 0x21;
const FIFO_DEPTH = 32;
const SAMPLE_RATES = [50, 100, 200, 400, 800, 1000, 1600, 3200];

/** Counts at LED amplitude 0x1F, ADC range 4096 nA: a finger on the sensor, and the bare window. */
const IR_FINGER = 100_000;
const RED_FINGER = 88_000;
const IR_AMBIENT = 1_200;
const RED_AMBIENT = 900;
/** Peak-to-peak of the pulse, in counts of the IR channel (the red one scales with its DC). */
const PULSE_PP = 300;
const DIE_TEMP_C = 30;

/**
 * One period of a fingertip PPG, phase in [0, 1): the absorbed light rises
 * fast at systole and falls slowly, with a small dicrotic bump. Zero mean,
 * peak-to-peak about 1.
 */
export function ppgShape(phase: number): number {
  const w = 2 * Math.PI * phase;
  return 0.5 * Math.sin(w) + 0.18 * Math.sin(2 * w + 0.6) + 0.06 * Math.sin(3 * w + 1.2);
}

/**
 * MAX30102 pulse oximeter, as SparkFun's MAX3010x library drives it.
 *
 * - begin(): part ID 0xFF reads 0x15, revision 0xFE 0x03. setup() soft-resets
 *   through MODE_CONFIG bit 6 (it reads back cleared at once: the reset is
 *   done), then read-modify-writes the FIFO, mode, SpO2 and slot registers;
 *   every register reads back what was written.
 * - The chip fills its 32-sample FIFO at the SpO2 sample rate over the FIFO
 *   averaging, timed on the guest clock, while MODE_CONFIG names a mode and
 *   bit 7 (shutdown) is clear. Write / read pointers (0x04 / 0x06) and the
 *   overflow counter (0x05) move as on the chip; with rollover off a full
 *   FIFO drops new samples, with it on it drops the oldest. FIFO_DATA (0x07)
 *   hands out 3 bytes per active channel (1 in HR mode, 2 in SpO2 mode, the
 *   enabled slots in multi-LED mode), MSB first, without moving the pointer.
 * - The samples: with `finger` 1 the IR channel sits at 100000 counts (well
 *   above the examples' 50000 "no finger" threshold) with a PPG pulse of 300
 *   counts at `bpm`, which heartRate.h checkForBeat() sees as one beat per
 *   period; the red channel the same at 88000. With `finger` 0 they read
 *   ambient (about 1000). Each scales with its LED amplitude (0x1F = 1) and
 *   the ADC range; the green slot (no green LED on a MAX30102) reads ambient.
 * - Die temperature (0x21 = 1) is ready at once: 30 °C, INT_STATUS2 bit 1.
 *
 * Not modelled: the INT pin, proximity mode, SpO2 difference between red and
 * IR (the red pulse is proportional to the IR one).
 */
export class Max30102Model extends PointerDevice {
  private regs = new Uint8Array(256);
  /** The FIFO: one entry per sample, the values of its active channels. */
  private fifo: number[][] = [];
  private wr = 0;
  private rd = 0;
  private overflow = 0;
  /** Guest ns of the next sample, or null when not sampling. */
  private nextNs: number | null = null;
  /** No clock: the time of the samples made per poll. */
  private fakeNs = 0;
  /** Heartbeat phase at `phaseNs`, so a bpm change does not jump the wave. */
  private phase = 0;
  private phaseNs = 0;
  /** The sample being read out of FIFO_DATA and its next byte. */
  private outBytes: number[] = [];
  private newSample = false;

  constructor(address: number) {
    super(address);
    this.reset();
  }

  private reset(): void {
    this.regs.fill(0);
    this.regs[0xfe] = 0x03;
    this.regs[0xff] = 0x15;
    this.fifo = [];
    this.wr = this.rd = this.overflow = 0;
    this.outBytes = [];
    this.nextNs = null;
    this.regs[MX_INTSTAT1] = 0x01; // PWR_RDY
  }

  protected holdsPointer(reg: number): boolean {
    return reg === MX_FIFO_DATA;
  }

  start(read: boolean): void {
    super.start(read);
    if (!read) this.outBytes = [];
  }

  /** Channels per sample the mode and slots select. */
  private channels(): number[] {
    const mode = this.regs[MX_MODE] & 0x07;
    if (mode === 0x02) return [1];
    if (mode === 0x03) return [1, 2];
    if (mode === 0x07) {
      const slots = [
        this.regs[MX_SLOTS1] & 0x07,
        (this.regs[MX_SLOTS1] >> 4) & 0x07,
        this.regs[MX_SLOTS2] & 0x07,
        (this.regs[MX_SLOTS2] >> 4) & 0x07,
      ];
      const end = slots.indexOf(0);
      return end < 0 ? slots : slots.slice(0, end);
    }
    return [];
  }

  private sampling(): boolean {
    return (this.regs[MX_MODE] & 0x80) === 0 && this.channels().length > 0;
  }

  private samplePeriodNs(): number {
    const rate = SAMPLE_RATES[(this.regs[MX_SPO2] >> 2) & 0x07];
    const avg = 1 << Math.min(5, (this.regs[MX_FIFO_CONFIG] >> 5) & 0x07);
    return (1e9 * avg) / rate;
  }

  /** Bring the FIFO up to now: every sample the chip took since the last look. */
  private sync(): void {
    if (!this.sampling()) {
      this.nextNs = null;
      return;
    }
    const now = this.nowNs();
    if (now === null) return;
    const period = this.samplePeriodNs();
    if (this.nextNs === null) {
      this.nextNs = now + period;
      return;
    }
    if (now < this.nextNs) return;
    let due = Math.floor((now - this.nextNs) / period) + 1;
    // More than a FIFO's worth only turns the oldest over.
    if (due > FIFO_DEPTH * 2) {
      const skip = due - FIFO_DEPTH * 2;
      this.nextNs += skip * period;
      this.countDropped(skip);
      due -= skip;
    }
    for (let i = 0; i < due; i++) {
      this.push(this.nextNs);
      this.nextNs += period;
    }
  }

  private countDropped(n: number): void {
    this.overflow = Math.min(0x1f, this.overflow + n);
  }

  private push(atNs: number): void {
    const sample = this.channels().map((ch) => this.channelValue(ch, atNs));
    this.newSample = true;
    if (this.fifo.length >= FIFO_DEPTH) {
      this.countDropped(1);
      if ((this.regs[MX_FIFO_CONFIG] & 0x10) === 0) return; // rollover off: dropped
      this.fifo.shift();
      this.rd = (this.rd + 1) % FIFO_DEPTH;
    }
    this.fifo.push(sample);
    this.wr = (this.wr + 1) % FIFO_DEPTH;
  }

  private beatPhase(atNs: number): number {
    const bpm = clamp(this.values.bpm ?? 72, 20, 250);
    this.phase = (this.phase + ((atNs - this.phaseNs) / 1e9) * (bpm / 60)) % 1;
    if (this.phase < 0) this.phase += 1;
    this.phaseNs = atNs;
    return this.phase;
  }

  /** Counts of one channel (1 red, 2 IR, 3 green) at a guest instant, 18-bit, left-justified. */
  private channelValue(ch: number, atNs: number): number {
    const finger = (this.values.finger ?? 0) >= 0.5;
    const phase = this.beatPhase(atNs);
    const amp = ch === 1 ? this.regs[MX_LED1] : ch === 2 ? this.regs[MX_LED2] : 0;
    const gain = amp / 0x1f;
    const range = 2048 << ((this.regs[MX_SPO2] >> 5) & 0x03);
    const scale = 4096 / range;
    let counts: number;
    if (ch === 1 || ch === 2) {
      const ambient = ch === 2 ? IR_AMBIENT : RED_AMBIENT;
      const dc = ch === 2 ? IR_FINGER : RED_FINGER;
      counts = finger
        ? gain * (dc + PULSE_PP * (dc / IR_FINGER) * ppgShape(phase))
        : gain * ambient;
    } else {
      counts = finger ? 400 : 200;
    }
    const bits = 15 + (this.regs[MX_SPO2] & 0x03);
    const lsb = 1 << (18 - bits);
    const v = Math.round(clamp(counts * scale, 0, 0x3ffff));
    return v - (v % lsb);
  }

  protected writeReg(reg: number, value: number): void {
    switch (reg) {
      case MX_FIFO_WR:
      case MX_FIFO_RD:
      case MX_FIFO_OVF:
        this.sync();
        // The library clears all three together: the FIFO starts empty.
        if (reg === MX_FIFO_WR) this.wr = value & 0x1f;
        else if (reg === MX_FIFO_RD) this.rd = value & 0x1f;
        else this.overflow = value & 0x1f;
        this.fifo = this.fifo.slice(0, (this.wr - this.rd + FIFO_DEPTH) % FIFO_DEPTH);
        this.outBytes = [];
        return;
      case MX_MODE:
        if (value & 0x40) {
          this.reset();
          return;
        }
        // The samples due so far were taken in the old mode; the new one starts now.
        this.sync();
        this.regs[reg] = value;
        this.sync();
        return;
      case MX_TEMP_CONFIG:
        if (value & 0x01) {
          const t = DIE_TEMP_C;
          this.regs[MX_TEMP_INT] = Math.floor(t) & 0xff;
          this.regs[MX_TEMP_FRAC] = Math.round((t - Math.floor(t)) / 0.0625) & 0x0f;
          this.regs[MX_INTSTAT2] |= 0x02;
        }
        return;
      case MX_INTSTAT1:
      case MX_INTSTAT2:
      case MX_FIFO_DATA:
      case 0xfe:
      case 0xff:
        return; // read-only
      default:
        this.sync();
        this.regs[reg] = value;
        this.sync();
    }
  }

  protected readReg(reg: number): number {
    switch (reg) {
      case MX_INTSTAT1: {
        this.sync();
        let v = this.regs[MX_INTSTAT1] & 0x01;
        if (this.newSample) v |= 0x40; // PPG_RDY
        const free = FIFO_DEPTH - this.fifo.length;
        if (free <= (this.regs[MX_FIFO_CONFIG] & 0x0f)) v |= 0x80; // A_FULL
        this.regs[MX_INTSTAT1] = 0;
        this.newSample = false;
        return v;
      }
      case MX_INTSTAT2: {
        const v = this.regs[MX_INTSTAT2];
        this.regs[MX_INTSTAT2] = 0;
        return v;
      }
      case MX_FIFO_WR:
        this.sync();
        if (this.nowNs() === null && this.sampling() && this.fifo.length === 0) {
          // No clock: a sample per poll, a sample period apart.
          this.fakeNs += this.samplePeriodNs();
          this.push(this.fakeNs);
        }
        return this.wr;
      case MX_FIFO_RD:
        this.sync();
        return this.rd;
      case MX_FIFO_OVF:
        this.sync();
        return this.overflow;
      case MX_FIFO_DATA:
        return this.fifoByte();
      case MX_TEMP_FRAC: {
        this.regs[MX_INTSTAT2] &= ~0x02;
        return this.regs[reg];
      }
      default:
        return this.regs[reg];
    }
  }

  private fifoByte(): number {
    if (this.outBytes.length === 0) {
      const sample = this.fifo.shift();
      if (!sample) return 0;
      this.rd = (this.rd + 1) % FIFO_DEPTH;
      this.overflow = 0;
      for (const v of sample) this.outBytes.push((v >> 16) & 0x03, (v >> 8) & 0xff, v & 0xff);
    }
    return this.outBytes.shift() ?? 0;
  }
}

registerModuleModel('vl53l0x', i2cModel(['distance'], (a) => new Vl53l0xModel(a), 'vl53l0x'));
registerModuleModel('max30102', i2cModel(['bpm', 'finger'], (a) => new Max30102Model(a), 'max30102'));
