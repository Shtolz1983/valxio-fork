/**
 * Check results in the user's language (components/enclosure/violationText.ts):
 * the code picks the text, the words among the params are translated too, and
 * an unknown code keeps the backend's English sentence.
 */
import { describe, it, expect } from 'vitest';
import i18next from 'i18next';

import ru from '../i18n/locales/ru/common.json';
import { violationText } from '../components/enclosure/violationText';
import type { EnclosureViolation } from '../services/enclosureService';

const i18n = i18next.createInstance();
await i18n.init({ lng: 'ru', resources: { ru: { translation: ru } }, interpolation: { escapeValue: false } });

const v = (code: string, params: Record<string, string | number>, message = 'english'): EnclosureViolation => ({
  severity: 'error',
  check: 'x',
  message,
  code,
  params,
});

describe('enclosure check results in Russian', () => {
  it('translate the sentence and the walls, parts and obstacles in it', () => {
    expect(violationText(v('opening_lip', { name: 'usb', side: 'left' }), i18n.t)).toBe(
      'usb (левая стенка) упирается в бортик крышки: увеличьте зазор над деталями',
    );
    expect(violationText(v('collision', { part: 'lid', volume: 5.2, what_kind: 'connector', what_name: 'usb' }), i18n.t)).toBe(
      'Крышка врезается в разъём usb (5.2 мм³): увеличьте зазоры или проверьте данные платы',
    );
    expect(violationText(v('module_overlap', { name: 'rtc', what_kind: 'board', what_name: '' }), i18n.t)).toBe('Модуль rtc налезает на плату');
    expect(violationText(v('thin', { what: 'wall', value: 0.8, min: 1.2 }), i18n.t)).toBe('Стенка: 0.8 мм — тоньше, чем можно напечатать (1.2 мм)');
  });

  it('say which way to move an opening that runs past a corner', () => {
    expect(violationText(v('opening_corner', { name: 'matrix', side: 'front', shift: 26.5 }), i18n.t)).toBe(
      'matrix (передняя стенка) заходит за внутренний угол корпуса: сдвиньте его на 26.5 мм вправо',
    );
    expect(violationText(v('opening_corner', { name: 'cable', side: 'left', shift: -4 }), i18n.t)).toBe(
      'cable (левая стенка) заходит за внутренний угол корпуса: сдвиньте его на 4 мм вперёд',
    );
  });

  it('keep the English sentence for a code without a text', () => {
    expect(violationText(v('something_new', {}, 'a new check'), i18n.t)).toBe('A new check');
    expect(violationText({ severity: 'warning', check: 'x', message: 'no code at all' }, i18n.t)).toBe('no code at all');
  });
});
