/**
 * Per-browser library preferences. `autoInstallMissing`: when a compile fails
 * on a header no installed library provides, install the matching library
 * and recompile without asking (utils/missingLibraries.ts).
 */
import { create } from 'zustand';

const KEY = 'velxio.autoInstallMissingLibraries';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

interface LibraryPrefsState {
  autoInstallMissing: boolean;
  setAutoInstallMissing: (on: boolean) => void;
}

export const useLibraryPrefsStore = create<LibraryPrefsState>((set) => ({
  autoInstallMissing: read(),
  setAutoInstallMissing: (on) => {
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable — the choice lasts for this session only */
    }
    set({ autoInstallMissing: on });
  },
}));
