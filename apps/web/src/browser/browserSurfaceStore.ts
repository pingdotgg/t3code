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
  readonly zIndex: number;
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
  readonly activityByTabId: Record<string, number>;
  readonly byTabId: Record<string, BrowserSurfacePresentation>;
  readonly acquireActivity: (tabId: string) => () => void;
  readonly claim: (tabId: string, owner: symbol, fitSourceContent: boolean) => void;
  readonly present: (
    tabId: string,
    owner: symbol,
    rect: BrowserSurfaceRect,
    visible: boolean,
    cornerRadius: number,
    zIndex: number,
  ) => void;
  readonly presentContent: (tabId: string, content: BrowserSurfaceContentPresentation) => void;
  readonly release: (tabId: string, owner: symbol) => void;
}

export interface BrowserSurfaceLease {
  readonly present: (
    rect: BrowserSurfaceRect,
    visible: boolean,
    cornerRadius?: number,
    zIndex?: number,
  ) => boolean;
  /** Moves the webview to where the slot shows now; false once another slot owns the tab. */
  readonly place: (placement: BrowserSurfacePlacement) => boolean;
  readonly release: () => void;
}

export function resolveBrowserSurfacePanelRect(
  byTabId: Readonly<Record<string, BrowserSurfacePresentation>>,
  tabId: string,
): BrowserSurfaceRect | null {
  const current = byTabId[tabId];
  return current?.rect ?? null;
}

const rectEquals = (left: BrowserSurfaceRect | null, right: BrowserSurfaceRect): boolean =>
  left !== null &&
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;

export const useBrowserSurfaceStore = create<BrowserSurfaceStoreState>()((set) => ({
  activityByTabId: {},
  byTabId: {},
  acquireActivity: (tabId) => {
    let released = false;
    set((state) => ({
      activityByTabId: {
        ...state.activityByTabId,
        [tabId]: (state.activityByTabId[tabId] ?? 0) + 1,
      },
    }));
    return () => {
      if (released) return;
      released = true;
      set((state) => {
        const count = state.activityByTabId[tabId] ?? 0;
        const activityByTabId = { ...state.activityByTabId };
        if (count <= 1) delete activityByTabId[tabId];
        else activityByTabId[tabId] = count - 1;
        return { activityByTabId };
      });
    };
  },
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
            zIndex: current?.zIndex ?? 30,
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
  present: (tabId, owner, rect, visible, cornerRadius, zIndex) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner !== owner) return state;
      if (
        current &&
        current.visible === visible &&
        current.cornerRadius === cornerRadius &&
        current.zIndex === zIndex &&
        rectEquals(current.rect, rect)
      ) {
        return state;
      }
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { ...current, rect, visible, cornerRadius, zIndex, updatedAt: Date.now() },
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
              zIndex: 30,
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
}));

export const acquireBrowserSurfaceActivity = (tabId: string): (() => void) =>
  useBrowserSurfaceStore.getState().acquireActivity(tabId);

export function acquireBrowserSurface(
  tabId: string,
  fitSourceContent = false,
): BrowserSurfaceLease {
  const owner = Symbol(`browser-surface:${tabId}`);
  let released = false;
  useBrowserSurfaceStore.getState().claim(tabId, owner, fitSourceContent);

  return {
    present: (rect, visible, cornerRadius = 0, zIndex = 30) => {
      if (released) return false;
      if (useBrowserSurfaceStore.getState().byTabId[tabId]?.owner !== owner) return false;
      useBrowserSurfaceStore.getState().present(tabId, owner, rect, visible, cornerRadius, zIndex);
      return true;
    },
    place: (placement) => {
      if (released) return false;
      if (useBrowserSurfaceStore.getState().byTabId[tabId]?.owner !== owner) return false;
      place(tabId, placement);
      return true;
    },
    release: () => {
      if (released) return;
      released = true;
      if (useBrowserSurfaceStore.getState().byTabId[tabId]?.owner === owner) place(tabId, null);
      useBrowserSurfaceStore.getState().release(tabId, owner);
    },
  };
}

/** Placement changes every animation frame, so apply it directly to the webview wrapper instead of
 * rerendering React. */
export interface BrowserSurfacePlacement {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  /** A CSS `clip-path` in the wrapper's own pixels; empty when nothing is cut. */
  readonly clipPath: string;
  readonly interactive: boolean;
}

const placements = new Map<string, BrowserSurfacePlacement>();
const wrappers = new Map<string, HTMLElement>();
/** What each wrapper was last given; the style reads back normalized. */
const written = new WeakMap<HTMLElement, BrowserSurfacePlacement | null>();

function writePlacement(element: HTMLElement, placement: BrowserSurfacePlacement | null): void {
  const last = written.get(element) ?? null;
  if (last === placement) return;
  written.set(element, placement);
  const transform = placement
    ? `translate(${placement.x}px, ${placement.y}px) scale(${placement.scale})`
    : "";
  const lastTransform = last ? `translate(${last.x}px, ${last.y}px) scale(${last.scale})` : "";
  if (transform !== lastTransform) element.style.transform = transform;
  const clipPath = placement?.clipPath ?? "";
  if (clipPath !== (last?.clipPath ?? "")) element.style.clipPath = clipPath;
  if (placement && placement.interactive !== last?.interactive) {
    element.style.pointerEvents = placement.interactive ? "auto" : "none";
  }
}

/**
 * The webview's wrapper for a tab, kept by `HostedBrowserWebview`, which
 * calls this after every render: an active wrapper takes the tab's latest
 * placement, an inactive one drops it.
 */
export function syncBrowserSurfaceWrapper(
  tabId: string,
  element: HTMLElement | null,
  active: boolean,
): void {
  if (!element) {
    wrappers.delete(tabId);
    return;
  }
  wrappers.set(tabId, element);
  // React may have restyled it (pointer events): write it all again.
  written.delete(element);
  writePlacement(element, active ? (placements.get(tabId) ?? null) : null);
}

function place(tabId: string, placement: BrowserSurfacePlacement | null): void {
  if (placement) placements.set(tabId, placement);
  else placements.delete(tabId);
  const element = wrappers.get(tabId);
  const current = useBrowserSurfaceStore.getState().byTabId[tabId];
  if (element) writePlacement(element, current?.visible ? placement : null);
}
