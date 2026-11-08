import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const MAX_TABS = 12;
const SEPARATOR = "\u001f";

/** A top-level tab: a thread, or a file or terminal that belongs to one, as in monocode. */
export type WorkspaceTab =
  | { readonly kind: "thread"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "file"; readonly threadRef: ScopedThreadRef; readonly path: string }
  | { readonly kind: "terminal"; readonly threadRef: ScopedThreadRef; readonly terminalId: string };

export function fileTabKey(threadKey: string, path: string): string {
  return ["file", threadKey, path].join(SEPARATOR);
}

export function terminalTabKey(threadKey: string, terminalId: string): string {
  return ["terminal", threadKey, terminalId].join(SEPARATOR);
}

export function parseWorkspaceTab(key: string): WorkspaceTab | null {
  const [kind, threadKey, value] = key.split(SEPARATOR);
  if (value === undefined) {
    const threadRef = parseScopedThreadKey(key);
    return threadRef ? { kind: "thread", threadRef } : null;
  }
  const threadRef = threadKey ? parseScopedThreadKey(threadKey) : null;
  if (!threadRef || !value) return null;
  if (kind === "file") return { kind, threadRef, path: value };
  if (kind === "terminal") return { kind, threadRef, terminalId: value };
  return null;
}

interface WorkspaceTabsState {
  /** Tab keys, left to right. Per browser: each client keeps its own open set. */
  readonly keys: ReadonlyArray<string>;
  /** The open file or terminal tab shown over the routed thread, or null for the thread itself. */
  readonly surfaceKey: string | null;
  open: (key: string) => void;
  /** Opens a file or terminal tab and shows it. */
  showSurface: (key: string) => void;
  hideSurface: () => void;
  close: (key: string) => void;
}

export const useWorkspaceTabsStore = create<WorkspaceTabsState>()(
  persist(
    (set) => ({
      keys: [],
      surfaceKey: null,
      open: (key) =>
        set((state) =>
          state.keys.includes(key) ? state : { keys: [...state.keys, key].slice(-MAX_TABS) },
        ),
      showSurface: (key) =>
        set((state) => ({
          surfaceKey: key,
          keys: state.keys.includes(key) ? state.keys : [...state.keys, key].slice(-MAX_TABS),
        })),
      hideSurface: () => set((state) => (state.surfaceKey === null ? state : { surfaceKey: null })),
      close: (key) =>
        set((state) => ({
          keys: state.keys.filter((open) => open !== key),
          surfaceKey: state.surfaceKey === key ? null : state.surfaceKey,
        })),
    }),
    {
      name: "t3code:workspace-tabs:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ keys: state.keys }),
    },
  ),
);

/** The tab to show after closing `key`: its right neighbor, else its left one. */
export function neighborTabKey(keys: ReadonlyArray<string>, key: string): string | null {
  const index = keys.indexOf(key);
  if (index === -1) return null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
}
