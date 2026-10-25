/**
 * Pro save-action registry.
 *
 * EditorPage used to import useAuthStore + SaveProjectModal + LoginPromptModal
 * directly, branching on `user` to decide which modal to open when the
 * user pressed Save. After Phase 3 of the OSS split, all of those live
 * in the pro overlay. The OSS editor exposes a stable `triggerSaveAction()`
 * that:
 *
 *   - In OSS without an overlay → asks for the project name
 *     (SaveProjectDialog), then downloads a portable `.vlx` snapshot of
 *     the current workspace, re-loadable via the "Open project" button.
 *     This is Phase 4 of the OSS split — gives self-hosters durable
 *     project persistence without requiring a DB or auth.
 *   - With the pro overlay loaded → installSaveActionImpl() overrides
 *     the default. The overlay's impl inspects the auth store and opens
 *     SaveProjectModal (logged in) or LoginPromptModal (anonymous).
 *
 * Impl receives no arguments and returns nothing. State lives in the
 * caller's React tree (modal open/close, project data) — this registry
 * is just the doorbell.
 */

import { useLocalProjectStore } from '../store/useLocalProjectStore';

let _impl: (() => void) | null = null;

export function installSaveActionImpl(impl: (() => void) | null): void {
  _impl = impl;
}

function defaultSaveAction(): void {
  // OSS fallback: name the project, then download it as `<name>.vlx`.
  useLocalProjectStore.getState().openSaveDialog();
}

export function triggerSaveAction(): void {
  const impl = _impl ?? defaultSaveAction;
  try {
    impl();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] save-action impl threw:', err);
  }
}

/** Whether a custom (overlay) implementation has been installed. The OSS
 * default always works, so callers don't usually need this. Kept as a
 * hook for UIs that want to label the button differently in OSS vs Pro
 * (e.g. "Download .vlx" vs "Save project"). */
export function hasSaveActionImpl(): boolean {
  return _impl !== null;
}
