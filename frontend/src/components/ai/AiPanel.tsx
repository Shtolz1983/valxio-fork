/**
 * Right-docked AI assistant panel for the editor.
 *
 * Talks to ai-bridge (ws://127.0.0.1:8787 by default), which runs `claude -p`
 * on the host. Closed, it collapses to a thin tab on the right edge.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { Bot, Loader2, Check, X, Plus, Send, Square, ChevronRight } from 'lucide-react';
import { useAiStore, type AiChatItem } from '../../store/useAiStore';
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

const ChatItem: React.FC<{ item: AiChatItem }> = ({ item }) => {
  switch (item.kind) {
    case 'user':
      return <div className="ai-msg ai-msg-user">{item.text}</div>;
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
  }
};

export const AiPanel: React.FC = () => {
  const { t } = useTranslation();
  const open = useAiStore((s) => s.open);
  const connection = useAiStore((s) => s.connection);
  const busy = useAiStore((s) => s.busy);
  const model = useAiStore((s) => s.model);
  const items = useAiStore((s) => s.items);
  const { setOpen, connect, disconnect, send, cancel, newChat } = useAiStore.getState();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

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

  const submit = () => {
    if (!draft.trim() || busy || connection !== 'connected') return;
    send(draft);
    setDraft('');
  };

  return (
    <aside className="ai-panel" aria-label={t('aiPanel.title', 'AI assistant')}>
      <header className="ai-panel-header">
        <Bot size={16} />
        <span className="ai-panel-title">{t('aiPanel.title', 'AI assistant')}</span>
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

      <footer className="ai-panel-composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('aiPanel.placeholder', 'What should we build?')}
          rows={3}
          disabled={connection !== 'connected'}
        />
        {busy ? (
          <button className="ai-send-btn" onClick={cancel} title={t('aiPanel.stop', 'Stop')}>
            <Square size={14} />
          </button>
        ) : (
          <button
            className="ai-send-btn"
            onClick={submit}
            disabled={!draft.trim() || connection !== 'connected'}
            title={t('aiPanel.send', 'Send')}
          >
            <Send size={14} />
          </button>
        )}
      </footer>
    </aside>
  );
};
