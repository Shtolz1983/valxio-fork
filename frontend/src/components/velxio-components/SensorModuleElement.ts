/**
 * SensorModuleElement.ts — `<velxio-sensor-module>`, the generic breakout
 * board every parts-catalog card without a dedicated part is drawn as.
 *
 * A PCB with the module name, a chip and a 0.1" header along the TOP edge
 * (wires come from the board above it and land on the pins without crossing
 * the module); the header follows the card's pin list, so a new sensor needs a card, not
 * new drawing code. The card data rides in the component's properties
 * (`moduleName`, `modulePins` as "VCC,GND,SCL,SDA", `moduleColor`), which keeps
 * a saved project drawable even when its card is gone.
 *
 * A display module (a card whose simulator model is a display) also has
 * `moduleDisplayKind` ('7seg' or 'matrix'): the module is drawn taller with a
 * blank display below the name, and the model paints it at run time through
 * `moduleDisplay` (see ModuleDisplay). A paint only touches the fill of the
 * segments / LEDs that changed; the board itself is drawn again only when
 * its shape changes.
 *
 * Per CLAUDE.md §6a this MUST be a real Web Component — the wire system reads
 * `pinInfo` from the DOM node to place wire endpoints on pin tips.
 */

const PIN_PITCH = 20;
const SIDE_PAD = 14;
const BODY_H = 64;
const LEG = 8;
const MIN_W = 84;

/** Room above a display for the rotated pin labels and the name. */
const BELOW_DISPLAY = 42;
const PANEL_TOP = 6;
const PANEL_MARGIN = 6;

// 7-segment digit geometry (one digit cell, in px).
const DIG_W = 16;
const DIG_H = 28;
const DIG_GAP = 6;
const COLON_GAP = 6;
const SEG_PAD_X = 6;
const SEG_PAD_Y = 7;

// LED matrix geometry.
const LED_PITCH = 9;
const LED_R = 3.4;
const LED_PAD = 3;

const LIT = '#ff2a1a';
const SEG_DIM = '#3a1512';
const LED_DIM = '#3b1d1a';

export type ModuleDisplayKind = '' | '7seg' | 'matrix';

/**
 * What a display model paints on the module.
 *
 *  - '7seg': one segment byte per digit, bit 0 = a … bit 6 = g, bit 7 = the
 *    digit's decimal point. A 4-digit module has a colon instead of points
 *    (`colon`); other digit counts draw the points.
 *  - 'matrix': 8 rows top to bottom; bit 7 of a row is its LEFT LED, bit 0
 *    its right one.
 *
 * `on` false blanks the display (the chip's display-off / shutdown);
 * `brightness` 0..1 dims what is lit.
 */
export type ModuleDisplay =
  | { kind: '7seg'; digits: number[]; colon?: boolean; on?: boolean; brightness?: number }
  | { kind: 'matrix'; rows: number[]; on?: boolean; brightness?: number };

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function signalsFor(name: string) {
  const n = name.toUpperCase();
  if (/^(GND|VSS|WAK)$/.test(n)) return [{ type: 'power', signal: 'GND' }];
  if (/^(VCC|VIN|VDD|3V3|5V|\+)$/.test(n)) return [{ type: 'power', signal: 'VCC' }];
  return [];
}

function sevenSegPanel(digits: number): { width: number; height: number } {
  const colon = digits === 4 ? COLON_GAP : 0;
  return {
    width: SEG_PAD_X * 2 + digits * DIG_W + (digits - 1) * DIG_GAP + colon,
    height: SEG_PAD_Y * 2 + DIG_H,
  };
}

function matrixPanel(): { width: number; height: number } {
  const side = LED_PAD * 2 + 8 * LED_PITCH;
  return { width: side, height: side };
}

function panelSize(kind: ModuleDisplayKind, digits: number): { width: number; height: number } | null {
  if (kind === '7seg') return sevenSegPanel(digits);
  if (kind === 'matrix') return matrixPanel();
  return null;
}

/** Body height (without the pin legs) of a module with this display. */
function bodyHeight(kind: ModuleDisplayKind, digits: number): number {
  const panel = panelSize(kind, digits);
  return panel ? PANEL_TOP + panel.height + BELOW_DISPLAY : BODY_H;
}

export function moduleSize(
  pinCount: number,
  displayKind: ModuleDisplayKind = '',
  digits = 4,
): { width: number; height: number } {
  const pinsW = Math.max(MIN_W, SIDE_PAD * 2 + Math.max(0, pinCount - 1) * PIN_PITCH);
  const panel = panelSize(displayKind, digits);
  const width = panel ? Math.max(pinsW, panel.width + PANEL_MARGIN * 2) : pinsW;
  return { width, height: bodyHeight(displayKind, digits) + LEG };
}

/** Segment rectangles of one digit cell: a, b, c, d, e, f, g. */
const SEGMENTS: Array<[number, number, number, number]> = [
  [3, 0, DIG_W - 6, 3], // a
  [DIG_W - 3, 2, 3, DIG_H / 2 - 3], // b
  [DIG_W - 3, DIG_H / 2 + 1, 3, DIG_H / 2 - 3], // c
  [3, DIG_H - 3, DIG_W - 6, 3], // d
  [0, DIG_H / 2 + 1, 3, DIG_H / 2 - 3], // e
  [0, 2, 3, DIG_H / 2 - 3], // f
  [3, DIG_H / 2 - 1.5, DIG_W - 6, 3], // g
];

function parseKind(v: unknown): ModuleDisplayKind {
  return v === '7seg' || v === 'matrix' ? v : '';
}

function parseDisplay(v: unknown): ModuleDisplay | null {
  let d = v;
  if (typeof d === 'string') {
    try {
      d = d.trim() ? JSON.parse(d) : null;
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (o.kind === '7seg' && Array.isArray(o.digits)) return o as unknown as ModuleDisplay;
  if (o.kind === 'matrix' && Array.isArray(o.rows)) return o as unknown as ModuleDisplay;
  return null;
}

class SensorModuleElement extends HTMLElement {
  private _name = 'Module';
  private _pins: string[] = ['VCC', 'GND'];
  private _color = '#1d5b8f';
  private _kind: ModuleDisplayKind = '';
  private _digits = 4;
  private _display: ModuleDisplay | null = null;

  /** The display's paintable shapes in the current drawing, in paint order. */
  private _cells: SVGElement[] = [];
  /** The fill each cell has now, so a paint touches only what changed. */
  private _fills: string[] = [];
  private _opacity = '';
  private _litGroup: SVGGElement | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
  }

  get moduleName(): string {
    return this._name;
  }
  set moduleName(v: string) {
    const next = String(v ?? '') || 'Module';
    if (next === this._name) return;
    this._name = next;
    this.render();
  }

  get modulePins(): string {
    return this._pins.join(',');
  }
  set modulePins(v: string) {
    const pins = String(v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const next = pins.length ? pins : ['VCC', 'GND'];
    if (next.join(',') === this._pins.join(',')) return;
    this._pins = next;
    this.render();
  }

  get moduleColor(): string {
    return this._color;
  }
  set moduleColor(v: string) {
    const next = /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : '#1d5b8f';
    if (next === this._color) return;
    this._color = next;
    this.render();
  }

  /** The display the module has ('' = none): sets the board's shape. */
  get moduleDisplayKind(): ModuleDisplayKind {
    return this._kind;
  }
  set moduleDisplayKind(v: ModuleDisplayKind) {
    const kind = parseKind(v);
    if (kind === this._kind) return;
    this._kind = kind;
    this.render();
  }

  /** What the display shows now (null = blank). Set by the simulator model. */
  get moduleDisplay(): ModuleDisplay | null {
    return this._display;
  }
  set moduleDisplay(v: ModuleDisplay | null | string) {
    const d = parseDisplay(v);
    this._display = d;
    const digits = d?.kind === '7seg' ? Math.max(1, Math.min(8, d.digits.length)) : this._digits;
    if (d && (d.kind !== this._kind || digits !== this._digits)) {
      this._kind = d.kind;
      this._digits = digits;
      this.render();
      return;
    }
    this.paint();
  }

  private size() {
    return moduleSize(this._pins.length, this._kind, this._digits);
  }

  private pinX(i: number, width: number): number {
    const span = (this._pins.length - 1) * PIN_PITCH;
    return (width - span) / 2 + i * PIN_PITCH;
  }

  /** Wire system reads this from the DOM — do NOT memoize. Pin tips: the top edge. */
  get pinInfo() {
    const { width } = this.size();
    return this._pins.map((name, i) => ({
      name,
      x: this.pinX(i, width),
      y: 0,
      number: i + 1,
      signals: signalsFor(name),
    }));
  }

  /** The display's markup: a dark panel with every segment / LED unlit. */
  private displayMarkup(width: number, py: number): string {
    const panel = panelSize(this._kind, this._digits);
    if (!panel) return '';
    const px = (width - panel.width) / 2;
    let cells = '';
    if (this._kind === '7seg') {
      const colonAfter = this._digits === 4 ? 1 : -1;
      let x = px + SEG_PAD_X;
      const y = py + SEG_PAD_Y;
      for (let d = 0; d < this._digits; d++) {
        for (const [sx, sy, w, h] of SEGMENTS) {
          cells += `<rect data-c x="${x + sx}" y="${y + sy}" width="${w}" height="${h}" rx="1" fill="${SEG_DIM}"/>`;
        }
        // Bit 7: the decimal point, or nothing on a colon module (its bit 7 of
        // digit 1 is the colon, drawn once below; the others are not wired).
        cells +=
          colonAfter < 0
            ? `<circle data-c cx="${x + DIG_W + 2.5}" cy="${y + DIG_H - 1.5}" r="1.6" fill="${SEG_DIM}"/>`
            : `<circle data-c cx="0" cy="0" r="0" fill="${SEG_DIM}"/>`;
        x += DIG_W + DIG_GAP;
        if (d === colonAfter) {
          const cx = x - DIG_GAP / 2 + COLON_GAP / 2 - 0.5;
          cells += `<g data-c fill="${SEG_DIM}"><circle cx="${cx}" cy="${y + DIG_H * 0.3}" r="1.8"/><circle cx="${cx}" cy="${y + DIG_H * 0.7}" r="1.8"/></g>`;
          x += COLON_GAP;
        }
      }
    } else {
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const cx = px + LED_PAD + LED_PITCH * (c + 0.5);
          const cy = py + LED_PAD + LED_PITCH * (r + 0.5);
          cells += `<circle data-c cx="${cx}" cy="${cy}" r="${LED_R}" fill="${LED_DIM}"/>`;
        }
      }
    }
    return `
      <rect x="${px}" y="${py}" width="${panel.width}" height="${panel.height}" rx="2" fill="#121212" stroke="#000" stroke-opacity="0.6"/>
      <g data-lit>${cells}</g>`;
  }

  /** The fill of every cell for the current display state, in paint order. */
  private fillsFor(): string[] {
    const d = this._display;
    const on = !!d && d.on !== false;
    if (this._kind === '7seg') {
      const dim = SEG_DIM;
      const out: string[] = [];
      const colonModule = this._digits === 4;
      for (let i = 0; i < this._digits; i++) {
        const byte = on && d?.kind === '7seg' ? (d.digits[i] ?? 0) : 0;
        for (let s = 0; s < 7; s++) out.push(byte & (1 << s) ? LIT : dim);
        out.push(!colonModule && byte & 0x80 ? LIT : dim);
        if (colonModule && i === 1) out.push(on && d?.kind === '7seg' && d.colon ? LIT : dim);
      }
      return out;
    }
    const out: string[] = [];
    for (let r = 0; r < 8; r++) {
      const row = on && d?.kind === 'matrix' ? (d.rows[r] ?? 0) : 0;
      for (let c = 0; c < 8; c++) out.push(row & (0x80 >> c) ? LIT : LED_DIM);
    }
    return out;
  }

  /** Repaint the display: only the fills that changed. */
  private paint(): void {
    if (!this._cells.length) return;
    const fills = this.fillsFor();
    for (let i = 0; i < this._cells.length; i++) {
      const f = fills[i] ?? '';
      if (f && this._fills[i] !== f) {
        this._cells[i].setAttribute('fill', f);
        this._fills[i] = f;
      }
    }
    const b = this._display?.brightness;
    const opacity = typeof b === 'number' && Number.isFinite(b) ? String(0.55 + 0.45 * Math.max(0, Math.min(1, b))) : '1';
    if (this._litGroup && opacity !== this._opacity) {
      this._litGroup.setAttribute('opacity', opacity);
      this._opacity = opacity;
    }
  }

  private render(): void {
    if (!this.shadowRoot) return;
    const { width, height } = this.size();
    // The legs stick out of the top edge; the board starts under them.
    const top = LEG;
    const body = height - LEG;
    const display = this._kind !== '';
    const name = escapeXml(this._name);
    const fontSize = display ? 10 : this._name.length > 8 ? 10 : 12;
    // Pin labels hang under the header; the name sits below them, then the
    // chip (plain board) or the display.
    const nameY = display ? top + BELOW_DISPLAY - 8 : top + 40;
    const pins = this._pins
      .map((pin, i) => {
        const x = this.pinX(i, width);
        const label = escapeXml(pin);
        return `
          <rect x="${x - 4}" y="${top + 2}" width="8" height="8" rx="1" fill="#1b1b1b"/>
          <circle cx="${x}" cy="${top + 6}" r="2.2" fill="#d4af37"/>
          <rect x="${x - 1}" y="0" width="2" height="${LEG}" fill="#c9c9c9"/>
          <text x="${x}" y="${top + 14}" text-anchor="end" font-family="monospace" font-size="7"
                fill="#f5f5f5" transform="rotate(-90 ${x} ${top + 14})" dominant-baseline="middle">${label}</text>`;
      })
      .join('');
    // A display covers the chip and the mounting holes of the plain board.
    const furniture = display
      ? this.displayMarkup(width, top + BELOW_DISPLAY)
      : `
        <circle cx="7" cy="${top + body - 7}" r="2.5" fill="none" stroke="#e8e8e8" stroke-opacity="0.6"/>
        <circle cx="${width - 7}" cy="${top + body - 7}" r="2.5" fill="none" stroke="#e8e8e8" stroke-opacity="0.6"/>
        <rect x="${width / 2 - 9}" y="${top + body - 17}" width="18" height="12" rx="1.5" fill="#202020"/>`;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        svg { display: block; user-select: none; -webkit-user-select: none; }
      </style>
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0.5" y="${top + 0.5}" width="${width - 1}" height="${body - 1}" rx="4" fill="${this._color}" stroke="#0b0b0b" stroke-opacity="0.35"/>
        ${furniture}
        <text x="${width / 2}" y="${nameY}" text-anchor="middle" font-family="sans-serif" font-weight="600"
              font-size="${fontSize}" fill="#ffffff" dominant-baseline="middle">${name}</text>
        ${pins}
      </svg>`;
    this._litGroup = this.shadowRoot.querySelector('g[data-lit]');
    this._cells = Array.from(this.shadowRoot.querySelectorAll<SVGElement>('[data-c]'));
    this._fills = this._cells.map((c) => c.getAttribute('fill') ?? '');
    this._opacity = '';
    this.paint();
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('velxio-sensor-module')) {
  customElements.define('velxio-sensor-module', SensorModuleElement);
}
