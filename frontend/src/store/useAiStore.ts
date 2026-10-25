/**
 * AI assistant panel state: the chat transcript and the link to ai-bridge.
 *
 * The bridge (ai-bridge/server.mjs, run on the host) drives `claude -p`; this
 * store only renders what it streams back and answers its tool calls through
 * frontend/src/ai/tools.ts.
 *
 * Each project has its own chat (ai/chatHistory.ts): the transcript and the
 * Claude session survive a reload, and opening another project shows that
 * project's chat; the bridge is told which session to continue.
 */
import { create } from 'zustand';
import { runAiTool } from '../ai/tools';
import { toBridgeImages, type ChatImage } from '../ai/images';
import { currentChatKey, loadChat, saveChat } from '../ai/chatHistory';
import { useProjectStore } from './useProjectStore';

export type AiChatItem =
  | { id: string; kind: 'user'; text: string; images?: string[]; photos?: number }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'tool'; name: string; input: unknown; status: 'running' | 'ok' | 'error'; detail?: string }
  | { id: string; kind: 'error'; text: string }
  /** A line about the conversation itself; `text` is the label of a `switched` notice. */
  | { id: string; kind: 'notice'; code: 'session_lost' | 'switched'; text: string };

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/** One AI connection of the bridge (ai-bridge/connections.mjs). */
export interface AiConnection {
  id: string;
  kind: string;
  label: string;
  model: string;
  /** A folder the user brought (null: the bridge's own or none). */
  configDir: string | null;
  /** The server of an OpenAI-compatible or Ollama connection. */
  baseUrl: string | null;
  /** The login the bridge itself runs under. */
  system: boolean;
  /** Claude Code: the account; API kinds: whether the key is set (`keySet`). */
  account: { loggedIn: boolean; email?: string; subscription?: string; error?: string; keySet?: boolean };
  signingIn: boolean;
}

export interface AiConnectionKind {
  label: string;
  /** Fixed models (Claude Code); empty for API kinds, whose provider lists them. */
  models: Array<{ id: string; label: string }>;
  api: boolean;
  key: 'required' | 'optional' | 'none';
  baseUrl: string | null;
  needsBaseUrl: boolean;
}

/** The models a provider offers, as last asked (by connection id, or 'new' for the add form). */
export interface AiModelList {
  loading?: boolean;
  models?: Array<{ id: string; label: string }>;
  error?: string;
}

export interface AiConnections {
  kinds: Record<string, AiConnectionKind>;
  connections: AiConnection[];
  selected: { chat: string; cards: string };
}

/** A sign-in in progress: the link to open, then the code to paste. */
export interface AiLogin {
  id: string;
  url?: string;
  done?: boolean;
  ok?: boolean;
  error?: string;
  email?: string;
}

interface AiState {
  open: boolean;
  connection: ConnectionState;
  busy: boolean;
  model: string | null;
  items: AiChatItem[];
  /** The bridge's Claude session of this chat (null: the next prompt starts one). */
  sessionId: string | null;
  /** The connection that session belongs to. */
  sessionConnection: string | null;
  /** The exact model the last run reported (Claude Code resolves "opus" to a version). */
  activeModel: string | null;
  /** What the bridge can talk to, and who answers (null until it says). */
  connections: AiConnections | null;
  login: AiLogin | null;
  connectionError: string | null;
  modelLists: Record<string, AiModelList>;
  lastCostUsd: number | null;
  /** Language the assistant replies in (code from AI_REPLY_LANGUAGES). */
  language: string;

  setOpen: (open: boolean) => void;
  setLanguage: (code: string) => void;
  toggleOpen: () => void;
  connect: () => void;
  disconnect: () => void;
  /** Send a message, with photos when given (thumbnails stay in the transcript). */
  send: (text: string, images?: ChatImage[]) => void;
  /** Open the panel and send `text` as soon as the bridge is connected. */
  openAndSend: (text: string) => void;
  cancel: () => void;
  newChat: () => void;
  /** Send a connections command to the bridge (`connection_add`, `connection_select`, …). */
  connectionCommand: (msg: { type: string } & Record<string, unknown>) => void;
  clearLogin: () => void;
  /** Ask the bridge for a provider's models: of a connection (`id`), or of the add form (kind, baseUrl, apiKey). */
  loadModels: (key: string, params: { id?: string; kind?: string; baseUrl?: string; apiKey?: string }) => void;
}

export const BRIDGE_URL: string = import.meta.env.VITE_AI_BRIDGE_URL ?? 'ws://127.0.0.1:8787/ws';
const OPEN_KEY = 'velxio.aiPanel.open';
const LANGUAGE_KEY = 'velxio.aiPanel.language';

/** Reply languages; the bridge maps the code to the model instruction (ai-bridge/claudeRunner.mjs). */
export const AI_REPLY_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Українська' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'zh', label: '中文' },
];
const DEFAULT_LANGUAGE = 'ru';

function readLanguage(): string {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return v && AI_REPLY_LANGUAGES.some((l) => l.code === v) ? v : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wantConnected = false;
// A prompt requested before the bridge connected (openAndSend); sent on hello.
let pendingPrompt: string | null = null;
/** Which project's chat the panel shows (ai/chatHistory.ts). */
let chatKey = currentChatKey();
let seq = 0;
const newId = () => `ai_${Date.now()}_${seq++}`;

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable — the panel just starts closed next time */
  }
}

function sendRaw(msg: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export const useAiStore = create<AiState>((set, get) => {
  const push = (item: AiChatItem) => set((s) => ({ items: [...s.items, item] }));

  const patchTool = (id: string, patch: Partial<Extract<AiChatItem, { kind: 'tool' }>>) =>
    set((s) => ({
      items: s.items.map((it) => (it.kind === 'tool' && it.id === id ? { ...it, ...patch } : it)),
    }));

  const appendDelta = (text: string) =>
    set((s) => {
      const last = s.items[s.items.length - 1];
      if (last?.kind === 'assistant' && last.streaming) {
        return { items: [...s.items.slice(0, -1), { ...last, text: last.text + text }] };
      }
      return { items: [...s.items, { id: newId(), kind: 'assistant', text, streaming: true }] };
    });

  const finishText = (text: string) =>
    set((s) => {
      const last = s.items[s.items.length - 1];
      if (last?.kind === 'assistant' && last.streaming) {
        return { items: [...s.items.slice(0, -1), { ...last, text, streaming: false }] };
      }
      return { items: [...s.items, { id: newId(), kind: 'assistant', text, streaming: false }] };
    });

  async function answerToolCall(callId: string, name: string, args: Record<string, unknown>) {
    try {
      const result = await runAiTool(name, args);
      sendRaw({ type: 'tool_result', callId, ok: true, result });
    } catch (err) {
      sendRaw({ type: 'tool_result', callId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  function onMessage(raw: string) {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        set({ model: msg.model ?? null });
        // A new connection is a new bridge session: continue this chat's.
        sendRaw(
          get().sessionId
            ? { type: 'resume', sessionId: get().sessionId, connectionId: get().sessionConnection }
            : { type: 'reset' },
        );
        if (pendingPrompt) {
          const text = pendingPrompt;
          pendingPrompt = null;
          get().send(text);
        }
        break;
      case 'busy':
        set({ busy: !!msg.busy });
        break;
      case 'session':
        set({
          sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
          sessionConnection: typeof msg.connectionId === 'string' ? msg.connectionId : null,
          ...(typeof msg.model === 'string' && msg.model ? { activeModel: msg.model } : {}),
        });
        break;
      case 'session_switched':
        push({ id: newId(), kind: 'notice', code: 'switched', text: String(msg.label ?? '') });
        break;
      case 'connections': {
        const next: AiConnections = { kinds: msg.kinds ?? {}, connections: msg.connections ?? [], selected: msg.selected ?? { chat: '', cards: '' } };
        const chatOf = (c: AiConnections | null) => c?.connections.find((x) => x.id === c.selected.chat);
        const before = chatOf(get().connections);
        const after = chatOf(next);
        // Another connection or model answers now: the version the last run reported is not its.
        const changed = before?.id !== after?.id || before?.model !== after?.model;
        set({ connections: next, ...(changed ? { activeModel: null } : {}) });
        break;
      }
      case 'connection_login':
        set((s) => ({ login: { ...(s.login?.id === msg.id ? s.login : {}), ...msg, id: msg.id } as AiLogin }));
        break;
      case 'connection_error':
        set({ connectionError: String(msg.message ?? '') });
        break;
      case 'connection_models':
        if (typeof msg.requestId === 'string') {
          set((s) => ({
            modelLists: { ...s.modelLists, [msg.requestId]: msg.error ? { error: String(msg.error) } : { models: msg.models ?? [] } },
          }));
        }
        break;
      case 'session_lost':
        push({ id: newId(), kind: 'notice', code: 'session_lost', text: '' });
        break;
      case 'text_delta':
        appendDelta(msg.text);
        break;
      case 'assistant_text':
        finishText(msg.text);
        break;
      case 'tool_use':
        push({ id: msg.id, kind: 'tool', name: msg.name, input: msg.input, status: 'running' });
        break;
      case 'tool_result':
        patchTool(msg.id, { status: msg.isError ? 'error' : 'ok', detail: msg.preview });
        break;
      case 'result':
        set({ lastCostUsd: typeof msg.costUsd === 'number' ? msg.costUsd : null });
        if (msg.isError) push({ id: newId(), kind: 'error', text: msg.text || msg.subtype || 'The assistant stopped with an error.' });
        break;
      case 'error':
        push({ id: newId(), kind: 'error', text: msg.message });
        break;
      case 'tool_call':
        void answerToolCall(msg.callId, msg.name, msg.args ?? {});
        break;
    }
  }

  function open() {
    if (socket || !wantConnected) return;
    set({ connection: 'connecting' });
    const ws = new WebSocket(BRIDGE_URL);
    socket = ws;
    ws.onopen = () => set({ connection: 'connected' });
    ws.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : '');
    ws.onclose = () => {
      socket = null;
      set({ connection: 'disconnected', busy: false });
      if (wantConnected && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          open();
        }, 3000);
      }
    };
  }

  const saved = loadChat(chatKey);
  return {
    open: readOpen(),
    connection: 'disconnected',
    busy: false,
    model: null,
    items: saved?.items ?? [],
    sessionId: saved?.sessionId ?? null,
    sessionConnection: saved?.connectionId ?? null,
    activeModel: null,
    connections: null,
    login: null,
    connectionError: null,
    modelLists: {},
    lastCostUsd: null,
    language: readLanguage(),

    setOpen: (value) => {
      writeOpen(value);
      set({ open: value });
    },
    setLanguage: (code) => {
      try {
        localStorage.setItem(LANGUAGE_KEY, code);
      } catch {
        /* remembered for this session only */
      }
      set({ language: code });
    },
    toggleOpen: () => get().setOpen(!get().open),

    connect: () => {
      wantConnected = true;
      open();
    },
    disconnect: () => {
      wantConnected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
    },

    send: (text, images = []) => {
      const trimmed = text.trim();
      if ((!trimmed && images.length === 0) || get().busy || get().connection !== 'connected') return;
      push({ id: newId(), kind: 'user', text: trimmed, images: images.length ? images.map((i) => i.url) : undefined });
      sendRaw({
        type: 'prompt',
        text: trimmed,
        language: get().language,
        ...(images.length ? { images: toBridgeImages(images) } : {}),
      });
    },
    openAndSend: (text) => {
      get().setOpen(true);
      if (get().connection === 'connected' && !get().busy) get().send(text);
      else pendingPrompt = text;
    },
    cancel: () => sendRaw({ type: 'cancel' }),
    newChat: () => {
      sendRaw({ type: 'reset' });
      set({ items: [], sessionId: null, sessionConnection: null, lastCostUsd: null });
    },
    connectionCommand: (msg) => {
      set({ connectionError: null });
      if (msg.type === 'connection_login') set({ login: { id: String(msg.id) } });
      sendRaw(msg);
    },
    clearLogin: () => set({ login: null }),
    loadModels: (key, params) => {
      set((s) => ({ modelLists: { ...s.modelLists, [key]: { loading: true } } }));
      sendRaw({ type: 'connection_models', requestId: key, ...params });
    },
  };
});

// ── Chat per project ────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function flushChat(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const { sessionId, sessionConnection, items } = useAiStore.getState();
  saveChat(chatKey, sessionId, items, sessionConnection);
}

useAiStore.subscribe((s, prev) => {
  if (s.items === prev.items && s.sessionId === prev.sessionId && s.sessionConnection === prev.sessionConnection) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushChat, 500);
});

// Another project opened (a new one, an example, an import, the autosave
// restored at start-up): file this chat away and show that project's.
useProjectStore.subscribe(() => {
  const key = currentChatKey();
  if (key === chatKey) return;
  flushChat();
  chatKey = key;
  const next = loadChat(key);
  if (useAiStore.getState().busy) sendRaw({ type: 'cancel' });
  useAiStore.setState({
    items: next?.items ?? [],
    sessionId: next?.sessionId ?? null,
    sessionConnection: next?.connectionId ?? null,
    lastCostUsd: null,
  });
  sendRaw(
    next?.sessionId ? { type: 'resume', sessionId: next.sessionId, connectionId: next.connectionId ?? null } : { type: 'reset' },
  );
});

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushChat);
