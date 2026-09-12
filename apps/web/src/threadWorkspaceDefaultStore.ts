import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import {
  parseThreadWorkspaceDefault,
  type ThreadWorkspaceDefault,
} from "./threadWorkspaceDefaults";

interface ThreadWorkspaceDefaultStoreState {
  readonly globalDefault: ThreadWorkspaceDefault | null;
  readonly byProjectKey: Readonly<Record<string, ThreadWorkspaceDefault>>;
  readonly saveGlobal: (template: ThreadWorkspaceDefault) => void;
  readonly clearGlobal: () => void;
  readonly saveProject: (projectKey: string, template: ThreadWorkspaceDefault) => void;
  readonly clearProject: (projectKey: string) => void;
}

const THREAD_WORKSPACE_DEFAULT_STORAGE_KEY = "t3code:thread-workspace-defaults:v1";
const THREAD_WORKSPACE_DEFAULT_STORAGE_VERSION = 1;

export function parsePersistedThreadWorkspaceDefaults(input: unknown): {
  readonly globalDefault: ThreadWorkspaceDefault | null;
  readonly byProjectKey: Readonly<Record<string, ThreadWorkspaceDefault>>;
} {
  if (!input || typeof input !== "object") {
    return { globalDefault: null, byProjectKey: {} };
  }
  const globalDefault =
    "globalDefault" in input ? parseThreadWorkspaceDefault(input.globalDefault) : null;
  const rawByProjectKey = "byProjectKey" in input ? input.byProjectKey : null;
  const byProjectKey: Record<string, ThreadWorkspaceDefault> = {};
  if (rawByProjectKey && typeof rawByProjectKey === "object") {
    for (const [projectKey, rawTemplate] of Object.entries(rawByProjectKey)) {
      const template = parseThreadWorkspaceDefault(rawTemplate);
      if (projectKey.length > 0 && template) byProjectKey[projectKey] = template;
    }
  }
  return { globalDefault, byProjectKey };
}

export function selectThreadWorkspaceDefault(
  state: Pick<ThreadWorkspaceDefaultStoreState, "globalDefault" | "byProjectKey">,
  projectKey: string,
): ThreadWorkspaceDefault | null {
  return state.byProjectKey[projectKey] ?? state.globalDefault;
}

export const useThreadWorkspaceDefaultStore = create<ThreadWorkspaceDefaultStoreState>()(
  persist(
    (set) => ({
      globalDefault: null,
      byProjectKey: {},
      saveGlobal: (template) => set({ globalDefault: template }),
      clearGlobal: () => set({ globalDefault: null }),
      saveProject: (projectKey, template) =>
        set((state) => ({
          byProjectKey: { ...state.byProjectKey, [projectKey]: template },
        })),
      clearProject: (projectKey) =>
        set((state) => {
          if (!(projectKey in state.byProjectKey)) return state;
          const { [projectKey]: _removed, ...byProjectKey } = state.byProjectKey;
          return { byProjectKey };
        }),
    }),
    {
      name: THREAD_WORKSPACE_DEFAULT_STORAGE_KEY,
      version: THREAD_WORKSPACE_DEFAULT_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        globalDefault: state.globalDefault,
        byProjectKey: state.byProjectKey,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...parsePersistedThreadWorkspaceDefaults(persistedState),
      }),
    },
  ),
);
