// "What module is this?" from a photo: the prompt the model gets and the
// parser for its JSON answer. The user confirms a candidate before the card
// author (server.mjs, make_part_card) writes anything.
import { REPLY_LANGUAGES } from './claudeRunner.mjs';

const CONFIDENCE = new Set(['high', 'medium', 'low']);

/** The identification system prompt with the catalogue and the reply language. */
export function buildIdentifyPrompt(base, cards, language) {
  const list = cards.map((c) => `- ${c.id} — ${c.name} — ${c.title}`).join('\n');
  return `${base}\n${list}\n\nLanguage for title, evidence, question and notAModule: ${REPLY_LANGUAGES[language] ?? 'English'}.\n`;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The model's answer as { candidates, question, notAModule }. Tolerates prose
 * or a code fence around the object; throws when there is no usable object.
 */
export function parseIdentification(text, knownIds = []) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the assistant did not answer with a result');
  let raw;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('the assistant answered with broken JSON');
  }
  const ids = new Set(knownIds);
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .map((c) => ({
      model: str(c?.model, 40),
      title: str(c?.title, 160),
      confidence: CONFIDENCE.has(c?.confidence) ? c.confidence : 'low',
      evidence: str(c?.evidence, 700),
      // Only an id the catalogue really has: a made-up one would open nothing.
      catalogId: typeof c?.catalogId === 'string' && ids.has(c.catalogId) ? c.catalogId : null,
      pins: Array.isArray(c?.pins) ? c.pins.filter((p) => typeof p === 'string').map((p) => p.slice(0, 8)).slice(0, 16) : [],
    }))
    .filter((c) => c.model)
    .slice(0, 3);
  const notAModule = str(raw.notAModule, 700);
  if (!candidates.length && !notAModule) throw new Error('the assistant named no module');
  return { candidates, question: str(raw.question, 700), notAModule };
}
