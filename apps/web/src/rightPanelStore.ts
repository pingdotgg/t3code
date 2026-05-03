/**
 * Per-thread arbiter for the right-side panel.
 *
 * Three tenants share the same slot: the plan sidebar, the diff panel, and
 * the preview panel. Only one is open at a time per thread; the choice is
 * remembered across thread switches.
 *
 * The diff panel still uses `?diff=1` as URL truth for deep-linking — when
 * that param is present the diff tenant wins regardless of what's persisted
 * here. See `selectActiveRightPanelKindWithUrl` for the resolution rule.
 */
import { scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const RIGHT_PANEL_KINDS = ["plan", "diff", "preview"] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v1";

interface ThreadRightPanelState {
  active: RightPanelKind | null;
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  open: (ref: ScopedThreadRef, kind: RightPanelKind) => void;
  close: (ref: ScopedThreadRef) => void;
  toggle: (ref: ScopedThreadRef, kind: RightPanelKind) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const updateThread = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  next: ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey];
  if (current && current.active === next.active) return byThreadKey;
  if (next.active === null) {
    if (!current) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  return { ...byThreadKey, [threadKey]: next };
};

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      open: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), { active: kind }),
        })),
      close: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), { active: null }),
        })),
      toggle: (ref, kind) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const current = state.byThreadKey[threadKey]?.active ?? null;
          const next: RightPanelKind | null = current === kind ? null : kind;
          return {
            byThreadKey: updateThread(state.byThreadKey, threadKey, { active: next }),
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          return { byThreadKey: rest };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  if (!ref) return null;
  return byThreadKey[scopedThreadKey(ref)]?.active ?? null;
}

/**
 * Resolves the active right panel taking the `?diff=1` URL truth into
 * account. When `diff=1` the diff panel always wins.
 *
 * Prefer using `useSyncDiffSearchToRightPanel` (in ChatView) to mirror the
 * URL into the store and consume `selectActiveRightPanel` directly — this
 * helper exists for callers that don't want to install the sync effect.
 */
export function selectActiveRightPanelKindWithUrl(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
  diffSearchActive: boolean,
): RightPanelKind | null {
  if (diffSearchActive) return "diff";
  return selectActiveRightPanel(byThreadKey, ref);
}
