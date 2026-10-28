/**
 * The AI assistant's chat inside the enclosure dialog, so the user can ask for
 * changes ("a 6 mm cable hole in the middle of the left wall") while looking at
 * the case. It is the same conversation as the AI panel — the same store, the
 * same session — so both show every message; a case the assistant builds lands
 * in the 3D view right away (useAiStore → useEnclosureStore.showSpec).
 *
 * The bridge connection belongs to the AI panel (it connects while open), so
 * showing this chat opens the panel too.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Send, Square } from 'lucide-react';
import { ChatInput } from '../ai/ChatInput';
import { ChatItem } from '../ai/AiPanel';
import { useAiStore } from '../../store/useAiStore';
import '../ai/AiPanel.css';

export function EnclosureChat() {
  const { t } = useTranslation();
  const items = useAiStore((s) => s.items);
  const busy = useAiStore((s) => s.busy);
  const connection = useAiStore((s) => s.connection);
  const { send, cancel } = useAiStore.getState();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!useAiStore.getState().open) useAiStore.getState().setOpen(true);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items, busy]);

  const connected = connection === 'connected';
  const submit = () => {
    if (!draft.trim() || busy || !connected) return;
    send(draft);
    setDraft('');
  };

  return (
    <div className="enc-chat">
      <div className="enc-chat-list" ref={listRef}>
        {!connected && (
          <div className="ai-hint">
            {connection === 'connecting'
              ? t('enclosure.chatConnecting', 'Connecting to the AI assistant…')
              : t('enclosure.chatOff', 'The AI assistant is not connected: see the AI panel on the right.')}
          </div>
        )}
        {connected && items.length === 0 && (
          <div className="ai-hint">
            {t('enclosure.chatHint', 'Ask for a change and watch the case update, e.g. "a 6 mm cable hole in the middle of the left wall".')}
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
      <div className="enc-chat-composer">
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          sendKey="enter"
          onImages={() => {}}
          placeholder={t('enclosure.chatPlaceholder', 'What should change in the case?')}
          style={{ height: 52 }}
          disabled={!connected}
        />
        {busy ? (
          <button className="ai-send-btn" onClick={cancel} title={t('aiPanel.stop', 'Stop')}>
            <Square size={14} />
          </button>
        ) : (
          <button className="ai-send-btn" onClick={submit} disabled={!draft.trim() || !connected} title={t('aiPanel.send', 'Send')}>
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
