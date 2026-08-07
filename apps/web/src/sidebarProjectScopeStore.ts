import { create } from "zustand";

interface SidebarProjectScopeStore {
  projectScopeKey: string | null;
  setProjectScopeKey: (projectScopeKey: string | null) => void;
}

export const useSidebarProjectScopeStore = create<SidebarProjectScopeStore>((set) => ({
  projectScopeKey: null,
  setProjectScopeKey: (projectScopeKey) => set({ projectScopeKey }),
}));
