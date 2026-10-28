/**
 * A check result in the user's language. The backend sends each violation as
 * an English sentence (what the AI assistant reads) plus a `code` and the
 * `params` it names; the code picks the translation, and the params that are
 * words themselves (a wall, a printed part, what is in the way) are translated
 * before they go in. An unknown code falls back to the English sentence.
 */
import type { TFunction } from 'i18next';
import type { EnclosureViolation } from '../../services/enclosureService';

export function violationText(v: EnclosureViolation, t: TFunction): string {
  if (!v.code) return v.message;
  const p: Record<string, unknown> = { ...v.params };
  if (typeof p.side === 'string') p.side = t(`enclosure.face.${p.side}`, p.side);
  if (typeof p.part === 'string') p.part = t(`enclosure.part.${p.part}`, p.part);
  if (typeof p.what === 'string') p.what = t(`enclosure.thick.${p.what}`, p.what);
  if (typeof p.what_kind === 'string') {
    p.what = t(`enclosure.obstacle.${p.what_kind}`, { name: p.what_name, defaultValue: `${p.what_kind} ${p.what_name ?? ''}`.trim() });
  }
  const text = t(`enclosure.violation.${v.code}`, { ...p, defaultValue: v.message });
  // A sentence starts with a capital, unless it starts with a part id ("usb", "rtc1"), which stays as it is.
  if (typeof v.params?.name === 'string' && text.startsWith(v.params.name)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
