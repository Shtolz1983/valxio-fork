/**
 * Workspace name for self-hosted builds (no server-side projects): what the
 * Save dialog proposes and what the downloaded .vlx file is called. It
 * survives a reload together with the autosaved workspace; a new workspace
 * starts unnamed. The pro overlay's named projects live in useProjectStore.
 */
import { create } from 'zustand';

const KEY = 'velxio.projectName';

function load(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

interface LocalProjectState {
  name: string;
  saveDialogOpen: boolean;
  setName: (name: string) => void;
  openSaveDialog: () => void;
  closeSaveDialog: () => void;
}

export const useLocalProjectStore = create<LocalProjectState>((set) => ({
  name: load(),
  saveDialogOpen: false,
  setName: (name) => {
    try {
      if (name) localStorage.setItem(KEY, name);
      else localStorage.removeItem(KEY);
    } catch {
      // Storage disabled: the name just lasts until the tab closes.
    }
    set({ name });
  },
  openSaveDialog: () => set({ saveDialogOpen: true }),
  closeSaveDialog: () => set({ saveDialogOpen: false }),
}));
