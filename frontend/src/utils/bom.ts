/**
 * Bill of materials: what to buy to build the circuit on the canvas, as a
 * CSV the user downloads. Built in the browser from the canvas itself
 * (boards, parts, wires) — no server, no saved project needed.
 *
 * One row per kind of part and value (three 220 Ω resistors are one row of
 * quantity 3), boards first, jumper wires last. Measuring instruments are
 * simulator tools, not parts, and are left out.
 */
import registry from '../services/ComponentRegistry';
import { partKnowledge } from '../validation/partsKnowledge';
import { boardDisplayName, type BoardInstance } from '../types/board';

export interface BomRow {
  qty: number;
  part: string;
  value: string;
  libraries: string;
  /** Ids of the parts on the canvas, so a row can be found there. */
  ids: string[];
}

export interface BomInput {
  boards: Pick<BoardInstance, 'id' | 'boardKind' | 'name'>[];
  components: { id: string; metadataId: string; properties: Record<string, unknown> }[];
  wires: unknown[];
}

export interface BomHeaders {
  qty: string;
  part: string;
  value: string;
  libraries: string;
  ids: string;
  wires: string;
}

/** 4700 → "4.7 kΩ", "1000000" → "1 MΩ"; anything not a plain number stays as written. */
function ohms(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || String(v).trim() === '') return `${String(v)} Ω`;
  const [div, unit] = n >= 1e6 ? [1e6, 'MΩ'] : n >= 1e3 ? [1e3, 'kΩ'] : [1, 'Ω'];
  return `${+(n / div).toFixed(2)} ${unit}`;
}

/** The value that tells two parts of one kind apart when buying them. */
const VALUE: Record<string, (p: Record<string, unknown>) => string> = {
  resistor: (p) => ohms(p.value),
  capacitor: (p) => (p.value ? `${String(p.value).replace(/u$/, 'µ')}F` : ''),
  led: (p) => String(p.color ?? ''),
  pushbutton: (p) => String(p.color ?? ''),
};

function isInstrument(metadataId: string): boolean {
  return metadataId.startsWith('instr-');
}

export function buildBom(input: BomInput): BomRow[] {
  const rows = new Map<string, BomRow>();
  const add = (key: string, row: Omit<BomRow, 'qty' | 'ids'>, id: string) => {
    const r = rows.get(key);
    if (r) {
      r.qty++;
      r.ids.push(id);
    } else rows.set(key, { ...row, qty: 1, ids: [id] });
  };

  for (const b of input.boards) {
    add(`board:${b.boardKind}`, { part: boardDisplayName({ boardKind: b.boardKind, name: undefined }), value: '', libraries: '' }, b.id);
  }
  for (const c of input.components) {
    if (isInstrument(c.metadataId)) continue;
    const meta = registry.getById(c.metadataId);
    const know = partKnowledge(c.metadataId);
    const value = VALUE[c.metadataId]?.(c.properties) ?? '';
    add(
      `part:${c.metadataId}:${value}`,
      { part: meta?.name ?? know?.label ?? c.metadataId, value, libraries: (know?.libraries ?? []).join('; ') },
      c.id,
    );
  }
  return [...rows.values()];
}

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The CSV text (with a byte-order mark, so Excel reads Cyrillic names right). */
export function bomCsv(input: BomInput, h: BomHeaders): string {
  const lines = [[h.qty, h.part, h.value, h.libraries, h.ids]];
  for (const r of buildBom(input)) lines.push([String(r.qty), r.part, r.value, r.libraries, r.ids.join(' ')]);
  if (input.wires.length) lines.push([String(input.wires.length), h.wires, '', '', '']);
  return `\ufeff${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`;
}
