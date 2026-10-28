// Enclosure tools: the assistant picks the parameters of a 3D-printable case
// for the board on the canvas, the Velxio backend (/api/enclosure) builds the
// geometry and checks it. The tool answer carries the 8-view render as an
// image, so the model looks at the case it made before it reports.
import { TOOL_IMAGES } from './apiAgent.mjs';

const BUILD_TIMEOUT_MS = 60_000;

/** A failed backend answer as one sentence: a plain detail, pydantic's list, or the export's {message, errors}. */
export function backendError(status, body) {
  const detail = body?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((d) => `${(d.loc ?? []).filter((p) => p !== 'body').join('.') || 'spec'}: ${d.msg}`).join('; ');
  }
  if (detail?.message) return [detail.message, ...(detail.errors ?? [])].join('; ');
  return `HTTP ${status}`;
}

async function call(velxioUrl, route, init = {}) {
  const res = await fetch(`${velxioUrl}/api/enclosure${route}`, { ...init, signal: AbortSignal.timeout(BUILD_TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(backendError(res.status, body));
  return body;
}

/** The boards with what the model needs to place openings (size, mount, connectors), the battery packs and the module table. */
export async function listEnclosureBoards(velxioUrl) {
  const { boards, batteries, modules = [] } = await call(velxioUrl, '/boards');
  const boardList = boards.map((b) => ({
    id: b.id,
    name: b.name,
    canvasKinds: b.canvas_kinds,
    verified: b.verified,
    notes: b.notes,
    size: b.size,
    topHeight: b.top_height,
    mount: b.mount,
    connectors: b.connectors.map(({ name, type, side, center, z }) => ({ name, type, side, center, z })),
  }));
  const moduleList = modules.map((m) => ({
    id: m.id,
    name: m.name,
    partTypes: m.part_types,
    size: m.size,
    height: m.top_height,
    // a display: it hangs under the lid behind a window (lid_modules), not inside
    ...(m.window ? { underLid: true, visibleArea: m.window.size } : {}),
  }));
  return { boards: boardList, batteries, modules: moduleList };
}

export async function buildEnclosure(velxioUrl, spec) {
  const r = await call(velxioUrl, '/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Meshes are for the IDE's 3D viewer, not for the model.
    body: JSON.stringify({ spec, render: true, meshes: false }),
  });
  const { x0, y0, x1, y1, z0, z1 } = r.outer;
  return {
    ok: r.ok,
    violations: r.violations,
    board: r.board,
    outerSizeMm: [x1 - x0, y1 - y0, z1 - z0].map((v) => Math.round(v * 10) / 10),
    weightG: r.weight_g,
    faces: r.faces,
    modules: r.modules,
    lidModules: r.lid_modules,
    [TOOL_IMAGES]: r.render_png ? [{ mediaType: 'image/png', data: r.render_png }] : [],
  };
}
