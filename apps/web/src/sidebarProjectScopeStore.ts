import { create } from "zustand";

interface SidebarProjectScopeStore {
  readonly projectScopeKey: string | null;
  readonly setProjectScopeKey: (projectScopeKey: string | null) => void;
}

export const useSidebarProjectScopeStore = create<SidebarProjectScopeStore>((set) => ({
  projectScopeKey: null,
  setProjectScopeKey: (projectScopeKey) => set({ projectScopeKey }),
}));
