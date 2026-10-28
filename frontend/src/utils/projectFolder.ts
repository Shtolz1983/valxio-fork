/**
 * "Save project" into a folder the user picks (File System Access API:
 * Chrome, Edge). The project goes into its own folder there:
 *
 *   weather-station/
 *     weather-station.vlx        the whole workspace, what "Open project" reads
 *     arduino-uno/
 *       arduino-uno.ino          a board's main sketch (sketch.ino in the IDE)
 *       dht.h, …                 its other files as they are
 *     esp32/ …
 *     enclosure/               the 3D-printable case, when the project has one:
 *       base.stl, lid.stl      ready to slice (the lid flipped onto the bed)
 *       hatch.stl              the battery hatch, when the case has one
 *       base.step, lid.step …  for a CAD program
 *
 * Each board folder is an Arduino sketch folder (the main .ino is named after
 * its folder), so it opens in the Arduino IDE as is. Nothing is written before
 * the user has seen which existing files it would replace (findConflicts);
 * a file already holding the same text is no conflict.
 *
 * Browsers without the API (Safari, Firefox) keep the old path: a .vlx
 * download (vlxFile.ts).
 */
import JSZip from 'jszip';
import { exportEnclosure, type EnclosureSpec } from '../services/enclosureService';
import { buildVlxPayload, safeProjectName, type VlxPayload } from './vlxFile';

export interface PlannedFile {
  /** Path inside the project folder, by segments. */
  path: string[];
  /** Text, or the bytes of a binary file (STL). */
  content: string | Uint8Array<ArrayBuffer>;
}

export interface FolderTarget {
  /** The folder the user picked. */
  picked: FileSystemDirectoryHandle;
  /** The project folder's name inside it, or null when the picked folder is the project folder. */
  sub: string | null;
}

export interface Conflict {
  path: string;
}

interface PickerWindow {
  showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
}

export function canSaveToFolder(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as PickerWindow).showDirectoryPicker === 'function';
}

/** The files a project is saved as, from the workspace (or a given snapshot). */
export function planProjectFiles(name: string, payload: VlxPayload = buildVlxPayload({ name })): PlannedFile[] {
  const base = safeProjectName(name);
  const files: PlannedFile[] = [{ path: [`${base}.vlx`], content: JSON.stringify(payload, null, 2) }];
  for (const board of payload.boards) {
    const folder = safeProjectName(board.id);
    for (const f of payload.fileGroups[board.activeFileGroupId] ?? []) {
      // The Arduino IDE opens a folder whose main sketch carries its name.
      const fileName = f.name === 'sketch.ino' ? `${folder}.ino` : f.name;
      files.push({ path: [folder, ...fileName.split('/').filter(Boolean)], content: f.content });
    }
  }
  return files;
}

/**
 * The enclosure's print files under enclosure/, from the backend's export zip
 * (its spec.json is left out: the spec travels in the .vlx). The backend
 * refuses a case that fails its checks; `error` then says why, and the rest of
 * the project is saved without them.
 */
export async function planEnclosureFiles(spec: EnclosureSpec | null): Promise<{ files: PlannedFile[]; error?: string }> {
  if (!spec) return { files: [] };
  try {
    const zip = await JSZip.loadAsync(await (await exportEnclosure(spec)).arrayBuffer());
    const files: PlannedFile[] = [];
    for (const name of ['base.stl', 'lid.stl', 'hatch.stl', 'base.step', 'lid.step', 'hatch.step']) {
      const entry = zip.file(name);
      if (entry) files.push({ path: ['enclosure', name], content: new Uint8Array(await entry.async('arraybuffer')) });
    }
    return { files };
  } catch (err) {
    return { files: [], error: (err as Error).message };
  }
}

/**
 * Ask for the folder to save into. Picking the project folder itself (one
 * named like the project) saves into it; any other folder gets the project
 * folder inside it. Resolves null when the user closes the picker.
 */
export async function pickTarget(name: string): Promise<FolderTarget | null> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('This browser cannot save into a chosen folder.');
  let picked: FileSystemDirectoryHandle;
  try {
    picked = await picker.call(window, { id: 'velxio-projects', mode: 'readwrite', startIn: 'documents' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
  const base = safeProjectName(name);
  return { picked, sub: picked.name === base ? null : base };
}

/** Where the project folder is, for messages: "Projects/weather-station". */
export function targetLabel(t: FolderTarget): string {
  return t.sub ? `${t.picked.name}/${t.sub}` : t.picked.name;
}

async function dirIfExists(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

async function readIfExists(dir: FileSystemDirectoryHandle, path: string[], binary: boolean): Promise<string | Uint8Array | null> {
  let d: FileSystemDirectoryHandle | null = dir;
  for (const seg of path.slice(0, -1)) {
    d = await dirIfExists(d, seg);
    if (!d) return null;
  }
  try {
    const file = await (await d.getFileHandle(path[path.length - 1])).getFile();
    return binary ? new Uint8Array(await file.arrayBuffer()) : await file.text();
  } catch {
    return null;
  }
}

/** A .vlx differs on every save by its export time, which is not the project. */
function sameText(text: string): string {
  return text.replace(/^\s*"exportedAt": "[^"]*",?\n/m, '');
}

function sameContent(existing: string | Uint8Array, planned: PlannedFile['content']): boolean {
  if (typeof planned === 'string') return typeof existing === 'string' && sameText(existing) === sameText(planned);
  return existing instanceof Uint8Array && existing.length === planned.length && existing.every((b, i) => b === planned[i]);
}

/** The files the save would replace with different content, without writing anything. */
export async function findConflicts(t: FolderTarget, files: PlannedFile[]): Promise<Conflict[]> {
  const root = t.sub ? await dirIfExists(t.picked, t.sub) : t.picked;
  if (!root) return [];
  const out: Conflict[] = [];
  for (const f of files) {
    const existing = await readIfExists(root, f.path, typeof f.content !== 'string');
    if (existing !== null && !sameContent(existing, f.content)) out.push({ path: f.path.join('/') });
  }
  return out;
}

export async function writeProject(t: FolderTarget, files: PlannedFile[]): Promise<void> {
  const root = t.sub ? await t.picked.getDirectoryHandle(t.sub, { create: true }) : t.picked;
  for (const f of files) {
    let d = root;
    for (const seg of f.path.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
    const handle = await d.getFileHandle(f.path[f.path.length - 1], { create: true });
    const w = await handle.createWritable();
    await w.write(f.content);
    await w.close();
  }
}
