/**
 * The register-map chip: the simulator model of a parts-catalog card whose
 * chip has no hand-written model (`"sim": { "model": "regmap", "regmap": … }`).
 *
 * The card describes the chip as its datasheet does: a register file behind
 * an address pointer, some registers holding fixed bytes (an ID, a "data
 * ready" status) and some holding a reading made from a panel value (raw =
 * value × scale + offset, or a curve). Most I2C sensors and the simple SPI
 * ones read that way. Everything the sketch writes is kept, so a library that
 * reads its configuration back finds it.
 *
 *   I2C  a write transaction starts with `pointer` address bytes (0: none);
 *        the bytes after them are written from there on. A read transaction
 *        reads from the pointer on. Both move the pointer one per byte.
 *        `width` 2 makes every address a 16-bit register (LM75, TMP102,
 *        INA219): the bytes go high first and the pointer stays on that
 *        register, a third byte reads the first again.
 *   SPI  each select starts with `pointer` address bytes; bit `readBit` of
 *        the first one equal to `readWhen` makes it a read, `addressMask`
 *        strips the flag bits. With `pointer` 0 every select reads from
 *        register 0 (a converter that only shifts its word out).
 *
 * Readings are computed when a read starts, so a multi-byte reading is never
 * torn between two panel values. A host that does not report START (some of
 * the tab's buses) is followed from the bytes: a write after a stop or a
 * read starts a write transaction, a read after a write or a stop a read.
 *
 * Pure: no imports, erasable TypeScript only. The tab's model (models/
 * regmap.ts) and the AI bridge's card check (ai-bridge/partCards.mjs, run by
 * Node straight from this file) share it; the ESP32 worker has a Python twin
 * (backend/app/services/catalog_regmap.py). Both must answer the cases in
 * src/__tests__/fixtures/regmap-vectors.json.
 */

export type RegmapNumber = number | string;

export interface RegmapValue {
  /** First register of the reading. */
  reg: RegmapNumber;
  /** The panel control it is made from. */
  from: string;
  /** 1..4, default 1. */
  bytes?: number;
  /** Byte order, default "be" (high byte at `reg`). */
  order?: 'be' | 'le';
  signed?: boolean;
  /** raw = value × scale + offset (defaults 1 and 0)… */
  scale?: number;
  offset?: number;
  /** …or a curve [[value, raw], …], values rising; flat outside the ends. */
  points?: Array<[number, number]>;
  /** Left shift of the raw number inside the bytes (a left-justified 12-bit reading: 4). */
  shift?: number;
  /** Constant bits ORed in (flag bits around the reading). */
  or?: RegmapNumber;
}

export interface RegmapSpec {
  bus: 'i2c' | 'spi';
  /** Address bytes before the data: 0, 1 (default) or 2. */
  pointer?: number;
  /** Bytes per register: 1 (default; the pointer runs on) or 2 (it stays). */
  width?: number;
  /** SPI mode 0..3, default 0. */
  spiMode?: number;
  /** SPI: the bit of the first address byte that marks a read, default 7. */
  readBit?: number;
  /** SPI: that bit's value on a read, default 1. */
  readWhen?: number;
  /** SPI: mask applied to the first address byte, default 0x7F. */
  addressMask?: RegmapNumber;
  /** Power-on contents: register -> byte or bytes from there on. */
  registers?: Record<string, RegmapNumber | RegmapNumber[]>;
  values?: RegmapValue[];
}

/** A number as a card writes it: 12, "12", "0x0C". NaN when it is none. */
export function regmapNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return NaN;
}

/** A curve's output at `v`: linear between points, flat outside the ends. */
export function regmapInterpolate(points: Array<[number, number]>, v: number): number {
  if (v <= points[0][0]) return points[0][1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (v <= x1) return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

/** The bytes a reading puts in its registers, in register order. */
export function regmapBytes(val: RegmapValue, v: number): number[] {
  const n = val.bytes ?? 1;
  const shift = val.shift ?? 0;
  const x = val.points ? regmapInterpolate(val.points, v) : v * (val.scale ?? 1) + (val.offset ?? 0);
  const bits = n * 8 - shift;
  const lo = val.signed ? -(2 ** (bits - 1)) : 0;
  const hi = val.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  let r = Math.round(x);
  if (!Number.isFinite(r)) r = 0;
  r = Math.min(hi, Math.max(lo, r));
  if (r < 0) r += 2 ** bits;
  const word = r * 2 ** shift;
  const or = regmapNumber(val.or ?? 0);
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push((Math.floor(word / 2 ** (8 * i)) % 256) | (Math.floor(or / 2 ** (8 * i)) % 256));
  }
  return val.order === 'le' ? out.reverse() : out;
}

const BYTE = (v: unknown) => {
  const n = regmapNumber(v);
  return Number.isInteger(n) && n >= 0 && n <= 255;
};

/**
 * What is wrong with a card's register map (empty: nothing). `controls` are
 * the card's control keys. Messages are for the AI that wrote the card.
 */
export function regmapProblems(spec: unknown, controls: string[]): string[] {
  const p: string[] = [];
  if (!spec || typeof spec !== 'object') return ['sim.regmap: missing — the "regmap" model needs a "regmap" object'];
  const s = spec as Record<string, unknown>;
  const known = ['bus', 'pointer', 'width', 'spiMode', 'readBit', 'readWhen', 'addressMask', 'registers', 'values'];
  for (const k of Object.keys(s)) if (!known.includes(k)) p.push(`sim.regmap: unknown field "${k}"`);
  if (s.bus !== 'i2c' && s.bus !== 'spi') p.push('sim.regmap.bus: "i2c" or "spi"');
  const pointer = s.pointer ?? 1;
  if (pointer !== 0 && pointer !== 1 && pointer !== 2) p.push('sim.regmap.pointer: 0, 1 or 2 address bytes');
  const width = s.width ?? 1;
  if (width !== 1 && width !== 2) p.push('sim.regmap.width: 1 or 2 bytes per register');
  const space = (pointer === 2 ? 0x10000 : 0x100) * (width === 2 ? 2 : 1);
  const at0 = (a: number) => a * (width === 2 ? 2 : 1);
  if (s.spiMode !== undefined && ![0, 1, 2, 3].includes(s.spiMode as number)) p.push('sim.regmap.spiMode: 0..3');
  if (s.readBit !== undefined && !(Number.isInteger(s.readBit) && (s.readBit as number) >= 0 && (s.readBit as number) <= 7)) {
    p.push('sim.regmap.readBit: 0..7');
  }
  if (s.readWhen !== undefined && s.readWhen !== 0 && s.readWhen !== 1) p.push('sim.regmap.readWhen: 0 or 1');
  if (s.addressMask !== undefined && !BYTE(s.addressMask)) p.push('sim.regmap.addressMask: a byte like "0x7F"');
  const regs = s.registers ?? {};
  if (typeof regs !== 'object' || Array.isArray(regs)) {
    p.push('sim.regmap.registers: an object { "0x0F": "0x33", "0x10": ["0x01", "0x02"] }');
  } else {
    for (const [k, v] of Object.entries(regs as Record<string, unknown>)) {
      const a = regmapNumber(k);
      const bytes = Array.isArray(v) ? v : [v];
      if (!Number.isInteger(a) || a < 0 || at0(a) + bytes.length > space) p.push(`sim.regmap.registers["${k}"]: not a register address`);
      if (bytes.length === 0 || !bytes.every(BYTE)) p.push(`sim.regmap.registers["${k}"]: bytes 0..255 ("0x33" or 51)`);
    }
  }
  const values = s.values ?? [];
  if (!Array.isArray(values) || values.length === 0) {
    p.push('sim.regmap.values: at least one reading [{ "reg", "from", "bytes", "scale" }]');
    return p;
  }
  values.forEach((raw, i) => {
    const at = `sim.regmap.values[${i}]`;
    if (!raw || typeof raw !== 'object') {
      p.push(`${at}: an object`);
      return;
    }
    const v = raw as Record<string, unknown>;
    const fields = ['reg', 'from', 'bytes', 'order', 'signed', 'scale', 'offset', 'points', 'shift', 'or'];
    for (const k of Object.keys(v)) if (!fields.includes(k)) p.push(`${at}: unknown field "${k}"`);
    const n = v.bytes ?? 1;
    if (!(Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 4)) p.push(`${at}.bytes: 1..4`);
    const reg = regmapNumber(v.reg);
    if (!Number.isInteger(reg) || reg < 0 || at0(reg) + (Number(n) || 1) > space) p.push(`${at}.reg: not a register address`);
    if (typeof v.from !== 'string' || !controls.includes(v.from)) p.push(`${at}.from: must name a control (${controls.join(', ') || 'none'})`);
    if (v.order !== undefined && v.order !== 'be' && v.order !== 'le') p.push(`${at}.order: "be" or "le"`);
    if (v.signed !== undefined && typeof v.signed !== 'boolean') p.push(`${at}.signed: true or false`);
    const shift = v.shift ?? 0;
    if (!(Number.isInteger(shift) && (shift as number) >= 0 && (shift as number) < (Number(n) || 1) * 8)) p.push(`${at}.shift: 0..bytes×8−1`);
    if (v.or !== undefined && !(Number.isInteger(regmapNumber(v.or)) && regmapNumber(v.or) >= 0)) p.push(`${at}.or: a non-negative integer like "0x0001"`);
    for (const k of ['scale', 'offset']) {
      if (v[k] !== undefined && !(typeof v[k] === 'number' && Number.isFinite(v[k]))) p.push(`${at}.${k}: a number`);
    }
    if (v.points !== undefined) {
      if (v.scale !== undefined || v.offset !== undefined) p.push(`${at}: give "points" or "scale"/"offset", not both`);
      const pts = v.points;
      const ok =
        Array.isArray(pts) &&
        pts.length >= 2 &&
        pts.every((q) => Array.isArray(q) && q.length === 2 && q.every((x) => typeof x === 'number' && Number.isFinite(x))) &&
        pts.every((q, j) => j === 0 || (q as number[])[0] > (pts[j - 1] as number[])[0]);
      if (!ok) p.push(`${at}.points: [[value, raw], …], at least 2, values rising`);
    }
  });
  return p;
}

/** The chip. `values` are the panel's; set them before a read to change the reading. */
export class RegmapChip {
  values: Record<string, number> = {};
  private readonly spec: RegmapSpec;
  private readonly pointerBytes: number;
  private readonly width: number;
  /** Byte cells: registers × width. */
  private readonly space: number;
  private readonly image = new Map<number, number>();
  /** Byte cell the next read or write uses. */
  private ptr = 0;
  /** Register address as the address bytes give it. */
  private reg = 0;
  private addrSeen = 0;
  /** The first address byte of an SPI select, flag bits and all. */
  private firstRaw = 0;
  private phase: 'idle' | 'addr' | 'data' | 'read' | 'write' = 'idle';

  constructor(spec: RegmapSpec) {
    this.spec = spec;
    this.pointerBytes = spec.pointer ?? 1;
    this.width = spec.width === 2 ? 2 : 1;
    this.space = (this.pointerBytes === 2 ? 0x10000 : 0x100) * this.width;
    this.powerOn();
  }

  powerOn(): void {
    this.image.clear();
    for (const [k, v] of Object.entries(this.spec.registers ?? {})) {
      const a = regmapNumber(k);
      (Array.isArray(v) ? v : [v]).forEach((b, i) => this.image.set((a * this.width + i) % this.space, regmapNumber(b) & 0xff));
    }
    this.ptr = 0;
    this.phase = 'idle';
  }

  private snapshot(): void {
    for (const val of this.spec.values ?? []) {
      const v = this.values[val.from];
      const bytes = regmapBytes(val, typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const reg = regmapNumber(val.reg);
      bytes.forEach((b, i) => this.image.set((reg * this.width + i) % this.space, b));
    }
  }

  /** The cell under the pointer; the pointer moves on (within its register when width is 2). */
  private next(): number {
    const a = this.ptr;
    const base = a - (a % this.width);
    this.ptr = this.width === 1 ? (a + 1) % this.space : base + ((a - base + 1) % this.width);
    return a;
  }

  private takeAddress(byte: number): boolean {
    this.reg = this.addrSeen === 0 ? byte : (this.reg << 8) | byte;
    this.addrSeen++;
    this.ptr = (this.reg * this.width) % this.space;
    return this.addrSeen >= this.pointerBytes;
  }

  // ── I2C ──

  start(read: boolean): void {
    if (read) {
      this.snapshot();
      if (this.pointerBytes === 0) this.ptr = 0;
      this.phase = 'read';
    } else {
      this.addrSeen = 0;
      this.phase = this.pointerBytes === 0 ? 'data' : 'addr';
    }
  }

  writeByte(value: number): boolean {
    const b = value & 0xff;
    if (this.phase === 'idle' || this.phase === 'read') this.start(false);
    if (this.phase === 'addr') {
      if (this.takeAddress(b)) this.phase = 'data';
    } else if (this.phase === 'data' && this.pointerBytes > 0) {
      this.image.set(this.next(), b);
    }
    return true;
  }

  readByte(): number {
    if (this.phase !== 'read') this.start(true);
    return this.image.get(this.next()) ?? 0;
  }

  stop(): void {
    this.phase = 'idle';
  }

  // ── SPI ──

  select(): void {
    this.addrSeen = 0;
    if (this.pointerBytes === 0) {
      this.snapshot();
      this.ptr = 0;
      this.phase = 'read';
    } else {
      this.phase = 'addr';
    }
  }

  deselect(): void {
    this.phase = 'idle';
  }

  transfer(mosi: number): number {
    const b = mosi & 0xff;
    if (this.phase === 'addr') {
      if (this.addrSeen === 0) this.firstRaw = b;
      const masked = this.addrSeen === 0 ? b & (regmapNumber(this.spec.addressMask ?? 0x7f) & 0xff) : b;
      if (this.takeAddress(masked)) {
        const read = (this.firstRaw >> (this.spec.readBit ?? 7)) & 1;
        this.phase = read === (this.spec.readWhen ?? 1) ? 'read' : 'write';
        if (this.phase === 'read') this.snapshot();
      }
      return 0;
    }
    if (this.phase === 'read') return this.image.get(this.next()) ?? 0;
    if (this.phase === 'write') this.image.set(this.next(), b);
    return 0;
  }

  /** The byte the next transfer answers, for a bit-banged master reading ahead. */
  peekMiso(): number {
    return this.phase === 'read' ? (this.image.get(this.ptr) ?? 0) : 0;
  }
}
