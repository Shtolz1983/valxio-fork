/**
 * "Connections" tab of the bottom panel: the circuit as text, one block per
 * part with each pin and the controller pin it reaches
 * (validation/wiringList.ts, kept current by useWiringText).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';

export const WiringPanel: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation();
  return (
    <pre style={style}>{text || t('editor.wiring.empty', 'Nothing is wired to the board yet.')}</pre>
  );
};

const style: React.CSSProperties = {
  flex: 1,
  margin: 0,
  padding: 8,
  color: 'var(--color-terminal-fg)',
  background: 'var(--color-terminal-bg)',
  overflowY: 'auto',
  whiteSpace: 'pre',
  minHeight: 0,
  fontSize: 13,
  lineHeight: '1.4',
  fontFamily: 'monospace',
};
