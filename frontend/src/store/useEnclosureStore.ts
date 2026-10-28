import { create } from 'zustand';
import { buildEnclosure, type EnclosureBuild, type EnclosureSpec } from '../services/enclosureService';
import { useProjectStore } from './useProjectStore';

/**
 * The project's 3D-printable enclosure: the spec (what the AI assistant or
 * the user chose) and the last build of it (meshes + check results) for the
 * viewer dialog. The spec is the source of truth; a build is derived from it
 * by the backend and is never stored.
 *
 * The spec belongs to the workspace: it is saved in the .vlx (vlxFile.ts) and
 * the browser autosave, put back with them (`restore`), and dropped when
 * another project or a new workspace opens.
 */
interface EnclosureState {
  spec: EnclosureSpec | null;
  build: EnclosureBuild | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  /** Take a new spec, show the viewer and build it. */
  showSpec: (spec: EnclosureSpec) => void;
  /** The spec of a project being opened (null: it has none); built when the viewer opens. */
  restore: (spec: EnclosureSpec | null) => void;
  openViewer: () => void;
  close: () => void;
}

// Builds can overlap when the assistant iterates; only the latest one lands.
let buildSeq = 0;

export const useEnclosureStore = create<EnclosureState>((set, get) => {
  async function rebuild() {
    const spec = get().spec;
    if (!spec) return;
    const seq = ++buildSeq;
    set({ loading: true, error: null });
    try {
      const build = await buildEnclosure(spec);
      if (seq === buildSeq) set({ build, loading: false });
    } catch (err) {
      // The last good build stays on screen, so the dialog can still show the spec to fix.
      if (seq === buildSeq) set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    spec: null,
    build: null,
    loading: false,
    error: null,
    open: false,
    showSpec: (spec) => {
      set({ spec, open: true });
      void rebuild();
    },
    restore: (spec) => {
      buildSeq++; // a build still running belongs to the previous project
      set({ spec, build: null, loading: false, error: null, open: false });
    },
    openViewer: () => {
      set({ open: true });
      const { spec, build, loading } = get();
      if (spec && !build && !loading) void rebuild();
    },
    close: () => set({ open: false }),
  };
});

// Another project or a new workspace: its enclosure, if any, comes with its loader's restore().
const projectKey = () => {
  const p = useProjectStore.getState();
  return `${p.currentProject?.id ?? ''}|${p.workspaceId}`;
};
let lastProject = projectKey();
useProjectStore.subscribe(() => {
  const key = projectKey();
  if (key === lastProject) return;
  lastProject = key;
  if (useEnclosureStore.getState().spec) useEnclosureStore.getState().restore(null);
});
