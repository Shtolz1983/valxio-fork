/**
 * Sensors catalogue: every parts-catalog card, grouped, with its pins,
 * supply, libraries and example, and the three ways to use it —
 *
 *   - Place on canvas: the part next to the active board, wired (autoWire.ts);
 *   - Insert example: the card's sketch with the wired pins filled in;
 *   - Ask AI: hands the part to the assistant panel.
 *
 * "+ Add sensor" has the AI research a part and write its card (cardAuthor.ts);
 * it lands here as a draft to confirm or delete. With a photo, the AI first
 * says which module it sees and why; the user confirms or corrects the model,
 * and only then is the card written, with the photo for the pinout.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { Bot, Camera, Check, Cpu, FileCode, Loader2, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import registry from '../../services/ComponentRegistry';
import { usePartCatalogStore, confirmPartCard, deletePartCard, reloadPartCards } from '../../partsCatalog/catalog';
import { CARD_GROUPS, cardComponentId, type PartCard } from '../../partsCatalog/types';
import {
  fillExample,
  planForBoard,
  planFromCanvas,
  placeOnCanvas,
  targetBoard,
  type PinPlan,
} from '../../partsCatalog/autoWire';
import {
  authorPartCard,
  identifyPart,
  type CardJob,
  type CardJobLine,
  type Identification,
  type IdentifyJob,
} from '../../partsCatalog/cardAuthor';
import { MAX_CHAT_IMAGES, imageFiles, prepareImage, type ChatImage } from '../../ai/images';
import { AI_TOOLS } from '../../ai/tools';
import { useAiStore } from '../../store/useAiStore';
import { showConfirmDialog } from '../../store/useMessageDialogStore';
import { BOARD_KIND_LABELS, type BoardKind } from '../../types/board';
import './SensorCatalogModal.css';

interface SensorCatalogUi {
  open: boolean;
  selectedId: string | null;
}

export const useSensorCatalogUi = create<SensorCatalogUi>(() => ({ open: false, selectedId: null }));

export function openSensorCatalog(selectedId?: string): void {
  useSensorCatalogUi.setState((s) => ({ open: true, selectedId: selectedId ?? s.selectedId }));
}

type Notice = { kind: 'ok' | 'error'; lines: string[] } | null;

/** The part as the canvas draws it, scaled into the preview box. */
const PartPreview = ({ card }: { card: PartCard }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const meta = registry.getById(cardComponentId(card));
    if (!meta) return;
    const el = document.createElement(meta.tagName);
    Object.assign(el, meta.defaultValues ?? {});
    host.replaceChildren(el);
    // Fit after the element rendered its size.
    const raf = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const scale = Math.min(1.6, 150 / Math.max(r.width, 1), 110 / Math.max(r.height, 1));
      (el as HTMLElement).style.transform = `scale(${scale})`;
    });
    return () => cancelAnimationFrame(raf);
  }, [card]);
  return <div className="sc-preview" ref={hostRef} />;
};

export const SensorCatalogModal = () => {
  const { t, i18n } = useTranslation();
  const open = useSensorCatalogUi((s) => s.open);
  const selectedId = useSensorCatalogUi((s) => s.selectedId);
  const cards = usePartCatalogStore((s) => s.cards);
  const loadError = usePartCatalogStore((s) => s.error);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [showCode, setShowCode] = useState(false);
  // "+ Add sensor"
  const [adding, setAdding] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [jobLines, setJobLines] = useState<CardJobLine[]>([]);
  const jobRef = useRef<CardJob | null>(null);
  const [jobRunning, setJobRunning] = useState(false);
  // Photo identification: photos → candidates → the model the user confirms.
  const [photos, setPhotos] = useState<ChatImage[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [identification, setIdentification] = useState<Identification | null>(null);
  const [confirmedModel, setConfirmedModel] = useState('');
  const identifyRef = useRef<IdentifyJob | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const ru = i18n.language?.startsWith('ru');
  const titleOf = (c: PartCard) => (ru && c.titleRu ? c.titleRu : c.title);
  const close = () => useSensorCatalogUi.setState({ open: false });

  useEffect(() => {
    if (!open) return;
    void reloadPartCards();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !jobRef.current && !identifyRef.current) useSensorCatalogUi.setState({ open: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    setNotice(null);
    setShowCode(false);
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) =>
      [c.id, c.name, c.title, c.titleRu ?? '', c.group, c.interface].join(' ').toLowerCase().includes(q),
    );
  }, [cards, query]);

  const selected = cards.find((c) => c.id === selectedId) ?? null;

  if (!open) return null;

  const select = (id: string) => {
    setAdding(false);
    useSensorCatalogUi.setState({ selectedId: id });
  };

  const run = async (action: () => Promise<Notice>) => {
    setBusy(true);
    try {
      setNotice(await action());
    } catch (err) {
      setNotice({ kind: 'error', lines: [err instanceof Error ? err.message : String(err)] });
    } finally {
      setBusy(false);
    }
  };

  const planLines = (plan: PinPlan) =>
    Object.entries(plan.assignment).map(([pin, a]) => `${pin} → ${a.boardPin}`);

  const place = (card: PartCard) =>
    run(async () => {
      const { componentId, plan } = await placeOnCanvas(card);
      const lines = [t('sensorCatalog.placed', '{{id}} placed and wired:', { id: componentId }), planLines(plan).join(', ')];
      if (card.pullups?.length) {
        lines.push(
          t('sensorCatalog.pullupAdded', 'Added pull-up: {{list}}', {
            list: card.pullups.map((p) => `${p.ohms} Ω → ${p.pin}`).join(', '),
          }),
        );
      }
      return { kind: plan.warnings.length ? 'error' : 'ok', lines: [...lines, ...plan.warnings] };
    });

  const insertExample = (card: PartCard) =>
    run(async () => {
      const board = targetBoard();
      const fromCanvas = planFromCanvas(card, board);
      const fallback = planForBoard(card, board);
      const plan: PinPlan = {
        assignment: { ...fallback.assignment, ...(fromCanvas?.assignment ?? {}) },
        warnings: [],
      };
      const boardName = BOARD_KIND_LABELS[board.boardKind as BoardKind] ?? board.boardKind;
      const ok = await showConfirmDialog(
        t('sensorCatalog.insertConfirm', 'Replace the sketch.ino of {{board}} with the {{name}} example? The current code is replaced.', {
          board: boardName,
          name: card.name,
        }),
        {
          title: t('sensorCatalog.insertExample', 'Insert example'),
          confirmLabel: t('sensorCatalog.replace', 'Replace'),
          cancelLabel: t('sensorCatalog.cancel', 'Cancel'),
        },
      );
      if (!ok) return null;
      await AI_TOOLS.write_file({ boardId: board.id, name: 'sketch.ino', content: fillExample(card, board.boardKind, plan) });
      const libraries = [...new Set([...(board.libraries ?? []), ...card.libraries])];
      if (libraries.length) await AI_TOOLS.set_libraries({ boardId: board.id, libraries });
      const signalPins = card.pins.filter((p) => card.example.includes(`{{${p.name}}}`)).map((p) => p.name);
      const lines = [t('sensorCatalog.inserted', 'Example written to sketch.ino of {{board}}.', { board: boardName })];
      if (signalPins.length) {
        lines.push(
          t('sensorCatalog.insertedPins', 'Pins in the code: {{list}}', {
            list: signalPins.map((p) => `${p} → ${plan.assignment[p]?.boardPin ?? '?'}`).join(', '),
          }),
        );
        if (!fromCanvas) lines.push(t('sensorCatalog.notWired', 'The part is not on the canvas yet: wire it to these pins or press "Place on canvas".'));
      }
      if (card.libraries.length) lines.push(t('sensorCatalog.libsAdded', 'Libraries: {{list}}', { list: card.libraries.join(', ') }));
      return { kind: 'ok', lines };
    });

  const askAi = (card: PartCard) => {
    const prompt = t(
      'sensorCatalog.aiPrompt',
      'Add the {{name}} ({{title}}) to the circuit: part type "{{type}}" — read its pins and notes with get_pins. Wire it to the board, write a sketch that prints its readings to Serial, compile and check it.',
      { name: card.name, title: titleOf(card), type: cardComponentId(card) },
    );
    close();
    useAiStore.getState().openAndSend(prompt);
  };

  const confirmDraft = (card: PartCard) =>
    run(async () => {
      await confirmPartCard(card);
      return { kind: 'ok', lines: [t('sensorCatalog.confirmed', 'Card confirmed.')] };
    });

  const deleteDraft = (card: PartCard) =>
    run(async () => {
      const ok = await showConfirmDialog(t('sensorCatalog.deleteConfirm', 'Delete the card {{name}}?', { name: card.name }), {
        title: t('sensorCatalog.delete', 'Delete'),
        confirmLabel: t('sensorCatalog.delete', 'Delete'),
        cancelLabel: t('sensorCatalog.cancel', 'Cancel'),
        danger: true,
      });
      if (!ok) return null;
      await deletePartCard(card.id);
      useSensorCatalogUi.setState({ selectedId: null });
      return null;
    });

  const resetPhotos = () => {
    identifyRef.current?.cancel();
    setPhotos([]);
    setPhotoError(null);
    setIdentification(null);
    setConfirmedModel('');
  };

  const addPhotos = async (files: File[]) => {
    setPhotoError(null);
    setIdentification(null);
    const room = MAX_CHAT_IMAGES - photos.length;
    const added: ChatImage[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        added.push(await prepareImage(file));
      } catch {
        setPhotoError(t('sensorCatalog.badPhoto', 'This file could not be read as an image (HEIC photos: save them as JPEG first).'));
      }
    }
    if (files.length > room) setPhotoError(t('sensorCatalog.tooManyPhotos', 'At most {{n}} photos.', { n: MAX_CHAT_IMAGES }));
    if (added.length) setPhotos((prev) => [...prev, ...added].slice(0, MAX_CHAT_IMAGES));
  };

  const identify = () => {
    if (!photos.length || identifyRef.current || jobRef.current) return;
    setIdentification(null);
    setPhotoError(null);
    setJobLines([]);
    setIdentifying(true);
    const job = identifyPart(photos, addQuery.trim(), useAiStore.getState().language);
    identifyRef.current = job;
    job.done
      .then((r) => {
        setIdentification(r);
        setConfirmedModel(r.candidates[0]?.model ?? '');
      })
      .catch((err: Error) => {
        if (err.message === 'cancelled') return;
        setPhotoError(
          err.message === 'bridge'
            ? t('sensorCatalog.noBridge', 'The AI bridge is not running: cd ai-bridge && npm start')
            : t('sensorCatalog.identifyFailed', 'Could not identify the module: {{error}}', { error: err.message }),
        );
      })
      .finally(() => {
        identifyRef.current = null;
        setIdentifying(false);
      });
  };

  const startJob = (query?: string, withPhotos: ChatImage[] = []) => {
    const q = (query ?? addQuery).trim();
    if (!q || jobRef.current) return;
    setJobLines([]);
    setJobRunning(true);
    const job = authorPartCard(q, (line) => setJobLines((lines) => [...lines, line]), withPhotos);
    jobRef.current = job;
    void job.done.then(async (id) => {
      jobRef.current = null;
      setJobRunning(false);
      if (id) {
        await reloadPartCards();
        setAdding(false);
        setAddQuery('');
        resetPhotos();
        useSensorCatalogUi.setState({ selectedId: id });
        setNotice({ kind: 'ok', lines: [t('sensorCatalog.draftReady', 'The AI wrote this card and it passed the check. Review it, then confirm or delete it.')] });
      } else {
        setJobLines((lines) => [...lines, { kind: 'error', text: t('sensorCatalog.noCard', 'No card was saved.') }]);
      }
    });
  };

  const lineText = (line: CardJobLine) => {
    if (line.kind === 'error' && line.text === 'bridge') {
      return t('sensorCatalog.noBridge', 'The AI bridge is not running: cd ai-bridge && npm start');
    }
    const prefix: Record<CardJobLine['kind'], string> = {
      status: '',
      search: t('sensorCatalog.jobSearch', 'Searching: '),
      read: t('sensorCatalog.jobRead', 'Reading: '),
      check: t('sensorCatalog.jobCheck', 'Submitting card for checks: '),
      note: '',
      error: '⚠ ',
    };
    return `${prefix[line.kind]}${line.text}`;
  };

  const roleLabel = (role: string) => t(`sensorCatalog.role.${role}`, role);

  const groups = CARD_GROUPS.map((g) => ({ group: g, items: filtered.filter((c) => c.group === g) })).filter((g) => g.items.length);

  return createPortal(
    <div className="sc-overlay" onClick={() => !jobRef.current && !identifyRef.current && close()}>
      <div className="sc-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sc-head">
          <Cpu size={16} />
          <h3 className="sc-title">{t('sensorCatalog.title', 'Sensors catalogue')}</h3>
          <label className="sc-search">
            <Search size={13} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('sensorCatalog.search', 'Search: temperature, I2C, BME…')}
              autoFocus
            />
          </label>
          <button
            className="sc-btn sc-btn-primary"
            onClick={() => {
              setAdding(true);
              setNotice(null);
            }}
          >
            <Plus size={14} /> {t('sensorCatalog.add', 'Add sensor')}
          </button>
          <button className="sc-icon" onClick={close} title={t('sensorCatalog.close', 'Close')} disabled={jobRunning || identifying}>
            <X size={16} />
          </button>
        </div>

        <div className="sc-body">
          <nav className="sc-list">
            {loadError && <div className="sc-empty">{t('sensorCatalog.loadError', 'Catalogue not loaded: {{error}}', { error: loadError })}</div>}
            {groups.map(({ group, items }) => (
              <div key={group}>
                <div className="sc-group">{t(`sensorCatalog.group.${group}`, group)}</div>
                {items.map((c) => (
                  <button
                    key={c.id}
                    className={`sc-item${c.id === selected?.id && !adding ? ' is-active' : ''}`}
                    onClick={() => select(c.id)}
                    title={titleOf(c)}
                  >
                    <span className="sc-item-name">{c.name}</span>
                    {c.status === 'draft' && <span className="sc-badge sc-badge-draft">{t('sensorCatalog.draft', 'AI draft')}</span>}
                    <span className="sc-item-sub">{titleOf(c)}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <section className="sc-detail">
            {adding ? (
              <div
                className="sc-add"
                onDragOver={(e) => {
                  if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
                }}
                onDrop={(e) => {
                  const files = imageFiles(e.dataTransfer.files);
                  if (!files.length || jobRunning || identifying) return;
                  e.preventDefault();
                  void addPhotos(files);
                }}
                onPaste={(e) => {
                  const files = imageFiles(e.clipboardData.items);
                  if (!files.length || jobRunning || identifying) return;
                  e.preventDefault();
                  void addPhotos(files);
                }}
              >
                <h4>{t('sensorCatalog.addTitle', 'Add a sensor with AI')}</h4>
                <p className="sc-muted">
                  {t(
                    'sensorCatalog.addHint',
                    'Type the model (BME680, MAX31865, INA3221…) or a description. The AI finds the datasheet and the Arduino library, writes the card by the pattern of the existing ones, and the check installs the libraries and compiles the example for Uno and ESP32. Takes 1–5 minutes.',
                  )}
                </p>
                <p className="sc-muted">
                  {t(
                    'sensorCatalog.photoHint',
                    'Or attach a photo of the module (paste or drop it here): the AI says what it sees, you confirm or correct it, and the card is written for that model.',
                  )}
                </p>
                <div className="sc-add-row">
                  <input
                    value={addQuery}
                    onChange={(e) => setAddQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      if (photos.length) identify();
                      else startJob();
                    }}
                    placeholder={
                      photos.length
                        ? t('sensorCatalog.photoNotePlaceholder', 'Optional: what you know about it')
                        : t('sensorCatalog.addPlaceholder', 'e.g. MAX31865')
                    }
                    disabled={jobRunning || identifying}
                    autoFocus
                  />
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => {
                      void addPhotos(imageFiles(e.target.files));
                      e.target.value = '';
                    }}
                  />
                  <button
                    className="sc-btn"
                    onClick={() => photoInputRef.current?.click()}
                    disabled={jobRunning || identifying || photos.length >= MAX_CHAT_IMAGES}
                    title={t('sensorCatalog.addPhoto', 'Photo of the module')}
                  >
                    <Camera size={14} /> {t('sensorCatalog.photo', 'Photo')}
                  </button>
                  {jobRunning ? (
                    <button className="sc-btn" onClick={() => jobRef.current?.cancel()}>
                      {t('sensorCatalog.stop', 'Stop')}
                    </button>
                  ) : identifying ? (
                    <button className="sc-btn" onClick={() => identifyRef.current?.cancel()}>
                      {t('sensorCatalog.stop', 'Stop')}
                    </button>
                  ) : photos.length ? (
                    <button className="sc-btn sc-btn-primary" onClick={identify} disabled={!!identification}>
                      <Bot size={14} /> {t('sensorCatalog.identify', 'Identify from photo')}
                    </button>
                  ) : (
                    <button className="sc-btn sc-btn-primary" onClick={() => startJob()} disabled={!addQuery.trim()}>
                      <Bot size={14} /> {t('sensorCatalog.addRun', 'Write the card')}
                    </button>
                  )}
                </div>

                {photos.length > 0 && (
                  <div className="sc-photos">
                    {photos.map((p, i) => (
                      <span key={i} className="sc-photo">
                        <img src={p.url} alt="" />
                        {!jobRunning && !identifying && (
                          <button
                            onClick={() => {
                              setPhotos((prev) => prev.filter((_, j) => j !== i));
                              setIdentification(null);
                            }}
                            title={t('sensorCatalog.removePhoto', 'Remove photo')}
                          >
                            <X size={10} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                {photoError && <div className="sc-notice sc-notice-error">{photoError}</div>}
                {identifying && (
                  <div className="sc-job-status sc-identifying">
                    <Loader2 size={12} className="sc-spin" /> {t('sensorCatalog.identifying', 'Looking at the photo…')}
                  </div>
                )}

                {identification && !jobRunning && jobLines.length === 0 && (
                  <div className="sc-identify">
                    {identification.notAModule ? (
                      <div className="sc-notice sc-notice-error">{identification.notAModule}</div>
                    ) : (
                      <>
                        <div className="sc-identify-head">{t('sensorCatalog.identifiedAs', 'The AI thinks this is:')}</div>
                        {identification.candidates.map((c) => (
                          <label key={c.model} className={`sc-candidate${confirmedModel === c.model ? ' is-chosen' : ''}`}>
                            <input
                              type="radio"
                              name="sc-candidate"
                              checked={confirmedModel === c.model}
                              onChange={() => setConfirmedModel(c.model)}
                            />
                            <span className="sc-candidate-body">
                              <span className="sc-candidate-name">
                                {c.model}
                                <span className={`sc-badge sc-conf-${c.confidence}`}>
                                  {t(`sensorCatalog.confidence.${c.confidence}`, c.confidence)}
                                </span>
                                {c.catalogId && (
                                  <span className="sc-badge sc-badge-known">{t('sensorCatalog.inCatalogue', 'in the catalogue')}</span>
                                )}
                              </span>
                              {c.title && <span className="sc-candidate-title">{c.title}</span>}
                              {c.evidence && <span className="sc-muted">{c.evidence}</span>}
                              {c.pins.length > 0 && (
                                <span className="sc-muted">
                                  {t('sensorCatalog.pinsSeen', 'Pins on the board: {{list}}', { list: c.pins.join(', ') })}
                                </span>
                              )}
                            </span>
                          </label>
                        ))}
                        {identification.question && <div className="sc-muted sc-identify-q">{identification.question}</div>}
                      </>
                    )}
                    <div className="sc-add-row">
                      <input
                        value={confirmedModel}
                        onChange={(e) => setConfirmedModel(e.target.value)}
                        placeholder={t('sensorCatalog.correctModel', 'If the AI is wrong, type the right model')}
                      />
                    </div>
                    <div className="sc-actions">
                      {(() => {
                        const known = identification.candidates.find((c) => c.model === confirmedModel)?.catalogId;
                        return known ? (
                          <button className="sc-btn sc-btn-primary" onClick={() => select(known)}>
                            <Check size={14} /> {t('sensorCatalog.openExisting', 'Yes — open its card')}
                          </button>
                        ) : (
                          <button
                            className="sc-btn sc-btn-primary"
                            disabled={!confirmedModel.trim()}
                            onClick={() => startJob(confirmedModel, photos)}
                          >
                            <Check size={14} />{' '}
                            {t('sensorCatalog.confirmAndWrite', 'Yes, it is {{model}} — write the card', { model: confirmedModel.trim() })}
                          </button>
                        );
                      })()}
                      <button className="sc-btn" onClick={identify}>
                        <RotateCcw size={14} /> {t('sensorCatalog.identifyAgain', 'Look again')}
                      </button>
                      <button className="sc-btn" onClick={resetPhotos}>
                        {t('sensorCatalog.cancel', 'Cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {jobLines.length > 0 && (
                  <ul className="sc-job">
                    {jobLines.map((line, i) => (
                      <li key={i} className={`sc-job-${line.kind}`}>
                        {lineText(line)}
                      </li>
                    ))}
                    {jobRunning && (
                      <li className="sc-job-status">
                        <Loader2 size={12} className="sc-spin" /> {t('sensorCatalog.working', 'Working…')}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            ) : !selected ? (
              <div className="sc-empty">
                {t('sensorCatalog.pick', 'Pick a sensor on the left — or add a missing one with "Add sensor".')}
              </div>
            ) : (
              <div className="sc-card">
                <div className="sc-card-top">
                  <PartPreview card={selected} />
                  <div className="sc-card-head">
                    <div className="sc-card-name">
                      {selected.name}
                      {selected.status === 'draft' && <span className="sc-badge sc-badge-draft">{t('sensorCatalog.draft', 'AI draft')}</span>}
                    </div>
                    <div className="sc-card-title">{titleOf(selected)}</div>
                    <div className="sc-chips">
                      <span className="sc-chip">{selected.interface.toUpperCase()}</span>
                      <span className="sc-chip">
                        {selected.supply.min}–{selected.supply.max} V
                      </span>
                      {selected.i2c && <span className="sc-chip">I2C {selected.i2c.addresses.join(' / ')}</span>}
                      {selected.component && <span className="sc-chip sc-chip-sim">{t('sensorCatalog.simulated', 'simulated part')}</span>}
                    </div>
                  </div>
                </div>

                <div className="sc-actions">
                  <button className="sc-btn sc-btn-primary" onClick={() => place(selected)} disabled={busy}>
                    <Plus size={14} /> {t('sensorCatalog.place', 'Place on canvas')}
                  </button>
                  <button className="sc-btn" onClick={() => insertExample(selected)} disabled={busy}>
                    <FileCode size={14} /> {t('sensorCatalog.insertExample', 'Insert example')}
                  </button>
                  <button className="sc-btn" onClick={() => askAi(selected)} disabled={busy}>
                    <Bot size={14} /> {t('sensorCatalog.askAi', 'Ask AI')}
                  </button>
                  {selected.status === 'draft' && (
                    <>
                      <button className="sc-btn sc-btn-ok" onClick={() => confirmDraft(selected)} disabled={busy}>
                        <Check size={14} /> {t('sensorCatalog.confirm', 'Confirm')}
                      </button>
                      <button className="sc-btn sc-btn-danger" onClick={() => deleteDraft(selected)} disabled={busy}>
                        <Trash2 size={14} /> {t('sensorCatalog.delete', 'Delete')}
                      </button>
                    </>
                  )}
                  {busy && <Loader2 size={14} className="sc-spin" />}
                </div>

                {notice && (
                  <div className={`sc-notice sc-notice-${notice.kind}`}>
                    {notice.lines.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                )}

                <table className="sc-pins">
                  <thead>
                    <tr>
                      <th>{t('sensorCatalog.pin', 'Pin')}</th>
                      <th>{t('sensorCatalog.roleHead', 'Role')}</th>
                      <th>{t('sensorCatalog.desc', 'Notes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.pins.map((p) => (
                      <tr key={p.name}>
                        <td className="sc-mono">{p.name}</td>
                        <td>{roleLabel(p.role)}</td>
                        <td>{p.desc ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {(selected.pullups?.length ?? 0) > 0 && (
                  <p className="sc-line">
                    <b>{t('sensorCatalog.pullups', 'Pull-ups')}:</b>{' '}
                    {selected.pullups!.map((p) => `${p.ohms} Ω ${p.pin} → VCC`).join(', ')}
                  </p>
                )}
                <p className="sc-line">
                  <b>{t('sensorCatalog.libraries', 'Libraries')}:</b>{' '}
                  {selected.libraries.length ? selected.libraries.join(', ') : t('sensorCatalog.noLibraries', 'none needed')}
                </p>
                {selected.notes.length > 0 && (
                  <ul className="sc-notes">
                    {selected.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
                {(selected.source?.datasheet || selected.source?.library) && (
                  <p className="sc-line sc-links">
                    {selected.source?.datasheet && (
                      <a href={selected.source.datasheet} target="_blank" rel="noreferrer">
                        {t('sensorCatalog.datasheet', 'Datasheet')}
                      </a>
                    )}
                    {selected.source?.library && (
                      <a href={selected.source.library} target="_blank" rel="noreferrer">
                        {t('sensorCatalog.library', 'Library')}
                      </a>
                    )}
                  </p>
                )}
                <button className="sc-link" onClick={() => setShowCode((v) => !v)}>
                  {showCode ? t('sensorCatalog.hideCode', 'Hide example code') : t('sensorCatalog.showCode', 'Show example code')}
                </button>
                {showCode && <pre className="sc-code">{selected.example}</pre>}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
};
