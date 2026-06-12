import { create } from "zustand";

export interface BrowserSurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserSurfacePresentation {
  readonly rect: BrowserSurfaceRect | null;
  readonly visible: boolean;
  readonly updatedAt: number;
}

interface BrowserSurfaceStoreState {
  readonly byTabId: Record<string, BrowserSurfacePresentation>;
  readonly present: (tabId: string, rect: BrowserSurfaceRect, visible: boolean) => void;
  readonly hide: (tabId: string) => void;
}

const rectEquals = (left: BrowserSurfaceRect | null, right: BrowserSurfaceRect): boolean =>
  left !== null &&
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;

export const useBrowserSurfaceStore = create<BrowserSurfaceStoreState>()((set) => ({
  byTabId: {},
  present: (tabId, rect, visible) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current && current.visible === visible && rectEquals(current.rect, rect)) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { rect, visible, updatedAt: Date.now() },
        },
      };
    }),
  hide: (tabId) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (!current || !current.visible) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { ...current, visible: false, updatedAt: Date.now() },
        },
      };
    }),
}));
