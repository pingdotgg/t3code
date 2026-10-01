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
  /**
   * The host paints the device toolbar and resize rails only for presenters
   * that delegate viewport controls to it (native slots). Extension leases
   * render their own viewport controls, so host chrome would double them.
   */
  readonly hostViewportControls: boolean;
  readonly extensionResourceKey: string | null;
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

export interface BrowserExtensionTarget {
  readonly installationId: string;
  readonly tabId: string;
  readonly serverEpoch: string;
  readonly runtimeTabId: string;
}

interface BrowserSurfaceStoreState {
  readonly extensionTargetsByResourceKey: Record<string, BrowserExtensionTarget>;
  readonly requestExtension: (resourceKey: string, target: BrowserExtensionTarget) => void;
  readonly forgetExtension: (resourceKey: string, target: BrowserExtensionTarget) => void;
  readonly activityByTabId: Record<string, number>;
  readonly byTabId: Record<string, BrowserSurfacePresentation>;
  readonly acquireActivity: (tabId: string) => () => void;
  readonly claim: (
    tabId: string,
    owner: symbol,
    fitSourceContent: boolean,
    hostViewportControls?: boolean,
    extensionResourceKey?: string | null,
  ) => void;
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
  readonly release: () => void;
}

export function isExtensionPresented(
  presentation: Pick<BrowserSurfacePresentation, "owner" | "extensionResourceKey"> | undefined,
  resourceKey?: string,
): boolean {
  return (
    presentation?.owner != null &&
    presentation.extensionResourceKey != null &&
    (resourceKey === undefined || presentation.extensionResourceKey === resourceKey)
  );
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
  extensionTargetsByResourceKey: {},
  requestExtension: (resourceKey, target) =>
    set((state) => ({
      extensionTargetsByResourceKey: {
        ...state.extensionTargetsByResourceKey,
        [resourceKey]: target,
      },
    })),
  forgetExtension: (resourceKey, target) =>
    set((state) => {
      if (state.extensionTargetsByResourceKey[resourceKey] !== target) return state;
      const { [resourceKey]: _removed, ...extensionTargetsByResourceKey } =
        state.extensionTargetsByResourceKey;
      return { extensionTargetsByResourceKey };
    }),
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
  claim: (
    tabId,
    owner,
    fitSourceContent,
    hostViewportControls = true,
    extensionResourceKey = null,
  ) =>
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
            hostViewportControls,
            extensionResourceKey,
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
              hostViewportControls: true,
              extensionResourceKey: null,
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

/**
 * Claims the tab's surface. Pass `hostViewportControls: false` when the
 * presenter renders its own viewport controls (extension browser views).
 */
export function acquireBrowserSurface(
  tabId: string,
  fitSourceContent = false,
  hostViewportControls = true,
  extensionResourceKey: string | null = null,
): BrowserSurfaceLease {
  const owner = Symbol(`browser-surface:${tabId}`);
  let released = false;
  useBrowserSurfaceStore
    .getState()
    .claim(tabId, owner, fitSourceContent, hostViewportControls, extensionResourceKey);

  return {
    present: (rect, visible, cornerRadius = 0, zIndex = 30) => {
      if (released) return false;
      if (useBrowserSurfaceStore.getState().byTabId[tabId]?.owner !== owner) return false;
      useBrowserSurfaceStore.getState().present(tabId, owner, rect, visible, cornerRadius, zIndex);
      return true;
    },
    release: () => {
      if (released) return;
      released = true;
      useBrowserSurfaceStore.getState().release(tabId, owner);
    },
  };
}
