import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

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

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStore>()((set) => ({
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
      if (current.size?.width === size.width && current.size.height === size.height) return state;
      return { byThreadKey: { ...state.byThreadKey, [key]: { ...current, size } } };
    }),
}));

export function selectThreadPreviewMiniPlayer(
  byThreadKey: Readonly<Record<string, PreviewMiniPlayerState>>,
  ref: ScopedThreadRef,
): PreviewMiniPlayerState | null {
  return byThreadKey[scopedThreadKey(ref)] ?? null;
}
