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
} & Record<string, unknown>;

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
  };
  /** Binary STL, base64, assembly position. */
  base_stl: string;
  lid_stl: string;
  pcb_stl: string;
  connectors_stl: string | null;
  battery_stl: string | null;
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
