/**
 * Canvas tools for the AI assistant.
 *
 * `claude -p` runs on the host behind ai-bridge/ and calls these by name over
 * the bridge WebSocket (the tool catalogue and argument schemas live in
 * ai-bridge/tools.mjs — keep the two in sync). Every handler works through
 * the same store actions the UI uses; canvas edits go through the recorded
 * (undoable) variants so the user can Ctrl+Z what the assistant did.
 *
 * Handlers throw on bad input with a message written for the model: it says
 * what was wrong and what to call instead.
 */
import registry from '../services/ComponentRegistry';
import { createComponentFromMetadata } from '../components/DynamicComponent';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { BOARD_KIND_LABELS, isKnownBoardKind, type BoardInstance } from '../types/board';
import type { Wire } from '../types/wire';
import { readPinInfo } from '../utils/readPinInfo';
import { compileBoardForFlash, isCompiledProgramStale } from '../utils/boardCompile';
import { ensureLibraries } from '../utils/loadExample';
import { runEditorCommand } from '../lib/editorCommands';
import { useEnclosureStore } from '../store/useEnclosureStore';
import { boardKnowledge, partKnowledge } from '../validation/partsKnowledge';
import { verifyCircuitFromStore } from '../simulation/verify/verifyFromStore';
import { withLibraryDependencies } from '../utils/sketchPlan';

type Args = Record<string, unknown>;
export type AiToolHandler = (args: Args) => Promise<unknown>;

interface PinInfo {
  name: string;
  signals?: unknown;
}

const sim = () => useSimulatorStore.getState();
const editor = () => useEditorStore.getState();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Two frames: React commits the new part, then the custom element renders.
const nextPaint = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

// Keep what the assistant builds in view: refit the canvas once a burst of
// placements settles.
let fitTimer: ReturnType<typeof setTimeout> | null = null;
function fitSoon() {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    fitTimer = null;
    runEditorCommand('view.fit');
  }, 300);
}

const WIRE_COLORS: Record<string, string> = {
  red: '#ff4444',
  black: '#000000',
  blue: '#22aaff',
  green: '#22cc44',
  yellow: '#ffcc00',
  orange: '#ff8800',
  white: '#ffffff',
  purple: '#aa44ff',
  gray: '#888888',
  grey: '#888888',
};

/** A file in get_project: whole when short, else its start and how to read the rest. */
const PROJECT_FILE_CHARS = 12_000;
const PROJECT_FILE_HEAD = 3_000;
/** What one read_file call returns at most. */
const READ_MAX_LINES = 1_500;
const READ_MAX_CHARS = 60_000;

function projectFile(f: { name: string; content: string }) {
  const lines = f.content.split('\n').length;
  if (f.content.length <= PROJECT_FILE_CHARS) return { name: f.name, lines, content: f.content };
  return {
    name: f.name,
    lines,
    chars: f.content.length,
    content: f.content.slice(0, PROJECT_FILE_HEAD),
    truncated: `Only the first ${PROJECT_FILE_HEAD} of ${f.content.length} characters are shown. Read the whole file with read_file before changing it.`,
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${field}" must be a non-empty string`);
  return v.trim();
}

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function findBoard(boardId?: unknown): BoardInstance {
  const s = sim();
  const id = typeof boardId === 'string' && boardId ? boardId : (s.activeBoardId ?? s.boards[0]?.id);
  const board = s.boards.find((b) => b.id === id);
  if (board) return board;
  if (s.boards.length === 0) throw new Error('There is no board on the canvas. Call add_board first.');
  throw new Error(`No board with id "${String(boardId)}". Boards: ${s.boards.map((b) => b.id).join(', ')}`);
}

function partExists(id: string): 'board' | 'component' | null {
  const s = sim();
  if (s.boards.some((b) => b.id === id)) return 'board';
  if (s.components.some((c) => c.id === id)) return 'component';
  return null;
}

async function pinsOfPart(id: string): Promise<PinInfo[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pins = readPinInfo<PinInfo>(document.getElementById(id));
    if (pins && pins.length > 0) return pins.map(({ name, signals }) => (signals ? { name, signals } : { name }));
    await nextPaint();
  }
  return [];
}

/** Pins of a component type without placing it: render the element off-canvas. */
async function pinsOfType(tagName: string, defaults: Record<string, unknown>): Promise<PinInfo[]> {
  const el = document.createElement(tagName);
  Object.assign(el, defaults);
  let pins = readPinInfo<PinInfo>(el);
  if (!pins?.length) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden';
    host.appendChild(el);
    document.body.appendChild(host);
    try {
      await nextPaint();
      pins = readPinInfo<PinInfo>(el);
    } finally {
      host.remove();
    }
  }
  return (pins ?? []).map(({ name, signals }) => (signals ? { name, signals } : { name }));
}

function parsePinRef(ref: unknown, field: string): { partId: string; pinName: string } {
  const text = str(ref, field);
  const i = text.indexOf(':');
  if (i <= 0 || i === text.length - 1) {
    throw new Error(`"${field}" must look like "<partId>:<pinName>", got "${text}"`);
  }
  return { partId: text.slice(0, i), pinName: text.slice(i + 1) };
}

async function checkPin(partId: string, pinName: string): Promise<void> {
  if (!partExists(partId)) {
    throw new Error(`No part with id "${partId}" on the canvas. Call get_project to see the ids.`);
  }
  const pins = await pinsOfPart(partId);
  // Some parts report no pins until mounted; let the wire through rather than block.
  if (pins.length > 0 && !pins.some((p) => p.name === pinName)) {
    throw new Error(
      `"${partId}" has no pin "${pinName}". Its pins: ${pins.map((p) => p.name).join(', ')}`,
    );
  }
}

/** Short readable id ("dht22_1") — underscores keep it SPICE-safe like the UI's ids. */
function shortComponentId(metadataId: string): string {
  const prefix = metadataId.replace(/-/g, '_');
  const taken = new Set(sim().components.map((c) => c.id));
  let n = 1;
  while (taken.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

function nextComponentSlot(): { x: number; y: number } {
  const s = sim();
  const boardRight = Math.max(0, ...s.boards.map((b) => b.x + 400));
  return { x: boardRight + 80, y: 40 + s.components.length * 150 };
}

function projectSummary() {
  const s = sim();
  const ed = editor();
  return {
    activeBoardId: s.activeBoardId,
    boards: s.boards.map((b) => ({
      id: b.id,
      kind: b.boardKind,
      label: BOARD_KIND_LABELS[b.boardKind] ?? b.boardKind,
      x: Math.round(b.x),
      y: Math.round(b.y),
      running: b.running,
      languageMode: b.languageMode,
      libraries: b.libraries ?? [],
      files: ed.getGroupFiles(b.activeFileGroupId).map(projectFile),
    })),
    components: s.components.map((c) => ({
      id: c.id,
      type: c.metadataId,
      x: Math.round(c.x),
      y: Math.round(c.y),
      properties: Object.fromEntries(
        Object.entries(c.properties ?? {}).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 200) : v]),
      ),
    })),
    wires: s.wires.map((w) => ({
      id: w.id,
      from: `${w.start.componentId}:${w.start.pinName}`,
      to: `${w.end.componentId}:${w.end.pinName}`,
      color: w.color,
    })),
  };
}

function findCanvas(root: Element | ShadowRoot): HTMLCanvasElement | null {
  for (const node of Array.from(root.querySelectorAll('*'))) {
    if (node instanceof HTMLCanvasElement) return node;
    if (node.shadowRoot) {
      const inner = findCanvas(node.shadowRoot);
      if (inner) return inner;
    }
  }
  return null;
}

/** A display's framebuffer as ASCII: '#' where any pixel of a cell is lit. */
function canvasAscii(canvas: HTMLCanvasElement, maxCols = 64) {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  const lit = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return data[i] + data[i + 1] + data[i + 2] > 300;
  };
  const cellW = Math.max(1, Math.ceil(w / maxCols));
  const cellH = cellW * 2; // terminal cells are about twice as tall as wide
  let litPixels = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lit(x, y)) litPixels++;
  const rows: string[] = [];
  for (let cy = 0; cy < h; cy += cellH) {
    let row = '';
    for (let cx = 0; cx < w; cx += cellW) {
      let on = false;
      for (let y = cy; y < Math.min(h, cy + cellH) && !on; y++) {
        for (let x = cx; x < Math.min(w, cx + cellW) && !on; x++) on = lit(x, y);
      }
      row += on ? '#' : '.';
    }
    rows.push(row);
  }
  return { width: w, height: h, litPixels, ascii: rows.join('\n') };
}

const VISUAL_STATE_KEYS = ['value', 'brightness', 'color', 'ledRed', 'ledGreen', 'ledBlue', 'angle', 'pressed', 'values'];

async function compileBoard(board: BoardInstance) {
  if (board.languageMode === 'micropython') {
    return { boardId: board.id, success: true, note: 'MicroPython boards run without compiling.' };
  }
  await ensureLibraries(board.libraries ?? []);
  const lines: string[] = [];
  const out = await compileBoardForFlash(board, (line) => lines.push(line), { initiatedBy: 'agent' });
  if (out.ok) return { boardId: board.id, success: true, elapsedMs: Math.round(out.elapsedMs) };
  // Compiler diagnostics only ("file:12:5: error: …", linker errors) — not the
  // ninja/ccache lines whose object paths merely contain the word "error".
  const errorLines = [
    ...new Set(
      lines.filter(
        (l) => /:\d+(:\d+)?: (fatal )?(error|warning):|undefined reference|ld returned/.test(l) && !/^(\[\d+\/\d+\]|ccache )/.test(l),
      ),
    ),
  ];
  return {
    boardId: board.id,
    success: false,
    // The backend's own error can be a raw compiler command line; the first
    // diagnostic says more.
    error: errorLines[0] ?? out.error,
    ...(errorLines.length
      ? { errors: clip(errorLines.join('\n'), 4000) }
      : { logTail: clip(lines.slice(-30).join('\n'), 3000) }),
  };
}

export const AI_TOOLS: Record<string, AiToolHandler> = {
  async get_project() {
    return projectSummary();
  },

  async list_part_types({ query }) {
    await registry.loadPromise;
    const boards = Object.entries(BOARD_KIND_LABELS).map(([kind, label]) => ({ kind, label }));
    if (typeof query !== 'string' || !query.trim()) {
      return {
        categories: registry.getCategories().map((c) => ({ category: c, count: registry.getByCategory(c).length })),
        boards,
        hint: 'Pass a query (e.g. "temperature", "oled", "button") to list matching part types.',
      };
    }
    const q = query.trim().toLowerCase();
    return {
      parts: registry.search(q).slice(0, 30).map((m) => ({
        type: m.id,
        name: m.name,
        category: m.category,
        description: m.description ? clip(m.description, 140) : undefined,
      })),
      boards: boards.filter((b) => b.kind.includes(q) || b.label.toLowerCase().includes(q)),
    };
  },

  async get_pins({ type }) {
    const id = str(type, 'type');
    const kind = partExists(id);
    if (kind === 'board') {
      const board = sim().boards.find((b) => b.id === id)!;
      return { id, kind: board.boardKind, pins: await pinsOfPart(id), board: boardKnowledge(board.boardKind) };
    }
    if (kind === 'component') {
      const comp = sim().components.find((c) => c.id === id)!;
      return { id, type: comp.metadataId, pins: await pinsOfPart(id), info: partKnowledge(comp.metadataId) };
    }
    if (isKnownBoardKind(id)) {
      const placed = sim().boards.find((b) => b.boardKind === id);
      if (placed) return { id: placed.id, kind: id, pins: await pinsOfPart(placed.id), board: boardKnowledge(id) };
      throw new Error(`Board pins are read from the canvas: call add_board("${id}") first, then get_pins with its id.`);
    }
    await registry.loadPromise;
    const meta = registry.getById(id);
    if (!meta) throw new Error(`Unknown part type "${id}". Use list_part_types to find the type id.`);
    const pins = await pinsOfType(meta.tagName, meta.defaultValues ?? {});
    const info = partKnowledge(meta.id);
    if (pins.length === 0) {
      return { type: meta.id, pins: [], info, note: 'This part reports its pins only once placed: add_component, then get_pins with its id.' };
    }
    return { type: meta.id, name: meta.name, pins, info };
  },

  async add_board({ kind, x, y }) {
    const k = str(kind, 'kind');
    if (!isKnownBoardKind(k)) {
      throw new Error(`Unknown board kind "${k}". Known kinds: ${Object.keys(BOARD_KIND_LABELS).join(', ')}`);
    }
    const s = sim();
    const defaultX = s.boards.length ? Math.max(...s.boards.map((b) => b.x)) + 500 : 50;
    const id = s.addBoard(k, optNum(x) ?? defaultX, optNum(y) ?? 50);
    fitSoon();
    return { id, kind: k, pins: await pinsOfPart(id) };
  },

  async add_component({ type, x, y, properties }) {
    const t = str(type, 'type');
    await registry.loadPromise;
    const meta = registry.getById(t);
    if (!meta) throw new Error(`Unknown part type "${t}". Use list_part_types to find the type id.`);
    const slot = nextComponentSlot();
    const component = createComponentFromMetadata(meta, optNum(x) ?? slot.x, optNum(y) ?? slot.y);
    component.id = shortComponentId(meta.id);
    if (properties && typeof properties === 'object') Object.assign(component.properties, properties);
    sim().recordAddComponent(component);
    fitSoon();
    return { id: component.id, type: meta.id, pins: await pinsOfPart(component.id) };
  },

  async update_component({ id, properties, x, y }) {
    const cid = str(id, 'id');
    const s = sim();
    const comp = s.components.find((c) => c.id === cid);
    if (!comp) throw new Error(`No component with id "${cid}".`);
    if (properties && typeof properties === 'object') {
      for (const [key, next] of Object.entries(properties as Record<string, unknown>)) {
        s.recordSetProperty(cid, key, comp.properties?.[key], next);
      }
    }
    const nx = optNum(x);
    const ny = optNum(y);
    if (nx !== undefined || ny !== undefined) {
      s.recordMove(cid, { x: comp.x, y: comp.y }, { x: nx ?? comp.x, y: ny ?? comp.y });
    }
    return { id: cid, updated: true };
  },

  async remove_part({ id }) {
    const pid = str(id, 'id');
    const kind = partExists(pid);
    if (kind === 'board') sim().removeBoard(pid);
    else if (kind === 'component') sim().recordRemoveComponent(pid);
    else throw new Error(`No part with id "${pid}".`);
    return { removed: pid };
  },

  async connect({ from, to, color }) {
    const a = parsePinRef(from, 'from');
    const b = parsePinRef(to, 'to');
    await checkPin(a.partId, a.pinName);
    await checkPin(b.partId, b.pinName);
    const c = typeof color === 'string' && color ? (WIRE_COLORS[color.toLowerCase()] ?? color) : '#22aaff';
    const wire: Wire = {
      id: `wire_ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      start: { componentId: a.partId, pinName: a.pinName, x: 0, y: 0 },
      end: { componentId: b.partId, pinName: b.pinName, x: 0, y: 0 },
      waypoints: [],
      color: c,
      // The system owns the shape: recalculateAllWirePositions routes it
      // around parts and beside the other wires instead of the default
      // elbow, which stacked every wire of a module on one line.
      autoRouted: true,
    };
    sim().recordAddWire(wire);
    await nextPaint();
    sim().recalculateAllWirePositions();
    fitSoon();
    return { wireId: wire.id, from: `${a.partId}:${a.pinName}`, to: `${b.partId}:${b.pinName}` };
  },

  async disconnect({ wireId }) {
    const id = str(wireId, 'wireId');
    if (!sim().wires.some((w) => w.id === id)) throw new Error(`No wire with id "${id}".`);
    sim().recordRemoveWire(id);
    return { removed: id };
  },

  async read_file({ boardId, name, startLine, maxLines }) {
    const board = findBoard(boardId);
    const fileName = str(name, 'name');
    const file = editor().getGroupFiles(board.activeFileGroupId).find((f) => f.name === fileName);
    if (!file) {
      const names = editor().getGroupFiles(board.activeFileGroupId).map((f) => f.name);
      throw new Error(`Board "${board.id}" has no file "${fileName}". Its files: ${names.join(', ') || 'none'}`);
    }
    const all = file.content.split('\n');
    const from = Math.max(1, Math.floor(optNum(startLine) ?? 1));
    const want = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(optNum(maxLines) ?? READ_MAX_LINES)));
    const out: string[] = [];
    let chars = 0;
    for (let i = from - 1; i < all.length && out.length < want; i++) {
      if (out.length && chars + all[i].length + 1 > READ_MAX_CHARS) break;
      out.push(all[i]);
      chars += all[i].length + 1;
    }
    const endLine = from + out.length - 1;
    return {
      boardId: board.id,
      file: fileName,
      totalLines: all.length,
      startLine: from,
      endLine,
      content: out.join('\n'),
      ...(endLine < all.length ? { more: `Lines ${endLine + 1}–${all.length} follow: call read_file with startLine ${endLine + 1}.` } : {}),
    };
  },

  async edit_file({ boardId, name, oldText, newText, replaceAll }) {
    const board = findBoard(boardId);
    const fileName = str(name, 'name');
    if (typeof oldText !== 'string' || !oldText) throw new Error('"oldText" must be the exact text to replace');
    if (typeof newText !== 'string') throw new Error('"newText" must be a string');
    const gid = board.activeFileGroupId;
    const ed = editor();
    const file = ed.getGroupFiles(gid).find((f) => f.name === fileName);
    if (!file) throw new Error(`Board "${board.id}" has no file "${fileName}" — create it with write_file`);
    const count = file.content.split(oldText).length - 1;
    if (count === 0) throw new Error('oldText was not found in the file. Copy it exactly from read_file (spaces and line breaks included).');
    if (count > 1 && replaceAll !== true) {
      throw new Error(`oldText occurs ${count} times. Add surrounding lines to make it unique, or pass replaceAll: true.`);
    }
    const content = replaceAll === true ? file.content.split(oldText).join(newText) : file.content.replace(oldText, () => newText);
    if (ed.activeGroupId === gid) ed.setFileContent(file.id, content);
    else ed.setGroupFileContent(gid, file.id, content);
    return { boardId: board.id, file: fileName, replaced: replaceAll === true ? count : 1, chars: content.length };
  },

  async write_file({ boardId, name, content }) {
    const board = findBoard(boardId);
    const fileName = str(name, 'name');
    if (typeof content !== 'string') throw new Error('"content" must be a string');
    const gid = board.activeFileGroupId;
    const ed = editor();
    const existing = ed.getGroupFiles(gid).find((f) => f.name === fileName);
    if (!existing) ed.addFileToGroup(gid, { name: fileName, content });
    else if (ed.activeGroupId === gid) ed.setFileContent(existing.id, content);
    else ed.setGroupFileContent(gid, existing.id, content);
    return { boardId: board.id, file: fileName, chars: content.length, created: !existing };
  },

  async set_libraries({ boardId, libraries }) {
    const board = findBoard(boardId);
    if (!Array.isArray(libraries) || libraries.some((l) => typeof l !== 'string')) {
      throw new Error('"libraries" must be an array of library names');
    }
    const requested = [...new Set(libraries.map((l) => l.trim()).filter(Boolean))];
    // ESP32 builds merge only manifest-listed libraries: list dependencies too.
    const libs = await withLibraryDependencies(requested);
    sim().updateBoard(board.id, { libraries: libs });
    return { boardId: board.id, libraries: libs };
  },

  async validate_circuit() {
    const result = await verifyCircuitFromStore();
    const brief = (w: { code: string; message: string; componentId?: string }) => ({
      code: w.code,
      part: w.componentId,
      message: w.message,
    });
    return {
      errors: (result?.errors ?? []).map(brief),
      warnings: (result?.warnings ?? []).map(brief),
      ok: (result?.errors.length ?? 0) === 0,
    };
  },

  async compile({ boardId }) {
    return compileBoard(findBoard(boardId));
  },

  async run_simulation() {
    const s = sim();
    if (s.boards.length === 0) throw new Error('There is no board on the canvas.');
    for (const board of s.boards) {
      if (board.languageMode === 'micropython') continue;
      if (!board.compiledProgram || isCompiledProgramStale(board)) {
        const result = await compileBoard(board);
        if (!result.success) return { started: false, compile: result };
      }
    }
    for (const board of sim().boards) if (!board.running) sim().startBoard(board.id);
    for (let i = 0; i < 30 && !sim().boards.every((b) => b.running); i++) await sleep(100);
    return { started: true, running: sim().boards.filter((b) => b.running).map((b) => b.id) };
  },

  async stop_simulation() {
    const running = sim().boards.filter((b) => b.running);
    for (const board of running) sim().stopBoard(board.id);
    return { stopped: running.map((b) => b.id) };
  },

  async inspect_part({ id }) {
    const pid = str(id, 'id');
    if (!partExists(pid)) throw new Error(`No part with id "${pid}". Call get_project to see the ids.`);
    const el = document.getElementById(pid);
    if (!el) throw new Error(`"${pid}" is not rendered on the canvas right now.`);
    const state: Record<string, unknown> = {};
    for (const key of VISUAL_STATE_KEYS) {
      const v = (el as unknown as Record<string, unknown>)[key];
      if (v !== undefined && typeof v !== 'function') state[key] = v;
    }
    const canvas = findCanvas(el.shadowRoot ?? el) ?? (el instanceof HTMLCanvasElement ? el : null);
    return { id: pid, state, display: canvas ? canvasAscii(canvas) : undefined };
  },

  async get_enclosure() {
    const { spec, build, error, loading } = useEnclosureStore.getState();
    if (!spec) return { exists: false, hint: 'No enclosure in this project yet: make one with build_enclosure.' };
    return {
      exists: true,
      // The latest spec: what the assistant built or what the user applied in the enclosure dialog.
      spec,
      ...(error ? { lastBuildError: error } : {}),
      ...(build
        ? {
            // From the last successful build, which is this spec unless `builtFromThisSpec` is false.
            builtFromThisSpec: !error && !loading,
            ok: build.ok,
            violations: build.violations,
            outerSizeMm: [build.outer.x1 - build.outer.x0, build.outer.y1 - build.outer.y0, build.outer.z1 - build.outer.z0].map(
              (v) => Math.round(v * 10) / 10,
            ),
            connectors: build.connectors,
            modules: build.modules,
            lidModules: build.lid_modules,
            faces: build.faces,
          }
        : {}),
    };
  },

  async read_serial({ boardId, waitMs, maxChars }) {
    await sleep(optNum(waitMs) ?? 3000);
    const board = findBoard(boardId);
    const output = board.serialOutput ?? '';
    return {
      boardId: board.id,
      running: board.running,
      output: output.slice(-(optNum(maxChars) ?? 4000)),
      totalChars: output.length,
    };
  },
};

export async function runAiTool(name: string, args: Args): Promise<unknown> {
  const handler = AI_TOOLS[name];
  if (!handler) throw new Error(`Unknown tool "${name}"`);
  return handler(args ?? {});
}
