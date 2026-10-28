/**
 * Browser autosave for self-hosted builds: the workspace (the lossless .vlx
 * snapshot — boards, parts, wires, code, libraries, the enclosure) is written to
 * localStorage a moment after every change and when the tab closes, and put
 * back when a plain /editor page loads. A reload or a closed tab no longer
 * loses work; "New workspace" starts over (and that empty state is what
 * gets saved next).
 *
 * Unlike workspaceDraft.ts (a one-shot stash for the login round-trip), this
 * runs continuously. Server-side project saves (pro overlay) are untouched.
 */
import type { BoardInstance } from '../types/board';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useEnclosureStore } from '../store/useEnclosureStore';
import { buildVlxPayload, type VlxPayload } from './vlxFile';

const KEY = 'velxio.autosave.v1';
const DEBOUNCE_MS = 1000;

interface Saved {
  savedAt: string;
  payload: VlxPayload;
}

function read(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

/** Whether an autosaved workspace with something on it is waiting. */
export function hasLocalAutosave(): boolean {
  const saved = read();
  return !!saved && (saved.payload.boards?.length ?? 0) + (saved.payload.components?.length ?? 0) > 0;
}

/**
 * Load the autosaved workspace into the stores. Skips when a named project
 * is loaded. Returns whether it restored.
 */
export function restoreLocalAutosave(): boolean {
  if (useProjectStore.getState().currentProject) return false;
  const saved = read();
  if (!saved || !hasLocalAutosave()) return false;
  try {
    const { payload } = saved;
    if (payload.workspaceId) useProjectStore.getState().setWorkspaceId(payload.workspaceId);
    useSimulatorStore.getState().loadProjectState({
      boards: payload.boards as unknown as BoardInstance[],
      fileGroups: payload.fileGroups,
      folderGroups: payload.folderGroups,
      components: payload.components,
      wires: payload.wires,
      activeBoardId: payload.activeBoardId,
    });
    useEnclosureStore.getState().restore(payload.enclosure ?? null);
    return true;
  } catch (err) {
    console.warn('[autosave] could not restore the saved workspace:', err);
    return false;
  }
}

function save(): void {
  try {
    const saved: Saved = { savedAt: new Date().toISOString(), payload: buildVlxPayload() };
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch (err) {
    // Quota exceeded or storage disabled: keep working, just unsaved.
    console.warn('[autosave] could not save the workspace:', err);
  }
}

/**
 * Save on every circuit / code change (debounced) and on tab close.
 * Returns the unsubscribe.
 */
export function startLocalAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      save();
    }, DEBOUNCE_MS);
  };
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    save();
  };

  // Only what a project is made of. The boards array is replaced on every
  // serial chunk while a simulation runs, so boards are compared by the
  // fields the snapshot keeps, not by identity.
  const boardsKey = (boards: BoardInstance[]) =>
    boards
      .map((b) => [b.id, b.boardKind, b.name, b.x, b.y, b.rotation, b.languageMode, b.activeFileGroupId, (b.libraries ?? []).join(',')].join('|'))
      .join(';');
  let lastBoards = boardsKey(useSimulatorStore.getState().boards);
  const offSim = useSimulatorStore.subscribe((s, prev) => {
    const key = s.boards !== prev.boards ? boardsKey(s.boards) : lastBoards;
    if (key !== lastBoards || s.components !== prev.components || s.wires !== prev.wires || s.activeBoardId !== prev.activeBoardId) {
      lastBoards = key;
      schedule();
    }
  });
  const offEditor = useEditorStore.subscribe((s, prev) => {
    if (s.fileGroups !== prev.fileGroups || s.folderGroups !== prev.folderGroups) schedule();
  });
  const offEnclosure = useEnclosureStore.subscribe((s, prev) => {
    if (s.spec !== prev.spec) schedule();
  });
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);

  return () => {
    flush();
    offSim();
    offEditor();
    offEnclosure();
    window.removeEventListener('beforeunload', flush);
    window.removeEventListener('pagehide', flush);
  };
}
