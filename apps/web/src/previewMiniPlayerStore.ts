import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const PREVIEW_MINI_PLAYER_STORAGE_KEY = "t3code:preview-mini-player:v1";

export interface PreviewMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface PreviewMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

export interface PreviewMiniPlayerState {
  readonly tabId: string;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly size: PreviewMiniPlayerSize | null;
}

interface PreviewMiniPlayerStore {
  readonly byThreadKey: Readonly<Record<string, PreviewMiniPlayerState>>;
  readonly open: (ref: ScopedThreadRef, tabId: string) => void;
  readonly close: (ref: ScopedThreadRef) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
  readonly move: (ref: ScopedThreadRef, tabId: string, position: PreviewMiniPlayerPosition) => void;
  readonly resize: (ref: ScopedThreadRef, tabId: string, size: PreviewMiniPlayerSize) => void;
}

interface PersistedPreviewMiniPlayerState {
  readonly byThreadKey: Readonly<Record<string, PreviewMiniPlayerState>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parsePosition = (value: unknown): PreviewMiniPlayerPosition | null | undefined => {
  if (value === null) return null;
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return undefined;
  return { x: value.x, y: value.y };
};

const parseSize = (value: unknown): PreviewMiniPlayerSize | null | undefined => {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.width) ||
    !isFiniteNumber(value.height) ||
    value.width <= 0 ||
    value.height <= 0
  ) {
    return undefined;
  }
  return { width: value.width, height: value.height };
};

export function normalizePersistedPreviewMiniPlayerState(
  value: unknown,
): PersistedPreviewMiniPlayerState {
  if (!isRecord(value) || !isRecord(value.byThreadKey)) return { byThreadKey: {} };
  const byThreadKey: Record<string, PreviewMiniPlayerState> = {};
  for (const [threadKey, candidate] of Object.entries(value.byThreadKey)) {
    if (parseScopedThreadKey(threadKey) === null || !isRecord(candidate)) continue;
    if (typeof candidate.tabId !== "string" || candidate.tabId.length === 0) continue;
    const position = parsePosition(candidate.position);
    const size = parseSize(candidate.size);
    if (position === undefined || size === undefined) continue;
    byThreadKey[threadKey] = { tabId: candidate.tabId, position, size };
  }
  return { byThreadKey };
}

const createPreviewMiniPlayerStorage = () =>
  resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStore>()(
  persist(
    (set) => ({
      byThreadKey: {},
      open: (ref, tabId) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.byThreadKey[key];
          if (current?.tabId === tabId) return state;
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [key]: { tabId, position: current?.position ?? null, size: current?.size ?? null },
            },
          };
        }),
      close: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (!(key in state.byThreadKey)) return state;
          const { [key]: _closed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
      removeThread: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (!(key in state.byThreadKey)) return state;
          const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
      move: (ref, tabId, position) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.byThreadKey[key];
          if (!current || current.tabId !== tabId) return state;
          if (current.position?.x === position.x && current.position.y === position.y) return state;
          return { byThreadKey: { ...state.byThreadKey, [key]: { ...current, position } } };
        }),
      resize: (ref, tabId, size) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.byThreadKey[key];
          if (!current || current.tabId !== tabId) return state;
          if (current.size?.width === size.width && current.size.height === size.height)
            return state;
          return { byThreadKey: { ...state.byThreadKey, [key]: { ...current, size } } };
        }),
    }),
    {
      name: PREVIEW_MINI_PLAYER_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createPreviewMiniPlayerStorage),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedPreviewMiniPlayerState(persistedState),
      }),
    },
  ),
);

export function selectThreadPreviewMiniPlayer(
  byThreadKey: Readonly<Record<string, PreviewMiniPlayerState>>,
  ref: ScopedThreadRef,
): PreviewMiniPlayerState | null {
  return byThreadKey[scopedThreadKey(ref)] ?? null;
}
