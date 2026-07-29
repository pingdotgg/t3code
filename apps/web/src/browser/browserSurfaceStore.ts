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
  readonly fittedSourceContent: BrowserSurfaceContentPresentation | null;
  readonly fitSourceContent: boolean;
  readonly cornerRadius: number;
  readonly updatedAt: number;
  readonly owner: symbol | null;
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
  readonly backgroundCaptureCountByTabId: Record<string, number>;
  readonly claim: (tabId: string, owner: symbol, fitSourceContent: boolean) => void;
  readonly present: (
    tabId: string,
    owner: symbol,
    rect: BrowserSurfaceRect,
    visible: boolean,
    cornerRadius: number,
  ) => void;
  readonly presentContent: (tabId: string, content: BrowserSurfaceContentPresentation) => void;
  readonly release: (tabId: string, owner: symbol) => void;
  readonly retainBackgroundCapture: (tabId: string) => void;
  readonly releaseBackgroundCapture: (tabId: string) => void;
}

export interface BrowserSurfaceLease {
  readonly present: (rect: BrowserSurfaceRect, visible: boolean, cornerRadius?: number) => boolean;
  readonly release: () => void;
}

export function selectBrowserSurfaceRenderState(
  state: {
    readonly byTabId: Record<string, BrowserSurfacePresentation>;
    readonly backgroundCaptureCountByTabId: Record<string, number>;
  },
  tabId: string,
) {
  const current = state.byTabId[tabId];
  return {
    backgroundCapture: (state.backgroundCaptureCountByTabId[tabId] ?? 0) > 0,
    content: current?.content ?? null,
    cornerRadius: current?.cornerRadius ?? 0,
    fitSourceContent: current?.fitSourceContent ?? false,
    fittedSourceContent: current?.fittedSourceContent ?? null,
    rect: current?.rect ?? null,
    visible: current?.visible ?? false,
  };
}

export function resolveBrowserSurfacePanelRect(
  byTabId: Readonly<Record<string, BrowserSurfacePresentation>>,
  tabId: string,
): BrowserSurfaceRect | null {
  const current = byTabId[tabId];
  return current?.rect ?? null;
}

export function resolveBrowserSurfaceBackgroundCaptureRect(
  presentedRect: BrowserSurfaceRect | null,
  viewport: { readonly width: number; readonly height: number },
): BrowserSurfaceRect {
  const viewportWidth =
    Number.isFinite(viewport.width) && viewport.width > 0 ? Math.round(viewport.width) : 1280;
  const viewportHeight =
    Number.isFinite(viewport.height) && viewport.height > 0 ? Math.round(viewport.height) : 800;
  if (presentedRect) {
    const width = Math.max(1, Math.min(Math.round(presentedRect.width), viewportWidth));
    const height = Math.max(1, Math.min(Math.round(presentedRect.height), viewportHeight));
    return {
      x: Math.max(0, Math.min(Math.round(presentedRect.x), viewportWidth - width)),
      y: Math.max(0, Math.min(Math.round(presentedRect.y), viewportHeight - height)),
      width,
      height,
    };
  }

  const width = Math.max(1, Math.min(1280, viewportWidth));
  const height = Math.max(1, Math.min(800, viewportHeight));
  return {
    x: Math.max(0, Math.round((viewportWidth - width) / 2)),
    y: Math.max(0, Math.round((viewportHeight - height) / 2)),
    width,
    height,
  };
}

const rectEquals = (left: BrowserSurfaceRect | null, right: BrowserSurfaceRect): boolean =>
  left !== null &&
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;

export const useBrowserSurfaceStore = create<BrowserSurfaceStoreState>()((set) => ({
  byTabId: {},
  backgroundCaptureCountByTabId: {},
  claim: (tabId, owner, fitSourceContent) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner === owner) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            rect: current?.rect ?? null,
            visible: false,
            content: current?.content ?? null,
            fittedSourceContent: fitSourceContent ? (current?.content ?? null) : null,
            fitSourceContent,
            cornerRadius: current?.cornerRadius ?? 0,
            updatedAt: Date.now(),
            owner,
          },
        },
      };
    }),
  present: (tabId, owner, rect, visible, cornerRadius) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner !== owner) return state;
      if (
        current &&
        current.visible === visible &&
        current.cornerRadius === cornerRadius &&
        rectEquals(current.rect, rect)
      ) {
        return state;
      }
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { ...current, rect, visible, cornerRadius, updatedAt: Date.now() },
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
              fittedSourceContent: null,
              fitSourceContent: false,
              cornerRadius: 0,
              updatedAt: Date.now(),
              owner: null,
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
          [tabId]: {
            ...current,
            content,
            fittedSourceContent:
              current.fitSourceContent && current.fittedSourceContent === null
                ? content
                : current.fittedSourceContent,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  release: (tabId, owner) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner !== owner) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            ...current,
            visible: false,
            fittedSourceContent: null,
            fitSourceContent: false,
            updatedAt: Date.now(),
            owner: null,
          },
        },
      };
    }),
  retainBackgroundCapture: (tabId) =>
    set((state) => ({
      backgroundCaptureCountByTabId: {
        ...state.backgroundCaptureCountByTabId,
        [tabId]: (state.backgroundCaptureCountByTabId[tabId] ?? 0) + 1,
      },
    })),
  releaseBackgroundCapture: (tabId) =>
    set((state) => {
      const current = state.backgroundCaptureCountByTabId[tabId] ?? 0;
      if (current <= 0) return state;
      const next = { ...state.backgroundCaptureCountByTabId };
      if (current === 1) {
        delete next[tabId];
      } else {
        next[tabId] = current - 1;
      }
      return { backgroundCaptureCountByTabId: next };
    }),
}));

export function acquireBrowserSurface(
  tabId: string,
  fitSourceContent = false,
): BrowserSurfaceLease {
  const owner = Symbol(`browser-surface:${tabId}`);
  let released = false;
  useBrowserSurfaceStore.getState().claim(tabId, owner, fitSourceContent);

  return {
    present: (rect, visible, cornerRadius = 0) => {
      if (released) return false;
      if (useBrowserSurfaceStore.getState().byTabId[tabId]?.owner !== owner) return false;
      useBrowserSurfaceStore.getState().present(tabId, owner, rect, visible, cornerRadius);
      return true;
    },
    release: () => {
      if (released) return;
      released = true;
      useBrowserSurfaceStore.getState().release(tabId, owner);
    },
  };
}

export function acquireBrowserSurfaceBackgroundCapture(tabId: string): () => void {
  let released = false;
  useBrowserSurfaceStore.getState().retainBackgroundCapture(tabId);
  return () => {
    if (released) return;
    released = true;
    useBrowserSurfaceStore.getState().releaseBackgroundCapture(tabId);
  };
}
