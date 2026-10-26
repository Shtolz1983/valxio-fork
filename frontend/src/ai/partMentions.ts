/**
 * "$" mentions in the AI chat: typing `$` lists the parts the user can name,
 * and the one picked goes into the message as `$[type]`, the part type
 * `add_component` and `get_pins` take, so the assistant does not have to guess
 * which part was meant (ai-bridge/system-prompt.md says how to read it).
 *
 * The list is the component registry without boards and the simulator's
 * measuring instruments; a sensor-catalogue card adds its name, English and
 * Russian titles and group to the part it describes (its own module, or the
 * existing part named by `component`). Matching is plain substring search, so
 * Russian titles match too (utils/searchMatch drops non-Latin letters).
 */
import registry from '../services/ComponentRegistry';
import { usePartCatalogStore } from '../partsCatalog/catalog';
import type { PartCard } from '../partsCatalog/types';
import type { ComponentCategory } from '../types/component-metadata';

export interface MentionPart {
  /** What goes into `$[...]`: a component registry id. */
  type: string;
  name: string;
  category: ComponentCategory;
  /** The catalogue card describing the part, if there is one. */
  card?: PartCard;
  /** Lower-cased text the query is matched against. */
  haystack: string;
}

/** `$[dht22]`: the part type in brackets, letters, digits, `_`, `.` and `-`. */
export const MENTION_RE = /\$\[([A-Za-z0-9_.-]+)\]/g;

export const mentionText = (type: string) => `$[${type}]`;

const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Every part a `$` can name: catalogue cards first, then the registry's own order. */
export function mentionParts(cards: PartCard[] = usePartCatalogStore.getState().cards): MentionPart[] {
  const byType = new Map(cards.map((c) => [c.component ?? c.id, c]));
  const parts = registry
    .getAllComponents()
    .filter((m) => m.category !== 'boards' && !m.id.startsWith('instr-'))
    .map((m): MentionPart => {
      const card = byType.get(m.id);
      const name = card?.name ?? m.name;
      return {
        type: m.id,
        name,
        category: m.category,
        card,
        haystack: normalize(
          [name, m.id, m.name, card?.title, card?.titleRu, card?.interface, m.tags.join(' '), m.keywords?.join(' '), m.description]
            .filter(Boolean)
            .join(' '),
        ),
      };
    });
  return [...parts.filter((p) => p.card), ...parts.filter((p) => !p.card)];
}

/**
 * The parts matching `query` (every word must occur), best first: the name or
 * type equal to the query, then starting with it, then a word starting with
 * it, then the rest.
 */
export function searchMentionParts(parts: MentionPart[], query: string, limit = 50): MentionPart[] {
  const q = normalize(query.trim());
  if (!q) return parts.slice(0, limit);
  const words = q.split(/\s+/);
  const score = (p: MentionPart) => {
    if (!words.every((w) => p.haystack.includes(w))) return 0;
    const name = normalize(p.name);
    if (name === q || p.type === q) return 4;
    if (name.startsWith(q) || p.type.startsWith(q)) return 3;
    if (p.haystack.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(words[0]))) return 2;
    return 1;
  };
  return parts
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.p);
}

/** The name a `$[type]` is shown with: the card's, the registry's, or the type itself. */
export function mentionLabel(type: string, cards: PartCard[] = usePartCatalogStore.getState().cards): string {
  const card = cards.find((c) => (c.component ?? c.id) === type);
  return card?.name ?? registry.getById(type)?.name ?? type;
}

/** Text split into plain runs and mentioned part types, in order. */
export function splitMentions(text: string): Array<string | { type: string }> {
  const out: Array<string | { type: string }> = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ type: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
