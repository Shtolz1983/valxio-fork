/**
 * Right-docked AI assistant panel for the editor.
 *
 * Talks to ai-bridge (ws://127.0.0.1:8787 by default), which runs `claude -p`
 * on the host. Closed, it collapses to a thin tab on the right edge.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { Bot, Loader2, Check, X, Plus, Send, Square, ChevronRight, Paperclip, Maximize2, Image as ImageIcon, Settings } from 'lucide-react';
import { AiConnectionsDialog } from './AiConnectionsDialog';
import { AI_REPLY_LANGUAGES, useAiStore, type AiChatItem } from '../../store/useAiStore';
import { MAX_CHAT_IMAGES, imageFiles, prepareImage, type ChatImage } from '../../ai/images';
import './AiPanel.css';

function toolSummary(name: string, input: unknown): string {
  const a = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'add_board':
      return `${name} ${String(a.kind ?? '')}`;
    case 'add_component':
      return `${name} ${String(a.type ?? '')}`;
    case 'connect':
      return `${String(a.from ?? '')} → ${String(a.to ?? '')}`;
    case 'write_file':
    case 'read_file':
    case 'edit_file':
      return `${name} ${String(a.name ?? '')}`;
    case 'get_pins':
      return `${name} ${String(a.type ?? '')}`;
    case 'list_part_types':
      return a.query ? `${name} "${String(a.query)}"` : name;
    case 'set_libraries':
      return `${name} ${Array.isArray(a.libraries) ? a.libraries.join(', ') : ''}`;
    default:
      return name;
  }
}

const INPUT_HEIGHT_KEY = 'velxio.aiPanel.inputHeight';
const MIN_INPUT_HEIGHT = 56;
const DEFAULT_INPUT_HEIGHT = 64;

function readInputHeight(): number {
  try {
    const v = Number(localStorage.getItem(INPUT_HEIGHT_KEY));
    return Number.isFinite(v) && v >= MIN_INPUT_HEIGHT ? v : DEFAULT_INPUT_HEIGHT;
  } catch {
    return DEFAULT_INPUT_HEIGHT;
  }
}

const ChatItem: React.FC<{ item: AiChatItem }> = ({ item }) => {
  const { t } = useTranslation();
  switch (item.kind) {
    case 'user':
      return (
        <div className="ai-msg ai-msg-user">
          {item.images && (
            <div className="ai-msg-images">
              {item.images.map((url, i) => (
                <img key={i} src={url} alt="" />
              ))}
            </div>
          )}
          {/* Photos of a chat restored after a reload are not kept, only counted. */}
          {item.photos ? (
            <div className="ai-msg-photos">
              <ImageIcon size={12} /> {t('aiPanel.photosNotKept', { count: item.photos, defaultValue: '{{count}} photo(s)' })}
            </div>
          ) : null}
          {item.text}
        </div>
      );
    case 'assistant':
      return (
        <div className="ai-msg ai-msg-assistant">
          <ReactMarkdown>{item.text}</ReactMarkdown>
        </div>
      );
    case 'tool':
      return (
        <div className={`ai-tool ai-tool-${item.status}`} title={item.detail}>
          {item.status === 'running' && <Loader2 size={12} className="ai-spin" />}
          {item.status === 'ok' && <Check size={12} />}
          {item.status === 'error' && <X size={12} />}
          <span className="ai-tool-text">{toolSummary(item.name, item.input)}</span>
        </div>
      );
    case 'error':
      return <div className="ai-msg ai-msg-error">{item.text}</div>;
    case 'notice':
      return (
        <div className="ai-msg ai-msg-notice">
          {item.code === 'switched'
            ? t('aiPanel.sessionSwitched', { label: item.text, defaultValue: 'Now answering: {{label}}. It does not see the conversation above.' })
            : t('aiPanel.sessionLost', 'The earlier conversation is no longer available to the assistant; it starts a new one.')}
        </div>
      );
  }
};

export const AiPanel: React.FC = () => {
  const { t } = useTranslation();
  const open = useAiStore((s) => s.open);
  const connection = useAiStore((s) => s.connection);
  const busy = useAiStore((s) => s.busy);
  const model = useAiStore((s) => s.model);
  const items = useAiStore((s) => s.items);
  const language = useAiStore((s) => s.language);
  const connections = useAiStore((s) => s.connections);
  const { setOpen, setLanguage, connect, disconnect, send, cancel, newChat } = useAiStore.getState();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const chatConn = connections?.connections.find((c) => c.id === connections.selected.chat);
  const chatKind = chatConn ? connections?.kinds[chatConn.kind] : undefined;
  const activeModel = useAiStore((s) => s.activeModel);
  // Who answers, as text: the choice itself is made in AI connections (the gear).
  // "Work · Opus (latest) · claude-opus-5-5": the exact version once a run has
  // reported it, or the model id when that is already exact.
  const modelLabel = chatConn ? (chatKind?.models.find((m) => m.id === chatConn.model)?.label ?? chatConn.model) : '';
  const modelVersion = activeModel ?? (chatConn && chatConn.model !== modelLabel && chatConn.model.includes('-') ? chatConn.model : null);
  const responderText = chatConn
    ? [chatConn.label, modelLabel, modelVersion && modelVersion !== modelLabel ? modelVersion : null].filter(Boolean).join(' · ')
    : '';
  const responderTitle = chatConn ? `${chatKind?.label ?? chatConn.kind}: ${chatConn.model}${activeModel ? ` → ${activeModel}` : ''}` : '';
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState<ChatImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  // The message box: its height the user dragged (kept between visits), and
  // the large editor the arrows button opens on the same draft.
  const [inputHeight, setInputHeight] = useState(readInputHeight);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!open) return;
    connect();
    return () => disconnect();
  }, [open, connect, disconnect]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items]);

  if (!open) {
    return (
      <button className="ai-panel-tab" onClick={() => setOpen(true)} title={t('aiPanel.open', 'Open AI assistant')}>
        <Bot size={16} />
        <span>AI</span>
      </button>
    );
  }

  const attach = async (files: File[]) => {
    setAttachError(null);
    const room = MAX_CHAT_IMAGES - attached.length;
    if (files.length > room) setAttachError(t('aiPanel.tooManyPhotos', 'At most {{n}} photos per message.', { n: MAX_CHAT_IMAGES }));
    const added: ChatImage[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        added.push(await prepareImage(file));
      } catch {
        setAttachError(t('aiPanel.badPhoto', 'This file could not be read as an image (HEIC photos: save them as JPEG first).'));
      }
    }
    if (added.length) setAttached((prev) => [...prev, ...added].slice(0, MAX_CHAT_IMAGES));
  };

  const canSend = (draft.trim() !== '' || attached.length > 0) && connection === 'connected';

  const submit = () => {
    if (!canSend || busy) return;
    send(draft, attached);
    setDraft('');
    setAttached([]);
    setAttachError(null);
    setExpanded(false);
  };

  /** Drag the strip above the composer: up makes the message box taller. */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = inputHeight;
    // At most two thirds of the panel, so the conversation stays visible.
    const max = Math.max(MIN_INPUT_HEIGHT, (panelRef.current?.clientHeight ?? 600) * 0.66);
    let height = startHeight;
    const move = (ev: PointerEvent) => {
      height = Math.round(Math.min(max, Math.max(MIN_INPUT_HEIGHT, startHeight + startY - ev.clientY)));
      setInputHeight(height);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      try {
        localStorage.setItem(INPUT_HEIGHT_KEY, String(height));
      } catch {
        /* private mode: the height just is not remembered */
      }
    };
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onPastePhotos = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData.items);
    if (!files.length) return;
    e.preventDefault();
    void attach(files);
  };

  const attachmentsRow = (attached.length > 0 || attachError) && (
    <div className="ai-attachments">
      {attached.map((img, i) => (
        <span key={i} className="ai-attachment">
          <img src={img.url} alt="" />
          <button
            onClick={() => setAttached((prev) => prev.filter((_, j) => j !== i))}
            title={t('aiPanel.removePhoto', 'Remove photo')}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {attachError && <span className="ai-attach-error">{attachError}</span>}
    </div>
  );

  return (
    <aside className="ai-panel" ref={panelRef} aria-label={t('aiPanel.title', 'AI assistant')}>
      <header className="ai-panel-header">
        <Bot size={16} />
        <span className="ai-panel-title">{t('aiPanel.title', 'AI assistant')}</span>
        <select
          className="ai-lang"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          title={t('aiPanel.language', 'Reply language')}
          aria-label={t('aiPanel.language', 'Reply language')}
        >
          {AI_REPLY_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <span
          className={`ai-dot ai-dot-${connection}`}
          title={connection === 'connected' ? (model ?? '') : t('aiPanel.disconnected', 'Bridge not connected')}
        />
        <button className="ai-icon-btn" onClick={newChat} disabled={busy} title={t('aiPanel.newChat', 'New chat')}>
          <Plus size={14} />
        </button>
        <button className="ai-icon-btn" onClick={() => setOpen(false)} title={t('aiPanel.close', 'Close')}>
          <ChevronRight size={14} />
        </button>
      </header>
      {connection === 'connected' && connections && chatConn && (
        <div className="ai-responder">
          <span>{t('aiPanel.answers', 'Answers:')}</span>
          <span className="ai-responder-name" title={responderTitle}>
            {responderText}
          </span>
          <button className="ai-icon-btn" onClick={() => setConnectionsOpen(true)} title={t('aiConnections.title', 'AI connections')}>
            <Settings size={13} />
          </button>
        </div>
      )}
      {connectionsOpen && <AiConnectionsDialog onClose={() => setConnectionsOpen(false)} />}

      <div className="ai-panel-body" ref={listRef}>
        {connection !== 'connected' && (
          <div className="ai-hint">
            {t('aiPanel.bridgeHint', 'Start the AI bridge on this computer:')}
            <code>cd ai-bridge &amp;&amp; npm start</code>
          </div>
        )}
        {connection === 'connected' && items.length === 0 && (
          <div className="ai-hint">
            {t(
              'aiPanel.emptyHint',
              'Describe your device, e.g. "ESP32 weather station: DHT22 sensor and an SSD1306 OLED showing temperature".',
            )}
          </div>
        )}
        {items.map((item) => (
          <ChatItem key={item.id} item={item} />
        ))}
        {busy && (
          <div className="ai-working">
            <Loader2 size={12} className="ai-spin" /> {t('aiPanel.working', 'Working…')}
          </div>
        )}
      </div>

      <div
        className="ai-composer-resize"
        onPointerDown={startResize}
        onDoubleClick={() => {
          setInputHeight(DEFAULT_INPUT_HEIGHT);
          try {
            localStorage.removeItem(INPUT_HEIGHT_KEY);
          } catch {
            /* nothing remembered */
          }
        }}
        title={t('aiPanel.resizeInput', 'Drag to resize the message box (double-click: default size)')}
        role="separator"
        aria-orientation="horizontal"
      />
      <footer
        className={`ai-panel-composer${dragOver ? ' is-drop' : ''}`}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          const files = imageFiles(e.dataTransfer.files);
          setDragOver(false);
          if (!files.length) return;
          e.preventDefault();
          void attach(files);
        }}
      >
        {attachmentsRow}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void attach(imageFiles(e.target.files));
            e.target.value = '';
          }}
        />
        <div className="ai-input-wrap">
          <textarea
            onPaste={onPastePhotos}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t('aiPanel.placeholder', 'What should we build?')}
            style={{ height: inputHeight }}
            disabled={connection !== 'connected'}
          />
          <button
            className="ai-expand-btn"
            onClick={() => setExpanded(true)}
            disabled={connection !== 'connected'}
            title={t('aiPanel.expandInput', 'Open a large editor for the message')}
          >
            <Maximize2 size={12} />
          </button>
        </div>
        {/* Right of the message box: attach a photo above, send below. */}
        <div className="ai-composer-actions">
          <button
            className="ai-attach-btn"
            onClick={() => fileRef.current?.click()}
            disabled={connection !== 'connected' || attached.length >= MAX_CHAT_IMAGES}
            title={t('aiPanel.attachPhoto', 'Attach a photo (or paste / drop it here)')}
          >
            <Paperclip size={14} />
          </button>
          {busy ? (
            <button className="ai-send-btn" onClick={cancel} title={t('aiPanel.stop', 'Stop')}>
              <Square size={14} />
            </button>
          ) : (
            <button
              className="ai-send-btn"
              onClick={submit}
              disabled={!canSend}
              title={t('aiPanel.send', 'Send')}
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </footer>

      {expanded &&
        createPortal(
          <div className="ai-big-overlay" onClick={() => setExpanded(false)}>
            <div
              className="ai-big-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={t('aiPanel.bigTitle', 'Message to the assistant')}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ai-big-head">
                <Bot size={16} />
                <span>{t('aiPanel.bigTitle', 'Message to the assistant')}</span>
                <button className="ai-icon-btn" onClick={() => setExpanded(false)} title={t('aiPanel.close', 'Close')}>
                  <X size={14} />
                </button>
              </div>
              {attachmentsRow}
              <textarea
                className="ai-big-input"
                autoFocus
                value={draft}
                onPaste={onPastePhotos}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter is a new line here; Ctrl/Cmd+Enter sends, Esc goes back.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setExpanded(false);
                  }
                }}
                placeholder={t('aiPanel.placeholder', 'What should we build?')}
              />
              <div className="ai-big-foot">
                <button
                  className="ai-attach-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={attached.length >= MAX_CHAT_IMAGES}
                  title={t('aiPanel.attachPhoto', 'Attach a photo (or paste / drop it here)')}
                >
                  <Paperclip size={14} />
                </button>
                <span className="ai-big-hint">{t('aiPanel.bigHint', 'Ctrl/Cmd+Enter — send, Esc — back to the panel')}</span>
                <button className="ai-big-send" onClick={submit} disabled={!canSend || busy}>
                  <Send size={14} /> {t('aiPanel.send', 'Send')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
};
