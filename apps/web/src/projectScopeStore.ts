import { create } from "zustand";

interface ProjectScopeStoreState {
  readonly projectScopeKey: string | null;
  readonly setProjectScopeKey: (projectScopeKey: string | null) => void;
}

/** The logical project scope shared by the sidebar list and session board. */
export const useProjectScopeStore = create<ProjectScopeStoreState>()((set) => ({
  projectScopeKey: null,
  setProjectScopeKey: (projectScopeKey) =>
    set((state) => (state.projectScopeKey === projectScopeKey ? state : { projectScopeKey })),
}));
