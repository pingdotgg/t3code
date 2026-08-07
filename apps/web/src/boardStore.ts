import { create } from "zustand";

/**
 * Board-local view state. Deliberately not persisted to client settings: a
 * filter is a "right now" narrowing, and reopening the board should show
 * everything rather than a scope the user forgot they set.
 */
interface BoardState {
  /** `environmentId:projectId` key, or null for every project. */
  projectScopeKey: string | null;
  /** Provider instance id, or null for every provider. */
  providerScopeId: string | null;
  searchQuery: string;
  setProjectScopeKey: (key: string | null) => void;
  setProviderScopeId: (instanceId: string | null) => void;
  setSearchQuery: (query: string) => void;
  clearFilters: () => void;
}

export const useBoardStore = create<BoardState>((set) => ({
  projectScopeKey: null,
  providerScopeId: null,
  searchQuery: "",
  setProjectScopeKey: (projectScopeKey) => set({ projectScopeKey }),
  setProviderScopeId: (providerScopeId) => set({ providerScopeId }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  clearFilters: () => set({ projectScopeKey: null, providerScopeId: null, searchQuery: "" }),
}));

export function selectHasBoardFilters(state: BoardState): boolean {
  return (
    state.projectScopeKey !== null ||
    state.providerScopeId !== null ||
    state.searchQuery.trim().length > 0
  );
}
