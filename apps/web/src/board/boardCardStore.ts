import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/**
 * Per-card presentation state for the session board: how tall each card is.
 *
 * This is deliberately client-only, like the board lane assignment. Card
 * height is a property of this screen and should not follow a session to
 * another device.
 *
 * Keyed by `scopedThreadKey`, matching `previewMiniPlayerStore` and the other
 * per-thread client stores.
 */

const BOARD_CARD_STORAGE_KEY = "t3code:board-cards:v1";
const BOARD_CARD_STORAGE_VERSION = 1;

export const CARD_MIN_HEIGHT = 180;
export const CARD_MAX_HEIGHT = 900;
export const CARD_COMPACT_HEIGHT = 260;
export const CARD_TALL_HEIGHT = 520;

export type BoardCardSize = "compact" | "tall";

export interface BoardCardState {
  readonly heightPx: number;
}

interface BoardCardStoreState {
  readonly byThreadKey: Record<string, BoardCardState>;
  readonly setHeight: (ref: ScopedThreadRef, heightPx: number) => void;
  readonly setSize: (ref: ScopedThreadRef, size: BoardCardSize) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

export function clampCardHeight(heightPx: number): number {
  if (!Number.isFinite(heightPx)) return CARD_COMPACT_HEIGHT;
  return Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, Math.round(heightPx)));
}

export function cardSizeForHeight(heightPx: number): BoardCardSize {
  return heightPx >= (CARD_COMPACT_HEIGHT + CARD_TALL_HEIGHT) / 2 ? "tall" : "compact";
}

/** Clamps persisted heights on read, since storage is not trusted blindly. */
function normalizePersistedByThreadKey(persistedState: unknown): Record<string, BoardCardState> {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  const source = (persistedState as { byThreadKey?: unknown }).byThreadKey;
  if (typeof source !== "object" || source === null) return {};
  const byThreadKey: Record<string, BoardCardState> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const height = (value as { heightPx?: unknown } | null)?.heightPx;
    if (typeof height === "number") {
      byThreadKey[key] = { heightPx: clampCardHeight(height) };
    }
  }
  return byThreadKey;
}

export const useBoardCardStore = create<BoardCardStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      setHeight: (ref, heightPx) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const next = clampCardHeight(heightPx);
          if (state.byThreadKey[threadKey]?.heightPx === next) return state;
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { heightPx: next },
            },
          };
        }),
      setSize: (ref, size) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const next = size === "tall" ? CARD_TALL_HEIGHT : CARD_COMPACT_HEIGHT;
          if (state.byThreadKey[threadKey]?.heightPx === next) return state;
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { heightPx: next },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: BOARD_CARD_STORAGE_KEY,
      version: BOARD_CARD_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        byThreadKey: normalizePersistedByThreadKey(persistedState),
      }),
    },
  ),
);

export function selectCardHeight(
  byThreadKey: Record<string, BoardCardState>,
  ref: ScopedThreadRef,
): number {
  return byThreadKey[scopedThreadKey(ref)]?.heightPx ?? CARD_COMPACT_HEIGHT;
}
