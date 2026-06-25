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
  readonly content: BrowserSurfaceContentPresentation | null;
  readonly updatedAt: number;
}

export interface BrowserSurfaceContentPresentation {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

interface BrowserSurfaceStoreState {
  readonly byTabId: Record<string, BrowserSurfacePresentation>;
  readonly present: (tabId: string, rect: BrowserSurfaceRect, visible: boolean) => void;
  readonly presentContent: (tabId: string, content: BrowserSurfaceContentPresentation) => void;
  readonly hide: (tabId: string) => void;
}

export function resolveBrowserSurfacePanelRect(
  byTabId: Readonly<Record<string, BrowserSurfacePresentation>>,
  tabId: string,
): BrowserSurfaceRect | null {
  const current = byTabId[tabId];
  if (current?.visible && current.rect) return current.rect;

  let latestVisible: BrowserSurfacePresentation | undefined;
  for (const presentation of Object.values(byTabId)) {
    if (
      presentation.visible &&
      presentation.rect &&
      (!latestVisible || presentation.updatedAt > latestVisible.updatedAt)
    ) {
      latestVisible = presentation;
    }
  }
  return latestVisible?.rect ?? current?.rect ?? null;
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
          [tabId]: { rect, visible, content: current?.content ?? null, updatedAt: Date.now() },
        },
      };
    }),
  presentContent: (tabId, content) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (!current) {
        return {
          byTabId: {
            ...state.byTabId,
            [tabId]: {
              rect: null,
              visible: false,
              content,
              updatedAt: Date.now(),
            },
          },
        };
      }
      const previous = current.content;
      if (
        previous &&
        previous.x === content.x &&
        previous.y === content.y &&
        previous.width === content.width &&
        previous.height === content.height &&
        previous.scale === content.scale &&
        previous.scrollLeft === content.scrollLeft &&
        previous.scrollTop === content.scrollTop
      ) {
        return state;
      }
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { ...current, content, updatedAt: Date.now() },
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
