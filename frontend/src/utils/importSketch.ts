/**
 * "Open sketch": load an Arduino sketch from disk (.ino plus its .h / .cpp
 * tabs) into a board, and declare + install the libraries its #includes need.
 *
 * The pure planning lives in ./sketchPlan.ts; this file wires it to the stores.
 */
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { showConfirmDialog, showMessageDialog } from '../store/useMessageDialogStore';
import { useAiStore } from '../store/useAiStore';
import { ensureLibraries } from './loadExample';
import {
  NoInoFileError,
  planSketchImport,
  resolveSketchLibraries,
  withLibraryDependencies,
  type SketchPlan,
  type SketchSourceFile,
} from './sketchPlan';
import type { BoardKind } from '../types/board';
import { i18n } from '../i18n';

const tr = (key: string, defaultValue: string, vars: Record<string, unknown> = {}) =>
  i18n.t(`openSketch.${key}`, { defaultValue, ...vars });

/** A board for the sketch when the canvas has none: ESP32 for ESP code, else an Uno. */
function boardKindFor(code: string): BoardKind {
  // Serial.printf exists on the ESP32 core, not on AVR.
  return /\bWiFi\.h\b|\bESP32\b|\besp_|\bBluetoothSerial\b|\bledcWrite\b|\bSerial\.printf\b/.test(code) ? 'esp32' : 'arduino-uno';
}

async function readSources(fileList: FileList | File[]): Promise<SketchSourceFile[]> {
  return Promise.all(
    [...fileList].map(async (f) => ({
      name: f.name,
      content: await f.text(),
      path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || undefined,
    })),
  );
}

/**
 * Store-wired import into the active board (one is placed when the canvas is
 * empty). Asks before replacing a sketch that has content. Returns false when
 * the user cancelled.
 */
export async function importSketchFiles(fileList: FileList | File[]): Promise<boolean> {
  let plan: SketchPlan;
  try {
    plan = planSketchImport(await readSources(fileList));
  } catch (err) {
    const message = err instanceof NoInoFileError ? tr('noIno', err.message) : err instanceof Error ? err.message : String(err);
    showMessageDialog(message, { kind: 'error', title: tr('title', 'Open sketch') });
    return false;
  }

  const sim = useSimulatorStore.getState();
  let board = sim.boards.find((b) => b.id === sim.activeBoardId) ?? sim.boards[0];
  if (board) {
    const current = useEditorStore.getState().getGroupFiles(board.activeFileGroupId);
    if (current.some((f) => f.content.trim())) {
      const ok = await showConfirmDialog(
        tr('confirm', 'Replace the code of {{board}} with {{file}} (+{{extra}} file(s))? The circuit stays as it is.', {
          board: board.id,
          file: plan.mainName,
          extra: plan.files.length - 1,
        }),
        {
          title: tr('title', 'Open sketch'),
          confirmLabel: tr('replace', 'Replace'),
          cancelLabel: tr('cancel', 'Cancel'),
          danger: true,
        },
      );
      if (!ok) return false;
    }
  } else {
    const id = sim.addBoard(boardKindFor(plan.files.map((f) => f.content).join('\n')), 50, 50);
    board = useSimulatorStore.getState().boards.find((b) => b.id === id)!;
  }

  useSimulatorStore.getState().stopBoard(board.id);
  if (board.languageMode === 'micropython') useSimulatorStore.getState().setBoardLanguageMode(board.id, 'arduino');
  useSimulatorStore.getState().setActiveBoardId(board.id);
  const editor = useEditorStore.getState();
  editor.setActiveGroup(board.activeFileGroupId);
  editor.loadFiles(plan.files);

  const resolved = await resolveSketchLibraries(plan.includes);
  const { unresolved } = resolved;
  const libraries = await withLibraryDependencies(resolved.libraries);
  const declared = [...new Set([...(board.libraries ?? []), ...libraries])];
  useSimulatorStore.getState().updateBoard(board.id, { libraries: declared });
  await ensureLibraries(libraries);

  const lines = [
    tr('loaded', 'Loaded {{file}} as sketch.ino (+{{extra}} file(s)) into {{board}}.', {
      file: plan.mainName,
      extra: plan.files.length - 1,
      board: board.id,
    }),
  ];
  if (libraries.length) lines.push(tr('libraries', 'Libraries: {{list}}.', { list: libraries.join(', ') }));
  if (unresolved.length) {
    lines.push(tr('unresolved', 'No library found for: {{list}} — install them from the Library Manager.', { list: unresolved.join(', ') }));
  }
  if (plan.skipped.length) lines.push(tr('skipped', 'Skipped (not sketch files): {{list}}.', { list: plan.skipped.join(', ') }));
  lines.push(tr('buildHint', 'The AI assistant can place and wire the parts this sketch uses.'));
  const build = await showConfirmDialog(lines.join('\n'), {
    kind: unresolved.length ? 'info' : 'success',
    title: tr('title', 'Open sketch'),
    confirmLabel: tr('buildCircuit', 'Build the circuit from the sketch'),
    cancelLabel: tr('close', 'Close'),
  });
  if (build) buildCircuitFromSketch(board.id);
  return true;
}

/**
 * Ask the AI assistant to place and wire the parts the board's sketch uses,
 * without touching the code (see "Building a circuit for an existing sketch"
 * in ai-bridge/system-prompt.md).
 */
export function buildCircuitFromSketch(boardId: string): void {
  useAiStore.getState().openAndSend(
    tr(
      'buildPrompt',
      'Build the circuit for the sketch on board {{board}}: place every part the code uses and wire it to the pins the code uses. Do not change the code. If a pin in the code cannot work for its part, tell me instead of rewiring it.',
      { board: boardId },
    ),
  );
}

export { SKETCH_FILE_ACCEPT } from './sketchPlan';
