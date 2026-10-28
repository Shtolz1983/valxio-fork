/**
 * File → "3D-printable enclosure…": the case the AI assistant made for the
 * board, in an interactive 3D view, with the backend's check results and a
 * download of the print files. The assistant's build_enclosure call opens
 * it by itself (useAiStore → useEnclosureStore.showSpec). Without a spec it
 * offers the default case for the active board, so the feature works without
 * the assistant too. The assistant's chat can be shown under the 3D view
 * (EnclosureChat), to ask for changes without leaving it.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, Box, CheckCircle2, Download, Loader2, X, XCircle } from 'lucide-react';
import { registerEditorCommand } from '../../lib/editorCommands';
import {
  exportEnclosure,
  listEnclosureBoards,
  localName,
  type EnclosureBoard,
  type EnclosureCatalog,
  type EnclosureSpec,
} from '../../services/enclosureService';
import { useEnclosureStore } from '../../store/useEnclosureStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { EnclosureChat } from './EnclosureChat';
import { EnclosureEditor } from './EnclosureEditor';
import { violationText } from './violationText';
import './EnclosureDialog.css';

const EnclosureViewer = lazy(() => import('./EnclosureViewer'));

const MAX_LIFT = 40;
const CHAT_KEY = 'velxio.enclosure.chat';

function readChatOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_KEY) !== '0';
  } catch {
    return true;
  }
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const mm = (v: number) => (Math.round(v * 10) / 10).toString();
const names = (boards: EnclosureBoard[], language: string) => boards.map((b) => localName(b, language)).join(', ');

export function EnclosureDialog() {
  const { t, i18n } = useTranslation();
  const { spec, build, loading, error, open, showSpec, openViewer, close } = useEnclosureStore();
  const activeKind = useSimulatorStore((s) => s.boards.find((b) => b.id === s.activeBoardId)?.boardKind);
  const [catalog, setCatalog] = useState<EnclosureCatalog | null>(null);
  const boards = catalog?.boards ?? null;
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [lift, setLift] = useState(15);
  const [showBoard, setShowBoard] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [chatOpen, setChatOpen] = useState(readChatOpen);
  const toggleChat = () => {
    setChatOpen((v) => {
      try {
        localStorage.setItem(CHAT_KEY, v ? '0' : '1');
      } catch {
        /* storage unavailable: the choice lasts this session */
      }
      return !v;
    });
  };
  // Kept with the spec it was for: a new spec from the assistant drops it.
  const [exportFailure, setExportFailure] = useState<{ spec: EnclosureSpec; message: string } | null>(null);
  const exportError = exportFailure?.spec === spec ? exportFailure.message : null;

  useEffect(() => registerEditorCommand('enclosure.open', openViewer), [openViewer]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open || catalog) return;
    listEnclosureBoards()
      .then(setCatalog)
      .catch((err: Error) => setBoardsError(err.message));
  }, [open, catalog]);

  if (!open) return null;

  const download = async () => {
    if (!spec) return;
    setExporting(true);
    setExportFailure(null);
    try {
      downloadBlob(await exportEnclosure(spec), `enclosure-${spec.board}.zip`);
    } catch (err) {
      setExportFailure({ spec, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setExporting(false);
    }
  };

  const errors = build?.violations.filter((v) => v.severity === 'error') ?? [];
  const warnings = build?.violations.filter((v) => v.severity === 'warning') ?? [];

  const empty = () => {
    const fits = boards?.find((b) => activeKind && b.canvas_kinds.includes(activeKind));
    return (
      <div className="enc-empty">
        <Box size={40} strokeWidth={1.2} />
        <p>{t('enclosure.empty', 'No enclosure yet. Ask the AI assistant, for example: “Make a case for this board with a hole for the LED”.')}</p>
        {boardsError && <p className="enc-error">{boardsError}</p>}
        {fits && (
          <button className="enc-btn enc-btn-primary" onClick={() => showSpec({ board: fits.id })}>
            {t('enclosure.makeDefault', 'Make the standard case for {{board}}', { board: localName(fits, i18n.language) })}
          </button>
        )}
        {boards && !fits && (
          <p className="enc-muted">
            {activeKind
              ? t('enclosure.unsupported', 'No enclosure for the board on the canvas yet. Supported: {{boards}}.', { boards: names(boards, i18n.language) })
              : t('enclosure.noBoard', 'Put a board on the canvas first. Supported: {{boards}}.', { boards: names(boards, i18n.language) })}
          </p>
        )}
      </div>
    );
  };

  return createPortal(
    <div className="enc-overlay" onClick={close}>
      <div className="enc-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="enc-head">
          <Box size={16} />
          <h3 className="enc-title">
            {t('enclosure.title', '3D-printable enclosure')}
            {build && <span className="enc-subtitle"> — {localName(build.board, i18n.language)}</span>}
          </h3>
          {loading && <Loader2 size={16} className="enc-spin" />}
          <button
            className={`enc-btn enc-chat-toggle${chatOpen ? ' is-on' : ''}`}
            onClick={toggleChat}
            title={t('enclosure.chatToggleHint', 'The AI assistant’s chat under the 3D view')}
          >
            <Bot size={14} /> {t('enclosure.chatToggle', 'AI chat')}
          </button>
          <button className="enc-icon" onClick={close} title={t('enclosure.close', 'Close')}>
            <X size={16} />
          </button>
        </div>
        {!spec ? (
          <div className="enc-body enc-body-column">
            {empty()}
            {chatOpen && <EnclosureChat />}
          </div>
        ) : (
          <div className="enc-body">
            <div className="enc-stage">
              {build ? (
                <Suspense fallback={<div className="enc-viewer" />}>
                  <EnclosureViewer build={build} lift={lift} showBoard={showBoard} />
                </Suspense>
              ) : (
                <div className="enc-viewer enc-placeholder">
                  {error ? <span className="enc-error">{error}</span> : <Loader2 size={24} className="enc-spin" />}
                </div>
              )}
              <div className="enc-hint">{t('enclosure.hint', 'Drag to rotate · wheel to zoom · right-drag to pan')}</div>
              {chatOpen && <EnclosureChat />}
            </div>
            <aside className="enc-side">
              {error && build && <p className="enc-error">{error}</p>}
              {build && (
                <>
                  <dl className="enc-facts">
                    <dt>{t('enclosure.size', 'Outer size')}</dt>
                    <dd>
                      {mm(build.outer.x1 - build.outer.x0)} × {mm(build.outer.y1 - build.outer.y0)} × {mm(build.outer.z1 - build.outer.z0)}{' '}
                      {t('enclosure.mm', 'mm')}
                    </dd>
                    <dt>{t('enclosure.weight', 'Plastic')}</dt>
                    <dd>{t('enclosure.grams', '~{{g}} g PLA', { g: Math.round(build.weight_g) })}</dd>
                    <dt>{t('enclosure.lid', 'Lid')}</dt>
                    <dd>{build.spec.lid === 'snap' ? t('enclosure.lidSnap', 'snaps in') : t('enclosure.lidScrew', 'M3 screws')}</dd>
                    {build.spec.battery && (
                      <>
                        <dt>{t('enclosure.battery', 'Battery')}</dt>
                        <dd>
                          {build.spec.battery} ·{' '}
                          {build.spec.battery_side === 'left' ? t('enclosure.sideLeft', 'left end') : t('enclosure.sideRight', 'right end')}
                          {build.spec.battery_hatch && ` · ${t('enclosure.hatch', 'hatch in the bottom')}`}
                        </dd>
                      </>
                    )}
                  </dl>

                  <div className="enc-section">{t('enclosure.checks', 'Checks')}</div>
                  {build.violations.length === 0 && (
                    <div className="enc-check enc-check-ok">
                      <CheckCircle2 size={14} /> {t('enclosure.allPassed', 'All checks passed')}
                    </div>
                  )}
                  {[...errors, ...warnings].map((v, i) => (
                    <div key={i} className={`enc-check enc-check-${v.severity}`}>
                      {v.severity === 'error' ? <XCircle size={14} /> : <AlertTriangle size={14} />}
                      <span>{violationText(v, t)}</span>
                    </div>
                  ))}
                  {!build.board.verified && (
                    <p className="enc-note">
                      {t('enclosure.unverified', 'Board dimensions are nominal, not measured on a real board: check your board against the case before printing.')}
                    </p>
                  )}

                  <EnclosureEditor key={JSON.stringify(build.spec)} build={build} catalog={catalog} busy={loading} onApply={showSpec} />

                  <div className="enc-section">{t('enclosure.view', 'View')}</div>
                  <label className="enc-control">
                    <span>{t('enclosure.lift', 'Lift the lid')}</span>
                    <input type="range" min={0} max={MAX_LIFT} value={lift} onChange={(e) => setLift(Number(e.target.value))} />
                  </label>
                  <label className="enc-control enc-control-row">
                    <input type="checkbox" checked={showBoard} onChange={(e) => setShowBoard(e.target.checked)} />
                    <span>{t('enclosure.showBoard', 'Show the board')}</span>
                  </label>

                  <button className="enc-btn enc-btn-primary enc-download" onClick={download} disabled={!build.ok || !!error || exporting || loading}>
                    {exporting ? <Loader2 size={14} className="enc-spin" /> : <Download size={14} />}
                    {t('enclosure.download', 'Download for printing (.zip)')}
                  </button>
                  <p className="enc-muted">
                    {build.ok
                      ? t('enclosure.downloadHint', 'STL with the lid flipped onto the bed, STEP and the parameters.')
                      : t('enclosure.fixFirst', 'Fix the errors first: ask the AI assistant to change the case.')}
                  </p>
                  {exportError && <p className="enc-error">{exportError}</p>}
                </>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
