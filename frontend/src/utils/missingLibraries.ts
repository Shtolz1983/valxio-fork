/**
 * Install libraries a failed compile asked for (services/compilation.ts calls
 * this when the build log names headers no installed library provides).
 *
 *   header → library (sketchPlan.resolveSketchLibraries) + its dependencies
 *   → ask the user (unless "install automatically" is on, or the AI assistant
 *   compiled) → install → add to the manifest of every board whose code
 *   includes those headers → the caller recompiles.
 */
import { setMissingLibraryHandler } from '../services/compilation';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryPrefsStore } from '../store/useLibraryPrefsStore';
import { showConfirmDialog, showMessageDialog } from '../store/useMessageDialogStore';
import { installLibrary } from '../services/libraryService';
import { resolveSketchLibraries, withLibraryDependencies } from './sketchPlan';
import { i18n } from '../i18n';

const tr = (key: string, defaultValue: string, vars: Record<string, unknown> = {}) =>
  i18n.t(`missingLibraries.${key}`, { defaultValue, ...vars });

// One prompt at a time: a Run that compiles several boards must not stack dialogs.
let inFlight: Promise<string[] | null> | null = null;

async function handle(headers: string[], context: { initiatedBy?: 'agent' }): Promise<string[] | null> {
  const resolved = await resolveSketchLibraries(headers);
  if (resolved.libraries.length === 0) return null;
  const libraries = await withLibraryDependencies(resolved.libraries);

  const auto = context.initiatedBy === 'agent' || useLibraryPrefsStore.getState().autoInstallMissing;
  if (!auto) {
    const ok = await showConfirmDialog(
      tr(
        'confirm',
        'The sketch needs libraries that are not installed:\n{{list}}\n\nInstall them and compile again? (Edit → "Install missing libraries automatically" skips this question.)',
        { list: libraries.join(', ') },
      ),
      {
        title: tr('title', 'Missing libraries'),
        confirmLabel: tr('install', 'Install and compile'),
        cancelLabel: tr('cancel', 'Cancel'),
      },
    );
    if (!ok) return null;
  }

  const failed: string[] = [];
  for (const name of libraries) {
    try {
      const res = await installLibrary(name);
      if (!res?.success) failed.push(name);
    } catch {
      failed.push(name);
    }
  }
  const installed = libraries.filter((l) => !failed.includes(l));
  if (failed.length) {
    showMessageDialog(tr('failed', 'Could not install: {{list}}. Try the Library Manager.', { list: failed.join(', ') }), {
      kind: 'error',
      title: tr('title', 'Missing libraries'),
    });
  }

  // Declare them on the boards whose code includes these headers, so ESP32
  // builds (which merge only declared libraries) and saved projects keep them.
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();
  const includeRe = new RegExp(`#\\s*include\\s*[<"](${headers.map((h) => h.replace(/[.+]/g, '\\$&')).join('|')})[>"]`);
  for (const board of sim.boards) {
    const code = editor.getGroupFiles(board.activeFileGroupId).map((f) => f.content).join('\n');
    if (!includeRe.test(code)) continue;
    const merged = [...new Set([...(board.libraries ?? []), ...installed])];
    sim.updateBoard(board.id, { libraries: merged });
  }
  return installed.length ? installed : null;
}

export function installMissingLibraryHandler(): void {
  setMissingLibraryHandler((headers, context) => {
    inFlight ??= handle(headers, context).finally(() => {
      inFlight = null;
    });
    return inFlight;
  });
}
