import { create } from 'zustand';
import type { ProjectVisibility } from '../services/projectService';

interface CurrentProject {
  id: string;
  slug: string;
  ownerUsername: string;
  isPublic: boolean;
  // Phase 1 D1.3 — three-level visibility. Kept in sync with isPublic
  // (which legacy callers still read) by setVisibility().
  visibility?: ProjectVisibility;
}

interface ProjectState {
  currentProject: CurrentProject | null;
  /**
   * Gallery example currently loaded in the editor (null when the workspace
   * came from a project, a file or scratch). Set by loadExample, cleared
   * whenever a project takes over — analytics only: compiles/runs stamp it
   * so "which examples get compiled most" is answerable.
   */
  currentExampleId: string | null;
  /**
   * Identity of the local workspace (no server project open): what the AI
   * chat's history is filed under (ai/chatHistory.ts). A fresh workspace
   * (new project, example, import) gets a new one; the autosave and .vlx
   * files keep it, so a reload or reopening the same file finds its chat.
   */
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  setCurrentProject: (project: CurrentProject) => void;
  clearCurrentProject: () => void;
  setCurrentExampleId: (id: string | null) => void;
  // Updated to accept either the legacy boolean OR the new enum so the
  // ShareModal callsite and any older callers keep working uniformly.
  setVisibility: (next: boolean | ProjectVisibility) => void;
}

export function newWorkspaceId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentProject: null,
  currentExampleId: null,
  workspaceId: newWorkspaceId(),
  setWorkspaceId: (id) => set({ workspaceId: id }),
  // Loading a real project supersedes the example context.
  setCurrentProject: (project) => set({ currentProject: project, currentExampleId: null }),
  // Also drops the example context: every caller (new project, blank
  // workspace, logout cleanup) means "this workspace is no longer that".
  // loadExample re-stamps its id right after calling this. And it starts a
  // new workspace identity: its AI chat starts empty (importVlxFile puts the
  // file's own back).
  clearCurrentProject: () => set({ currentProject: null, currentExampleId: null, workspaceId: newWorkspaceId() }),
  setCurrentExampleId: (id) => set({ currentExampleId: id }),
  setVisibility: (next) =>
    set((s) => {
      if (!s.currentProject) return s;
      // Translate boolean → enum and vice versa so both fields are
      // always coherent.
      let isPublic: boolean;
      let visibility: ProjectVisibility;
      if (typeof next === 'boolean') {
        isPublic = next;
        visibility = next ? 'public' : 'private';
      } else {
        visibility = next;
        isPublic = next === 'public';
      }
      return {
        currentProject: { ...s.currentProject, isPublic, visibility },
      };
    }),
}));
