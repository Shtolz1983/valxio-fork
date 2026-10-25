/**
 * "Save project" dialog for self-hosted builds: asks for the project name,
 * then the folder to save into, and writes the project there as a folder of
 * files (utils/projectFolder.ts) — after a warning listing the existing files
 * it would replace. A browser that cannot write to a chosen folder (Safari,
 * Firefox) downloads the workspace as `<name>.vlx` instead. Opened by the OSS
 * default save action (Save button, Ctrl+S, File → Save); the pro overlay
 * installs its own action and never opens it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocalProjectStore } from '../../store/useLocalProjectStore';
import { useProjectStore } from '../../store/useProjectStore';
import { triggerDownloadVlx } from '../../utils/vlxFile';
import {
  canSaveToFolder,
  findConflicts,
  pickTarget,
  planProjectFiles,
  targetLabel,
  writeProject,
  type Conflict,
  type FolderTarget,
  type PlannedFile,
} from '../../utils/projectFolder';

/** A save waiting for "Replace": where, what, and what it would overwrite. */
interface PendingSave {
  target: FolderTarget;
  files: PlannedFile[];
  conflicts: Conflict[];
}

export const SaveProjectDialog = () => {
  const { t } = useTranslation();
  const open = useLocalProjectStore((s) => s.saveDialogOpen);
  const { setName, closeSaveDialog } = useLocalProjectStore.getState();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderSave = canSaveToFolder();

  useEffect(() => {
    if (!open) return;
    setPending(null);
    setError(null);
    setBusy(false);
    const proj = useProjectStore.getState().currentProject;
    setDraft(useLocalProjectStore.getState().name || proj?.slug || '');
    // Select the proposed name so typing replaces it.
    requestAnimationFrame(() => inputRef.current?.select());
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSaveDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, closeSaveDialog]);

  if (!open) return null;

  const name = draft.trim();
  const download = () => {
    if (!name) return;
    setName(name);
    const filename = triggerDownloadVlx({ name });
    // eslint-disable-next-line no-console
    console.info(`[oss] downloaded workspace as ${filename}`);
    closeSaveDialog();
  };
  const write = async (target: FolderTarget, files: PlannedFile[]) => {
    setBusy(true);
    try {
      await writeProject(target, files);
      // eslint-disable-next-line no-console
      console.info(`[oss] saved ${files.length} files to ${targetLabel(target)}`);
      closeSaveDialog();
    } catch (err) {
      setError(t('editor.fileExplorer.saveDialog.writeFailed', { error: (err as Error).message, defaultValue: 'Could not write the files: {{error}}' }));
      setBusy(false);
    }
  };
  const save = async () => {
    if (!name || busy) return;
    if (!folderSave) {
      download();
      return;
    }
    setError(null);
    setName(name);
    let target: FolderTarget | null;
    try {
      target = await pickTarget(name);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    if (!target) return; // the picker was closed
    setBusy(true);
    const files = planProjectFiles(name);
    const conflicts = await findConflicts(target, files).catch(() => []);
    setBusy(false);
    if (conflicts.length) setPending({ target, files, conflicts });
    else await write(target, files);
  };

  const buttonBase = {
    padding: '7px 20px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-project-title"
      onClick={closeSaveDialog}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-bg-overlay)',
        backdropFilter: 'blur(4px)',
        zIndex: 9700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        style={{
          width: 420,
          maxWidth: 'calc(100vw - 32px)',
          background: 'var(--wb-5)',
          color: 'var(--wb-13)',
          border: '1px solid var(--wb-6)',
          borderRadius: 8,
          padding: 20,
          boxShadow: 'var(--shadow-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <h2 id="save-project-title" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {t('editor.fileExplorer.saveDialog.title', 'Save project')}
        </h2>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          {t('editor.fileExplorer.saveDialog.label', 'Project name')}
          <input
            ref={inputRef}
            autoFocus
            disabled={!!pending}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('editor.fileExplorer.saveDialog.placeholder', 'e.g. weather-station')}
            maxLength={80}
            style={{
              padding: '7px 10px',
              fontSize: 13,
              color: 'var(--wb-13)',
              background: 'var(--wb-3)',
              border: '1px solid var(--wb-6)',
              borderRadius: 4,
              fontFamily: 'inherit',
            }}
          />
        </label>
        {pending ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <div style={{ color: 'var(--color-feedback-warning, #d29922)', fontWeight: 600 }}>
              {t('editor.fileExplorer.saveDialog.conflictsTitle', {
                count: pending.conflicts.length,
                folder: targetLabel(pending.target),
                defaultValue: '{{folder}} already has {{count}} of these files with other content:',
              })}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflowY: 'auto', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
              {pending.conflicts.map((c) => (
                <li key={c.path}>{c.path}</li>
              ))}
            </ul>
            <div style={{ fontSize: 12, color: 'var(--wb-11)' }}>
              {t('editor.fileExplorer.saveDialog.conflictsHint', 'Replace them with this project? The old content is lost.')}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--wb-11)' }}>
            {folderSave
              ? t(
                  'editor.fileExplorer.saveDialog.folderHint',
                  'Next you pick a folder. The project is saved there in its own folder: <name>.vlx (open it again with "Open project") and each board\'s code as files that open in the Arduino IDE.',
                )
              : t(
                  'editor.fileExplorer.saveDialog.hint',
                  'The project is saved as a .vlx file in your Downloads folder. Open it again with the "Open project" button.',
                )}
          </div>
        )}
        {error && <div style={{ fontSize: 12, color: 'var(--color-feedback-error)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={pending ? () => setPending(null) : closeSaveDialog}
            style={{ ...buttonBase, color: 'var(--wb-12)', background: 'transparent', border: '1px solid var(--wb-6)' }}
          >
            {t('editor.fileExplorer.saveDialog.cancel', 'Cancel')}
          </button>
          {pending ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void write(pending.target, pending.files)}
              style={{ ...buttonBase, color: '#fff', background: 'var(--color-feedback-error, #d73a49)', border: 'none', opacity: busy ? 0.5 : 1 }}
            >
              {t('editor.fileExplorer.saveDialog.replace', 'Replace')}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!name || busy}
              style={{
                ...buttonBase,
                color: 'var(--color-action-primary-fg)',
                background: 'var(--color-action-primary)',
                border: 'none',
                opacity: name && !busy ? 1 : 0.5,
                cursor: name && !busy ? 'pointer' : 'default',
              }}
            >
              {folderSave ? t('editor.fileExplorer.saveDialog.chooseFolder', 'Choose folder…') : t('editor.fileExplorer.saveDialog.save', 'Save')}
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
};
