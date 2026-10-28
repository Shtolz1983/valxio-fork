import { getApiBase } from '../lib/apiBase';
const apiBase = () => `${getApiBase()}/enclosure`;

/**
 * 3D-printable enclosures (backend/app/api/routes/enclosure.py). The spec is
 * the backend's EnclosureSpec as the AI assistant sends it: only `board` is
 * required, every other field has a default there.
 */
export type EnclosureSpec = {
  board: string;
  extras?: EnclosureExtra[];
  skip_connectors?: string[];
  battery?: string | null;
  battery_side?: 'left' | 'right';
  top_height?: number | null;
  modules?: EnclosureModuleSpec[];
  lid_modules?: EnclosureLidModuleSpec[];
} & Record<string, unknown>;

/** A display hung under the lid behind a window (backend LidModule). */
export interface EnclosureLidModuleSpec {
  /** The part id on the canvas. */
  name: string;
  /** A module table entry with a `window`. */
  type: string;
  position?: [number, number] | null;
}

/** A module inside the case (backend InsideModule): from the module table by `type`, or by its size. */
export interface EnclosureModuleSpec {
  /** The part id on the canvas. */
  name: string;
  type?: string | null;
  size?: [number, number] | null;
  height?: number | null;
  /** PCB lower-left corner in board coordinates; automatic when absent. */
  position?: [number, number] | null;
}

/** A module table entry: a breakout board that can go inside a case. */
export interface EnclosureModule {
  id: string;
  name: string;
  /** Canvas part types this module is. */
  part_types: string[];
  size: [number, number];
  top_height: number;
  /** A display's visible area: such a module hangs under the lid, not inside. */
  window?: { center: [number, number]; size: [number, number] } | null;
}

export type EnclosureFace = 'left' | 'right' | 'front' | 'back' | 'top' | 'bottom';

/** An opening the assistant or the user asked for (backend ExtraCutout); `name` is usually the part id. */
export interface EnclosureExtra {
  name?: string;
  face: EnclosureFace;
  shape?: 'circle' | 'rect' | 'slots';
  center_x?: number | null;
  center_y?: number | null;
  along?: number | null;
  z?: number | null;
  diameter?: number | null;
  width?: number | null;
  height?: number | null;
  slot_count?: number;
  slot_pitch?: number;
}

export interface EnclosureConnector {
  name: string;
  type: string;
  side: EnclosureFace;
  /** Window size in mm (along the side × height); null when the connector is closed off. */
  window: { width: number; height: number } | null;
}

export interface EnclosureBoard {
  id: string;
  name: string;
  canvas_kinds: string[];
  verified: boolean;
  /** Tallest component above the PCB, mm (what the case leaves room for unless the spec overrides it). */
  top_height: number;
}

/** A battery pack a compartment can hold (backend batteries.CATALOG). */
export interface EnclosureBattery {
  id: string;
  length: number;
  width: number;
  height: number;
  description: string;
}

export interface EnclosureCatalog {
  boards: EnclosureBoard[];
  batteries: EnclosureBattery[];
  modules: EnclosureModule[];
}

export interface EnclosureViolation {
  severity: 'error' | 'warning';
  check: string;
  message: string;
}

export interface EnclosureBuild {
  ok: boolean;
  violations: EnclosureViolation[];
  board: { id: string; name: string; verified: boolean };
  /** Outer box in board coordinates, mm. */
  outer: { x0: number; y0: number; x1: number; y1: number; z0: number; z1: number };
  weight_g: number;
  connectors: EnclosureConnector[];
  /** Where each module went: PCB footprint in board coordinates and height. */
  modules: Array<{ name: string; type: string; x0: number; y0: number; x1: number; y1: number; height: number; rotated: boolean }>;
  /** Where each display hangs, and its window in the lid (x0, y0, x1, y1). */
  lid_modules: Array<{ name: string; type: string; x0: number; y0: number; x1: number; y1: number; window: [number, number, number, number] }>;
  /** Where an opening can go: side walls by `along` and `z` (above the PCB top), lid and bottom by x / y. */
  faces: Record<'left' | 'right' | 'front' | 'back', { along: [number, number]; z: [number, number] }> &
    Record<'top' | 'bottom', { x: [number, number]; y: [number, number] }>;
  /** The spec with the backend's defaults filled in. */
  spec: EnclosureSpec & {
    lid: 'screw' | 'snap';
    extras: EnclosureExtra[];
    skip_connectors: string[];
    battery: string | null;
    battery_side: 'left' | 'right';
    top_height: number | null;
    modules: EnclosureModuleSpec[];
    lid_modules: EnclosureLidModuleSpec[];
  };
  /** Binary STL, base64, assembly position. */
  base_stl: string;
  lid_stl: string;
  pcb_stl: string;
  connectors_stl: string | null;
  battery_stl: string | null;
  modules_stl: string | null;
  /** Displays under the lid, in assembly position: they move with the lid. */
  lid_modules_stl: string | null;
}

/** FastAPI's detail: a sentence, pydantic's list, or the export's { message, errors }. */
async function failure(res: Response): Promise<Error> {
  const body = await res.json().catch(() => ({}));
  const detail = body?.detail;
  if (typeof detail === 'string') return new Error(detail);
  if (Array.isArray(detail)) return new Error(detail.map((d) => `${(d.loc ?? []).slice(1).join('.')}: ${d.msg}`).join('; '));
  if (detail?.message) return new Error([detail.message, ...(detail.errors ?? [])].join('; '));
  return new Error(`HTTP ${res.status}`);
}

export async function listEnclosureBoards(): Promise<EnclosureCatalog> {
  const res = await fetch(`${apiBase()}/boards`);
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function buildEnclosure(spec: EnclosureSpec): Promise<EnclosureBuild> {
  const res = await fetch(`${apiBase()}/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec, render: false, meshes: true }),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Zip with the print files: STL (lid flipped onto the bed), STEP, spec.json. */
export async function exportEnclosure(spec: EnclosureSpec): Promise<Blob> {
  const res = await fetch(`${apiBase()}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec }),
  });
  if (!res.ok) throw await failure(res);
  return res.blob();
}
