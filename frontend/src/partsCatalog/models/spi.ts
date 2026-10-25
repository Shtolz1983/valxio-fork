/**
 * SPI chips behind generic modules: thermocouple / RTD converters and the
 * MFRC522 RFID reader. Each one sits on the board's bus fabric under the
 * module's own pin names, so it answers a hardware SPI controller and a
 * bit-banged master (software decoder, buses/softSpi.ts) alike: the decoder
 * clocks frames out of `transfer` and reads the bit ahead through `peekMiso`.
 */
import { attachSpiDevice, type SpiDevice, type SpiDeviceDescriptor, type SpiMode } from '../../simulation/buses';
import type { PartCard } from '../types';
import { registerModuleModel, type ModuleModel, type ModuleModelContext } from './registry';

// ── Shared plumbing ─────────────────────────────────────────────────────────

/** A model's SPI chip: the bus device plus the panel values it answers from. */
interface ValueSpiDevice extends SpiDevice {
  values: Record<string, number>;
}

const NAMES = {
  sck: ['SCK', 'CLK', 'SCLK', 'SCL'],
  mosi: ['MOSI', 'SDI', 'DI', 'SI', 'DIN'],
  miso: ['MISO', 'SDO', 'DO', 'SO', 'DOUT'],
  cs: ['CS', 'SS', 'NSS', 'CSN', 'SDA'],
} as const;

/**
 * The card's SPI pin names: by role first (spi-sck / spi-mosi / spi-miso /
 * spi-cs), then by the usual silkscreen names, for a card that labels a
 * read-only chip's legs mcu-out / mcu-in (the MAX6675).
 */
export function cardSpiPins(card: PartCard): SpiDeviceDescriptor['pins'] {
  const byRole = (role: string) => card.pins.find((p) => p.role === role)?.name;
  const byName = (names: readonly string[]) =>
    names.map((n) => card.pins.find((p) => p.name.toUpperCase() === n)?.name).find(Boolean);
  const sck = byRole('spi-sck') ?? byName(NAMES.sck) ?? 'SCK';
  const mosi = byRole('spi-mosi') ?? byName(NAMES.mosi);
  const miso = byRole('spi-miso') ?? byName(NAMES.miso);
  const cs = byRole('spi-cs') ?? byName(NAMES.cs);
  return { sck, ...(mosi ? { mosi } : {}), ...(miso ? { miso } : {}), ...(cs ? { cs } : {}) };
}

/**
 * The usual SPI model: the chip on the bus of the card's SPI legs, fed every
 * panel change.
 *
 * `workerModel` names its Python twin in backend/app/services/
 * catalog_spi_models.py: on a board whose firmware runs in a backend worker
 * (ESP32 under QEMU) the bus map carries the chip as that twin
 * (`RemoteSpiModel.catalog`, the bus legs under the role names SCK / MOSI /
 * MISO / CS), and the panel values travel as its live attributes. Without
 * one, such a board has no copy of the chip that can answer in time.
 */
function spiModel(
  keys: string[],
  modes: SpiMode[],
  create: () => ValueSpiDevice,
  workerModel?: string,
): ModuleModel {
  return {
    keys,
    attach(ctx: ModuleModelContext) {
      const device = create();
      device.values = { ...ctx.values };
      const remote: Partial<SpiDeviceDescriptor> = workerModel
        ? {
            remoteModel: () => ({
              wasmB64: '',
              catalog: workerModel,
              chipPads: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' },
            }),
            remoteAttrs: () => ({ ...device.values }),
          }
        : {};
      const handle = attachSpiDevice(
        { owner: ctx.componentId, componentId: ctx.componentId, pins: cardSpiPins(ctx.card), modes, ...remote },
        device,
      );
      return {
        update(values) {
          device.values = { ...values };
          handle.attrsChanged();
        },
        dispose() {
          handle.dispose();
        },
      };
    },
  };
}

const num = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// ── MAX6675 ─────────────────────────────────────────────────────────────────

/** The 16-bit word the MAX6675 shifts out: D14..D3 = °C × 4, D2 = open input (0). */
export function max6675Word(celsius: number): number {
  const counts = Math.max(0, Math.min(4095, Math.round(celsius * 4)));
  return counts << 3;
}

/**
 * MAX6675 (Adafruit "MAX6675 library"): the library bit-bangs SCK on any
 * GPIO (mode 0: SCK low, sample SO, SCK high) and reads 16 bits per CS low.
 * It returns NaN when D2 (open thermocouple) is set and otherwise D14..D3 ×
 * 0.25 °C, so the chip latches the panel temperature on select and shifts
 * that word out MSB first. No thermocouple-open state: D2 is always 0.
 */
export class Max6675Model implements ValueSpiDevice {
  values: Record<string, number> = {};
  private word = 0;
  private pos = 0;

  select(): void {
    this.word = max6675Word(num(this.values.temperature, 25));
    this.pos = 0;
  }

  deselect(): void {
    this.pos = 0;
  }

  private byte(pos: number): number {
    if (pos === 0) return (this.word >> 8) & 0xff;
    if (pos === 1) return this.word & 0xff;
    return 0;
  }

  transfer(): number {
    if (this.pos === 0) this.word = max6675Word(num(this.values.temperature, 25));
    return this.byte(this.pos++);
  }

  peekMiso(): number {
    if (this.pos === 0) this.word = max6675Word(num(this.values.temperature, 25));
    return this.byte(this.pos);
  }

  boardReset(): void {
    this.pos = 0;
  }
}

registerModuleModel('max6675', spiModel(['temperature'], [0], () => new Max6675Model(), 'max6675'));

// ── MAX31865 ────────────────────────────────────────────────────────────────

const RTD_A = 3.9083e-3;
const RTD_B = -5.775e-7;
/** The example's board: a PT100 against a 430 Ω reference. */
const RTD_NOMINAL = 100;
const RTD_REF = 430;

/** Adafruit_MAX31865::calculateTemperature, line for line. */
export function max31865LibraryCelsius(raw15: number, nominal = RTD_NOMINAL, ref = RTD_REF): number {
  let rt = (raw15 / 32768) * ref;
  const z1 = -RTD_A;
  const z2 = RTD_A * RTD_A - 4 * RTD_B;
  const z3 = (4 * RTD_B) / nominal;
  const z4 = 2 * RTD_B;
  let temp = (Math.sqrt(z2 + z3 * rt) + z1) / z4;
  if (temp >= 0) return temp;
  rt = (rt / nominal) * 100;
  let rpoly = rt;
  temp = -242.02;
  temp += 2.2228 * rpoly;
  rpoly *= rt;
  temp += 2.5859e-3 * rpoly;
  rpoly *= rt;
  temp -= 4.826e-6 * rpoly;
  rpoly *= rt;
  temp -= 2.8183e-8 * rpoly;
  rpoly *= rt;
  temp += 1.5243e-10 * rpoly;
  return temp;
}

/**
 * The 15-bit RTD ratio whose decode by the library comes closest to
 * `celsius`: above 0 °C the Callendar–Van Dusen quadratic the library
 * inverts exactly, below it the library's 5th-order polynomial inverted by
 * bisection; then the nearer of the two neighbouring codes.
 */
export function max31865Raw(celsius: number, nominal = RTD_NOMINAL, ref = RTD_REF): number {
  let ohms: number;
  if (celsius >= 0) {
    ohms = nominal * (1 + RTD_A * celsius + RTD_B * celsius * celsius);
  } else {
    let lo = 0;
    let hi = nominal * 1.01;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (max31865LibraryCelsius((mid / ref) * 32768, nominal, ref) < celsius) lo = mid;
      else hi = mid;
    }
    ohms = (lo + hi) / 2;
  }
  const exact = Math.max(0, Math.min(0x7fff, (ohms / ref) * 32768));
  const a = Math.floor(exact);
  const b = Math.min(0x7fff, a + 1);
  const err = (r: number) => Math.abs(max31865LibraryCelsius(r, nominal, ref) - celsius);
  return err(b) < err(a) ? b : a;
}

const CFG_BIAS = 0x80;
const CFG_AUTO = 0x40;
const CFG_1SHOT = 0x20;
const CFG_FAULT_CYCLE = 0x0c;
const CFG_FAULT_CLEAR = 0x02;

/**
 * MAX31865 (Adafruit_MAX31865 over Adafruit BusIO, SPI mode 1). The card's
 * example passes only CS, so it is the hardware-SPI constructor; the
 * four-pin constructor bit-bangs and lands on the software decoder instead.
 * Registers: config 0x00 (bias, auto, self-clearing 1-shot, fault-cycle and
 * fault-clear bits), RTD 0x01/0x02 (15-bit ratio << 1, D0 fault), high/low
 * fault thresholds 0x03..0x06, fault status 0x07. Reads auto-increment,
 * writes are address | 0x80. A 1-shot (or a read in auto mode) converts the
 * panel temperature for a PT100 with a 430 Ω reference, as the example's
 * RNOMINAL / RREF; an RTD past a threshold sets D0 and the status bits.
 */
export class Max31865Model implements ValueSpiDevice {
  values: Record<string, number> = {};
  private regs = new Uint8Array(8);
  private pos = 0;
  private addr = 0;
  private write = false;

  constructor() {
    this.powerOn();
  }

  private powerOn(): void {
    this.regs.fill(0);
    this.regs[3] = 0xff;
    this.regs[4] = 0xff;
    this.pos = 0;
  }

  private convert(): void {
    const raw = max31865Raw(Math.max(-200, Math.min(850, num(this.values.temperature, 25))));
    const high = ((this.regs[3] << 8) | this.regs[4]) >> 1;
    const low = ((this.regs[5] << 8) | this.regs[6]) >> 1;
    let fault = 0;
    if (raw > high) fault |= 0x80;
    if (raw < low) fault |= 0x40;
    this.regs[7] |= fault;
    const word = (raw << 1) | (this.regs[7] ? 1 : 0);
    this.regs[1] = word >> 8;
    this.regs[2] = word & 0xff;
  }

  private read(addr: number): number {
    const a = addr & 0x07;
    if ((a === 1 || a === 2) && (this.regs[0] & (CFG_BIAS | CFG_AUTO)) === (CFG_BIAS | CFG_AUTO)) {
      if (a === 1) this.convert();
    }
    return this.regs[a];
  }

  private writeReg(addr: number, value: number): void {
    const a = addr & 0x07;
    if (a === 0) {
      if (value & CFG_FAULT_CLEAR) {
        this.regs[7] = 0;
        this.regs[2] &= 0xfe;
      }
      // Fault-cycle and fault-clear bits read back 0 once done (at once here).
      this.regs[0] = value & ~(CFG_FAULT_CYCLE | CFG_FAULT_CLEAR | CFG_1SHOT);
      if (value & CFG_1SHOT) this.convert();
      else if ((value & (CFG_BIAS | CFG_AUTO)) === (CFG_BIAS | CFG_AUTO)) this.convert();
    } else if (a >= 3 && a <= 6) {
      this.regs[a] = value & 0xff;
    }
    // 0x01, 0x02 and 0x07 are read-only.
  }

  select(): void {
    this.pos = 0;
  }

  deselect(): void {
    this.pos = 0;
  }

  transfer(mosi: number): number {
    if (this.pos++ === 0) {
      this.write = (mosi & 0x80) !== 0;
      this.addr = mosi & 0x7f;
      return 0;
    }
    if (this.write) {
      this.writeReg(this.addr, mosi);
      this.addr = (this.addr + 1) & 0x7f;
      return 0;
    }
    const out = this.read(this.addr);
    this.addr = (this.addr + 1) & 0x7f;
    return out;
  }

  peekMiso(): number {
    if (this.pos === 0 || this.write) return 0;
    return this.regs[this.addr & 0x07];
  }

  boardReset(): void {
    this.powerOn();
  }
}

registerModuleModel('max31865', spiModel(['temperature'], [1, 3], () => new Max31865Model(), 'max31865'));

// ── MFRC522 ─────────────────────────────────────────────────────────────────

/** The panel's `tag` choices: 4-byte single-size UIDs (none starts with the cascade tag 0x88). */
export const RC522_TAGS: ReadonlyArray<readonly number[]> = [
  [0xde, 0xad, 0xbe, 0xef],
  [0x12, 0x34, 0x56, 0x78],
  [0xa1, 0xb2, 0xc3, 0xd4],
  [0x04, 0x7f, 0x3a, 0x91],
];

/** ISO/IEC 14443-3 CRC_A (reflected 0x8408) from `preset`; low byte first on the air. */
export function crcA(data: ArrayLike<number>, preset = 0x6363): number {
  let crc = preset & 0xffff;
  for (let i = 0; i < data.length; i++) {
    let b = (data[i] ^ crc) & 0xff;
    b = (b ^ (b << 4)) & 0xff;
    crc = ((crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4)) & 0xffff;
  }
  return crc;
}

const REG = {
  Command: 0x01,
  ComIrq: 0x04,
  DivIrq: 0x05,
  Error: 0x06,
  FIFOData: 0x09,
  FIFOLevel: 0x0a,
  Control: 0x0c,
  BitFraming: 0x0d,
  Mode: 0x11,
  TxControl: 0x14,
  CRCResultH: 0x21,
  CRCResultL: 0x22,
  TMode: 0x2a,
  Version: 0x37,
} as const;

/** Power-on values (MFRC522 datasheet, section 9.3); the rest reset to 0. */
const RESET: Record<number, number> = {
  0x01: 0x20,
  0x02: 0x80,
  0x04: 0x14,
  0x07: 0x21,
  0x0b: 0x08,
  0x0c: 0x10,
  0x0e: 0xa0,
  0x11: 0x3f,
  0x14: 0x80,
  0x16: 0x10,
  0x17: 0x84,
  0x18: 0x84,
  0x19: 0x4d,
  0x1a: 0x00,
  0x21: 0xff,
  0x22: 0xff,
  0x24: 0x26,
  0x26: 0x48,
  0x27: 0x88,
  0x28: 0x20,
  0x29: 0x20,
  0x37: 0x92,
};

const CMD = { Idle: 0x0, Mem: 0x1, CalcCRC: 0x3, Transmit: 0x4, Transceive: 0xc, MFAuthent: 0xe, SoftReset: 0xf };
const PICC = { REQA: 0x26, WUPA: 0x52, SEL_CL1: 0x93, HLTA: 0x50 };

type PiccState = 'idle' | 'ready' | 'active' | 'halt';

/**
 * The tag in the field: an ISO 14443-A MIFARE Classic 1K as far as
 * activation goes. REQA (IDLE) / WUPA (IDLE or HALT) answer ATQA 0x0004 and
 * make it READY; cascade-level-1 anticollision answers the UID bytes past the
 * known bits plus BCC; SELECT with the full UID, BCC and a good CRC_A answers
 * SAK 0x08 + CRC_A and makes it ACTIVE; HLTA halts it without an answer. A
 * frame it does not expect sends it back to IDLE without an answer. No
 * MIFARE memory: authentication and reads time out.
 */
class Picc {
  state: PiccState = 'idle';
  readonly uid: readonly number[];
  constructor(uid: readonly number[]) {
    this.uid = uid;
  }

  private bcc(): number {
    return this.uid.reduce((a, b) => a ^ b, 0);
  }

  receive(frame: number[], lastBits: number): number[] | null {
    if (frame.length === 1 && lastBits === 7) {
      const cmd = frame[0] & 0x7f;
      const wakes =
        (cmd === PICC.REQA && this.state === 'idle') ||
        (cmd === PICC.WUPA && (this.state === 'idle' || this.state === 'halt'));
      if (wakes) {
        this.state = 'ready';
        return [0x04, 0x00];
      }
      if (this.state !== 'halt') this.state = 'idle';
      return null;
    }
    if (frame[0] === PICC.SEL_CL1 && frame.length >= 2 && this.state === 'ready') {
      const nvb = frame[1];
      const full = [...this.uid, this.bcc()];
      if (nvb === 0x70 && frame.length >= 9) {
        const same = full.every((b, i) => frame[2 + i] === b);
        const crc = crcA(frame.slice(0, 7));
        if (!same || frame[7] !== (crc & 0xff) || frame[8] !== crc >> 8) return null;
        this.state = 'active';
        const sak = 0x08;
        const sc = crcA([sak]);
        return [sak, sc & 0xff, sc >> 8];
      }
      const knownBits = Math.max(0, ((nvb >> 4) - 2) * 8 + (nvb & 0x07));
      if (knownBits >= 32) return null;
      // Bits below the receive alignment of the first byte are masked off by
      // the reader (RxAlign), so whole bytes from the first partial one do.
      return full.slice(Math.floor(knownBits / 8));
    }
    if (frame[0] === PICC.HLTA && frame[1] === 0x00 && this.state === 'active') {
      this.state = 'halt';
      return null;
    }
    if (this.state !== 'halt') this.state = 'idle';
    return null;
  }
}

/**
 * MFRC522 (miguelbalboa MFRC522 library, hardware SPI mode 0 with SS and RST
 * from the sketch). SPI: an address byte (reg << 1, bit 7 = read), then data;
 * a read answers the register named by the previous byte while the next byte
 * names the following one, a write puts every data byte into the same
 * register (FIFODataReg fills the 64-byte FIFO). The register file answers
 * what the library polls: VersionReg 0x92, CommandReg (PowerDown clear after
 * SoftReset), ComIrqReg / DivIrqReg with their Set1/Set2 write semantics,
 * ErrorReg 0, FIFOLevelReg (bit 7 flushes), ControlReg RxLastBits,
 * TxControlReg (antenna) and CRCResultReg. CalcCRC runs the CRC_A
 * coprocessor over the FIFO with the ModeReg preset; Transceive with
 * BitFramingReg StartSend sends the FIFO to the tag and puts its answer in
 * the FIFO with RxIRq, or, with nothing answering (no tag, antenna off, a
 * halted tag), raises TimerIRq the way the TAuto timer does.
 */
export class Mfrc522Model implements ValueSpiDevice {
  private _values: Record<string, number> = {};
  private regs = new Uint8Array(0x40);
  private fifo: number[] = [];
  private pos = 0;
  private addr = 0;
  private reading = false;
  private picc: Picc | null = null;

  constructor() {
    this.softReset();
  }

  get values(): Record<string, number> {
    return this._values;
  }

  /** A new panel value set: the tag left the field, or another one came. */
  set values(v: Record<string, number>) {
    this._values = v;
    const present = num(v.card, 0) >= 0.5;
    const index = Math.max(0, Math.min(RC522_TAGS.length - 1, Math.round(num(v.tag, 0))));
    const uid = RC522_TAGS[index];
    if (!present) this.picc = null;
    else if (!this.picc || this.picc.uid !== uid) this.picc = new Picc(uid);
  }

  private softReset(): void {
    this.regs.fill(0);
    for (const [a, v] of Object.entries(RESET)) this.regs[Number(a)] = v;
    this.fifo = [];
  }

  private readReg(a: number, consume: boolean): number {
    switch (a) {
      case REG.FIFOData:
        return (consume ? this.fifo.shift() : this.fifo[0]) ?? 0;
      case REG.FIFOLevel:
        return Math.min(64, this.fifo.length);
      default:
        return this.regs[a];
    }
  }

  private writeReg(a: number, v: number): void {
    switch (a) {
      case REG.Command:
        this.regs[a] = (this.regs[a] & 0x20) | (v & 0x3f);
        this.command(v & 0x0f);
        return;
      case REG.ComIrq:
      case REG.DivIrq: {
        const mask = v & 0x7f;
        this.regs[a] = v & 0x80 ? this.regs[a] | mask : this.regs[a] & ~mask;
        return;
      }
      case REG.FIFOData:
        if (this.fifo.length < 64) this.fifo.push(v & 0xff);
        else this.regs[REG.Error] |= 0x10; // BufferOvfl
        return;
      case REG.FIFOLevel:
        if (v & 0x80) {
          this.fifo = [];
          this.regs[REG.Error] &= ~0x10;
        }
        return;
      case REG.Version:
        return;
      case REG.BitFraming:
        this.regs[a] = v;
        if (v & 0x80 && (this.regs[REG.Command] & 0x0f) === CMD.Transceive) this.transceive();
        return;
      default:
        this.regs[a] = v;
    }
  }

  private command(cmd: number): void {
    switch (cmd) {
      case CMD.SoftReset:
        this.softReset();
        return;
      case CMD.CalcCRC: {
        const preset = [0x0000, 0x6363, 0xa671, 0xffff][this.regs[REG.Mode] & 0x03];
        const crc = crcA(this.fifo, preset);
        this.fifo = [];
        this.regs[REG.CRCResultL] = crc & 0xff;
        this.regs[REG.CRCResultH] = crc >> 8;
        this.regs[REG.DivIrq] |= 0x04; // CRCIRq
        return;
      }
      case CMD.Mem:
        this.fifo = [];
        this.idle();
        return;
      case CMD.Transmit:
        this.fifo = [];
        this.regs[REG.ComIrq] |= 0x40; // TxIRq
        this.idle();
        return;
      case CMD.Transceive:
        if (this.regs[REG.BitFraming] & 0x80) this.transceive();
        return;
      case CMD.MFAuthent:
        // No Crypto1: the tag never answers, so the timer runs out.
        this.fifo = [];
        if (this.regs[REG.TMode] & 0x80) this.regs[REG.ComIrq] |= 0x01;
        return;
      default:
        return;
    }
  }

  private idle(): void {
    this.regs[REG.Command] &= 0xf0;
    this.regs[REG.ComIrq] |= 0x10; // IdleIRq
  }

  private transceive(): void {
    const lastBits = this.regs[REG.BitFraming] & 0x07;
    this.regs[REG.BitFraming] &= 0x7f; // StartSend done
    const frame = this.fifo.splice(0);
    this.regs[REG.Error] = 0;
    this.regs[REG.ComIrq] |= 0x40; // TxIRq
    const field = (this.regs[REG.TxControl] & 0x03) !== 0;
    const answer = field && this.picc ? this.picc.receive(frame, lastBits) : null;
    if (answer && answer.length > 0) {
      this.fifo = answer.slice(0, 64);
      this.regs[REG.Control] &= 0xf8; // RxLastBits 0: all 8 bits of the last byte are valid
      this.regs[REG.ComIrq] |= 0x20; // RxIRq
    } else if (this.regs[REG.TMode] & 0x80) {
      this.regs[REG.ComIrq] |= 0x01; // TimerIRq: TAuto ran out, nothing came back
    }
  }

  select(): void {
    this.pos = 0;
  }

  deselect(): void {
    this.pos = 0;
  }

  transfer(mosi: number): number {
    const next = (mosi >> 1) & 0x3f;
    if (this.pos++ === 0) {
      this.reading = (mosi & 0x80) !== 0;
      this.addr = next;
      return 0;
    }
    if (this.reading) {
      const out = this.readReg(this.addr, true);
      this.addr = next;
      return out;
    }
    this.writeReg(this.addr, mosi);
    return 0;
  }

  peekMiso(): number {
    return this.pos > 0 && this.reading ? this.readReg(this.addr, false) : 0;
  }

  boardReset(): void {
    this.softReset();
    this.pos = 0;
    if (this.picc) this.picc.state = 'idle';
  }
}

registerModuleModel('rc522', spiModel(['card', 'tag'], [0], () => new Mfrc522Model(), 'rc522'));
