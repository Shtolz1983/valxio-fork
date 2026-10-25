/**
 * "+ Add sensor": asks ai-bridge to research a part and write its catalogue
 * card. Runs on its own WebSocket, separate from the chat, so the chat
 * session is untouched. The bridge checks the card (libraries, compile for
 * Uno and ESP32) and saves it as a draft; `card_saved` names it.
 */
import { BRIDGE_URL } from '../store/useAiStore';
import { toBridgeImages, type ChatImage } from '../ai/images';

export interface CardJobLine {
  kind: 'status' | 'search' | 'read' | 'check' | 'note' | 'error';
  text: string;
}

export interface CardJob {
  cancel: () => void;
  /** Resolves with the saved card id, or null when no card was saved. */
  done: Promise<string | null>;
}

function toolLine(name: string, input: Record<string, unknown>): CardJobLine {
  if (name === 'WebSearch') return { kind: 'search', text: String(input.query ?? '') };
  if (name === 'WebFetch') return { kind: 'read', text: String(input.url ?? '') };
  if (name === 'submit_part_card') {
    const card = (input.card ?? {}) as Record<string, unknown>;
    return { kind: 'check', text: String(card.id ?? card.name ?? '') };
  }
  return { kind: 'status', text: name };
}

/**
 * Write the card for `query`. With `images` (a photo the user confirmed is
 * this part) the author also reads the pinout off the board in the photo.
 */
export function authorPartCard(query: string, onLine: (line: CardJobLine) => void, images: ChatImage[] = []): CardJob {
  const ws = new WebSocket(BRIDGE_URL);
  let savedId: string | null = null;
  let finish: (id: string | null) => void = () => {};
  const done = new Promise<string | null>((resolve) => {
    finish = resolve;
  });
  let started = false;

  ws.onmessage = (e) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        ws.send(
          JSON.stringify({ type: 'make_part_card', query, ...(images.length ? { images: toBridgeImages(images) } : {}) }),
        );
        break;
      case 'busy':
        if (msg.busy) started = true;
        else if (started) ws.close();
        break;
      case 'card_status':
        onLine({ kind: 'status', text: msg.text });
        break;
      case 'tool_use':
        onLine(toolLine(String(msg.name ?? ''), msg.input ?? {}));
        break;
      case 'assistant_text':
        if (msg.text?.trim()) onLine({ kind: 'note', text: msg.text.trim() });
        break;
      case 'card_saved':
        savedId = msg.id;
        break;
      case 'result':
        if (msg.isError) onLine({ kind: 'error', text: msg.text || msg.subtype || 'The assistant stopped with an error.' });
        break;
      case 'error':
        onLine({ kind: 'error', text: msg.message });
        break;
    }
  };
  ws.onerror = () => onLine({ kind: 'error', text: 'bridge' });
  ws.onclose = () => finish(savedId);

  return {
    cancel: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel' }));
      ws.close();
    },
    done,
  };
}

// ── "What module is this?" from a photo ─────────────────────────────────────

export interface IdentifiedCandidate {
  model: string;
  title: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  /** The catalogue card of exactly this module, when there is one. */
  catalogId: string | null;
  /** Pin labels read off the board, in header order. */
  pins: string[];
}

export interface Identification {
  candidates: IdentifiedCandidate[];
  /** What to check on the board to tell look-alike candidates apart. */
  question: string;
  /** Set when the photo shows no module: what it shows instead. */
  notAModule: string;
}

export interface IdentifyJob {
  cancel: () => void;
  /** Rejects with 'bridge' when ai-bridge is not running, else with the reason. */
  done: Promise<Identification>;
}

/** Ask the AI which module the photo shows; nothing is written until the user picks a candidate. */
export function identifyPart(images: ChatImage[], hint: string, language: string): IdentifyJob {
  const ws = new WebSocket(BRIDGE_URL);
  let settle: { resolve: (r: Identification) => void; reject: (e: Error) => void } | null = null;
  const done = new Promise<Identification>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const finish = (r: Identification | Error) => {
    if (!settle) return;
    if (r instanceof Error) settle.reject(r);
    else settle.resolve(r);
    settle = null;
    ws.close();
  };

  ws.onmessage = (e) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        ws.send(JSON.stringify({ type: 'identify_part', text: hint, language, images: toBridgeImages(images) }));
        break;
      case 'part_identified':
        finish({ candidates: msg.candidates ?? [], question: msg.question ?? '', notAModule: msg.notAModule ?? '' });
        break;
      case 'identify_failed':
      case 'error':
        finish(new Error(String(msg.message ?? 'error')));
        break;
    }
  };
  ws.onerror = () => finish(new Error('bridge'));
  ws.onclose = () => finish(new Error('bridge'));

  return {
    cancel: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel' }));
      finish(new Error('cancelled'));
    },
    done,
  };
}
