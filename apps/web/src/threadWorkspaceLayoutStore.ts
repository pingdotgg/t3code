import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import {
  createThreadWorkspaceTabFields,
  parsePersistedThreadWorkspaceTabs,
  transitionThreadWorkspaceTabs,
  type ThreadWorkspaceTabFields,
  type ThreadWorkspaceTabTransition,
} from "./threadWorkspaceTabs";

interface ThreadWorkspaceLayoutStoreState {
  readonly byThreadKey: Readonly<Record<string, ThreadWorkspaceTabFields>>;
  readonly transition: (
    ref: ScopedThreadRef,
    input: ThreadWorkspaceTabTransition,
  ) => ThreadWorkspaceTabFields;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

const THREAD_WORKSPACE_LAYOUT_STORAGE_KEY = "t3code:thread-workspace-layout:v1";
const THREAD_WORKSPACE_LAYOUT_STORAGE_VERSION = 1;
const EMPTY_THREAD_WORKSPACE_LAYOUT = createThreadWorkspaceTabFields();

export function parsePersistedThreadWorkspaceLayouts(input: unknown): {
  readonly byThreadKey: Readonly<Record<string, ThreadWorkspaceTabFields>>;
} {
  return parsePersistedThreadWorkspaceTabs(input);
}

export function selectThreadWorkspaceLayout(
  byThreadKey: Readonly<Record<string, ThreadWorkspaceTabFields>>,
  ref: ScopedThreadRef | null | undefined,
): ThreadWorkspaceTabFields {
  return ref
    ? (byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_WORKSPACE_LAYOUT)
    : EMPTY_THREAD_WORKSPACE_LAYOUT;
}

export const useThreadWorkspaceLayoutStore = create<ThreadWorkspaceLayoutStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      transition: (ref, input) => {
        const threadKey = scopedThreadKey(ref);
        const current = get().byThreadKey[threadKey] ?? EMPTY_THREAD_WORKSPACE_LAYOUT;
        const next = transitionThreadWorkspaceTabs(current, input);
        if (next !== current) {
          set((state) => ({ byThreadKey: { ...state.byThreadKey, [threadKey]: next } }));
        }
        return next;
      },
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: THREAD_WORKSPACE_LAYOUT_STORAGE_KEY,
      version: THREAD_WORKSPACE_LAYOUT_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...parsePersistedThreadWorkspaceLayouts(persistedState),
      }),
    },
  ),
);

export function transitionThreadWorkspaceLayout(
  ref: ScopedThreadRef,
  input: ThreadWorkspaceTabTransition,
): ThreadWorkspaceTabFields {
  return useThreadWorkspaceLayoutStore.getState().transition(ref, input);
}
