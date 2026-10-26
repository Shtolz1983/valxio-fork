// The bridge imports TypeScript sources it shares with the frontend
// (frontend/src/partsCatalog/regmap.ts). Node runs .ts files by itself from
// 22.18 (and 23.6); older versions stop with ERR_UNKNOWN_FILE_EXTENSION,
// which says nothing about the cause.
export const MIN_NODE = '22.18';

export function nodeRunsTypeScript(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major >= 24) return true;
  if (major === 23) return minor >= 6;
  return major === 22 && minor >= 18;
}

/** Exits with a message naming the fix when this Node cannot run the bridge. */
export function requireNode() {
  if (nodeRunsTypeScript()) return;
  console.error(
    `[ai-bridge] Node ${process.versions.node} is too old: the bridge needs Node ${MIN_NODE} or newer.\n` +
      '  With nvm: nvm install 24 && nvm use 24 (ai-bridge/.nvmrc names that version), then run the command again.',
  );
  process.exit(1);
}
