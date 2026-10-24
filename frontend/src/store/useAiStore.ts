/**
 * AI assistant panel state: the chat transcript and the link to ai-bridge.
 *
 * The bridge (ai-bridge/server.mjs, run on the host) drives `claude -p`; this
 * store only renders what it streams back and answers its tool calls through
 * frontend/src/ai/tools.ts.
 */
import { create } from 'zustand';
import { runAiTool } from '../ai/tools';

export type AiChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'tool'; name: string; input: unknown; status: 'running' | 'ok' | 'error'; detail?: string }
  | { id: string; kind: 'error'; text: string };

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

interface AiState {
  open: boolean;
  connection: ConnectionState;
  busy: boolean;
  model: string | null;
  items: AiChatItem[];
  lastCostUsd: number | null;

  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  connect: () => void;
  disconnect: () => void;
  send: (text: string) => void;
  /** Open the panel and send `text` as soon as the bridge is connected. */
  openAndSend: (text: string) => void;
  cancel: () => void;
  newChat: () => void;
}

const BRIDGE_URL: string = import.meta.env.VITE_AI_BRIDGE_URL ?? 'ws://127.0.0.1:8787/ws';
const OPEN_KEY = 'velxio.aiPanel.open';

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wantConnected = false;
// A prompt requested before the bridge connected (openAndSend); sent on hello.
let pendingPrompt: string | null = null;
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
        if (pendingPrompt) {
          const text = pendingPrompt;
          pendingPrompt = null;
          get().send(text);
        }
        break;
      case 'busy':
        set({ busy: !!msg.busy });
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

  return {
    open: readOpen(),
    connection: 'disconnected',
    busy: false,
    model: null,
    items: [],
    lastCostUsd: null,

    setOpen: (value) => {
      writeOpen(value);
      set({ open: value });
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

    send: (text) => {
      const trimmed = text.trim();
      if (!trimmed || get().busy || get().connection !== 'connected') return;
      push({ id: newId(), kind: 'user', text: trimmed });
      sendRaw({ type: 'prompt', text: trimmed });
    },
    openAndSend: (text) => {
      get().setOpen(true);
      if (get().connection === 'connected' && !get().busy) get().send(text);
      else pendingPrompt = text;
    },
    cancel: () => sendRaw({ type: 'cancel' }),
    newChat: () => {
      sendRaw({ type: 'reset' });
      set({ items: [], lastCostUsd: null });
    },
  };
});
