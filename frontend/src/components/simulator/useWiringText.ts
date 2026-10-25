/**
 * The circuit as text (validation/wiringList.ts), following the canvas. It is
 * recomputed only when the wiring itself changes, not on every serial byte or
 * part drag.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import registry from '../../services/ComponentRegistry';
import { wiringList, wiringText } from '../../validation/wiringList';

/** What the wiring depends on, as one comparable string. */
function wiringFingerprint(s: ReturnType<typeof useSimulatorStore.getState>): string {
  return JSON.stringify([
    s.boards.map((b) => [b.id, b.boardKind, b.name ?? '']),
    s.components.map((c) => [c.id, c.metadataId, c.properties?.value ?? '']),
    s.wires.map((w) => [w.id, w.start.componentId, w.start.pinName, w.end.componentId, w.end.pinName]),
  ]);
}

export function useWiringText(): string {
  const { t } = useTranslation();
  const fingerprint = useSimulatorStore(wiringFingerprint);
  return useMemo(() => {
    const s = useSimulatorStore.getState();
    const parts = wiringList({
      boards: s.boards,
      components: s.components,
      wires: s.wires,
      nameOf: (id) => registry.getById(id)?.name,
    });
    return wiringText(parts, {
      notConnected: t('editor.wiring.notConnected', 'not connected'),
      via: t('editor.wiring.via', 'via'),
    });
    // The fingerprint stands for the store fields read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, t]);
}
