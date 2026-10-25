/**
 * The AI chat of each project, kept in the browser: the transcript and the
 * bridge's Claude session id (the bridge resumes that session, so the
 * assistant remembers the conversation, not only the panel).
 *
 * A project is a server project's id or, without one, the local workspace
 * identity (useProjectStore.workspaceId, kept by the autosave and .vlx
 * files). Photos are not kept — a few would fill the storage — only how
 * many there were; the session still has them. Long tool arguments (a whole
 * sketch in write_file) are dropped, the panel shows only their short ones.
 */
import type { AiChatItem } from '../store/useAiStore';
import { useProjectStore } from '../store/useProjectStore';

const KEY = 'velxio.aiChat.v1';
const MAX_CHATS = 30;
const MAX_ITEMS = 400;
const MAX_ARG_CHARS = 200;

export interface StoredChat {
  sessionId: string | null;
  /** The AI connection the session was made under (a session cannot move to another login). */
  connectionId?: string | null;
  items: AiChatItem[];
  updatedAt: number;
}

type Store = Record<string, StoredChat>;

/** The key of the open project's chat. */
export function currentChatKey(): string {
  const { currentProject, workspaceId } = useProjectStore.getState();
  return currentProject ? `project:${currentProject.id}` : `ws:${workspaceId}`;
}

function readAll(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeAll(store: Store): void {
  // Newest first; on a full storage drop the oldest chats until it fits.
  let keys = Object.keys(store).sort((a, b) => store[b].updatedAt - store[a].updatedAt).slice(0, MAX_CHATS);
  while (keys.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, store[k]]))));
      return;
    } catch {
      keys = keys.slice(0, -1);
    }
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the chat lasts until the tab closes */
  }
}

function shortArgs(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(([, v]) => JSON.stringify(v ?? null).length <= MAX_ARG_CHARS),
  );
}

/** An item as it is stored: no photos, short tool arguments. */
function storable(item: AiChatItem): AiChatItem {
  if (item.kind === 'user' && item.images?.length) {
    const { images, ...rest } = item;
    return { ...rest, photos: (item.photos ?? 0) + images.length };
  }
  if (item.kind === 'tool') return { ...item, input: shortArgs(item.input) };
  return item;
}

/** An item as it comes back: nothing is still running after a reload. */
function restored(item: AiChatItem): AiChatItem {
  if (item.kind === 'assistant' && item.streaming) return { ...item, streaming: false };
  if (item.kind === 'tool' && item.status === 'running') return { ...item, status: 'error' };
  return item;
}

export function loadChat(key: string): StoredChat | null {
  const chat = readAll()[key];
  if (!chat || !Array.isArray(chat.items)) return null;
  return {
    sessionId: typeof chat.sessionId === 'string' ? chat.sessionId : null,
    connectionId: typeof chat.connectionId === 'string' ? chat.connectionId : null,
    items: chat.items.map(restored),
    updatedAt: chat.updatedAt,
  };
}

export function saveChat(key: string, sessionId: string | null, items: AiChatItem[], connectionId: string | null = null): void {
  const store = readAll();
  if (items.length === 0 && !sessionId) {
    if (!(key in store)) return;
    delete store[key];
  } else {
    store[key] = { sessionId, connectionId, items: items.slice(-MAX_ITEMS).map(storable), updatedAt: Date.now() };
  }
  writeAll(store);
}
