import type { BrowserDevToolsDock } from "@t3tools/contracts";
import { create } from "zustand";

import { previewBridge } from "~/components/preview/previewBridge";
import { getClientSettings } from "~/hooks/useSettings";

import type { BrowserSurfaceRect } from "./browserSurfaceStore";

export type DockedDevToolsSide = Exclude<BrowserDevToolsDock, "window">;

export interface DockedDevTools {
  readonly side: DockedDevToolsSide;
  /** Fraction of the browser panel given to DevTools. */
  readonly fraction: number;
  /** False until the desktop reports DevTools open; a close after that ends the dock. */
  readonly opened: boolean;
}

interface PreviewDevToolsStoreState {
  readonly byTabId: Record<string, DockedDevTools>;
  readonly request: (tabId: string, side: DockedDevToolsSide) => void;
  readonly syncOpen: (tabId: string, open: boolean) => void;
  readonly resize: (tabId: string, fraction: number) => void;
  readonly clear: (tabId: string) => void;
}

const DEFAULT_DEVTOOLS_FRACTION = 0.5;
const MIN_DEVTOOLS_FRACTION = 0.2;
const MAX_DEVTOOLS_FRACTION = 0.8;

const clampDevToolsFraction = (fraction: number): number =>
  Math.min(MAX_DEVTOOLS_FRACTION, Math.max(MIN_DEVTOOLS_FRACTION, fraction));

export const usePreviewDevToolsStore = create<PreviewDevToolsStoreState>()((set) => ({
  byTabId: {},
  request: (tabId, side) =>
    set((state) => ({
      byTabId: {
        ...state.byTabId,
        [tabId]: {
          side,
          fraction: state.byTabId[tabId]?.fraction ?? DEFAULT_DEVTOOLS_FRACTION,
          opened: false,
        },
      },
    })),
  syncOpen: (tabId, open) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (!current || current.opened === open) return state;
      if (!open) {
        const { [tabId]: _closed, ...byTabId } = state.byTabId;
        return { byTabId };
      }
      return { byTabId: { ...state.byTabId, [tabId]: { ...current, opened: true } } };
    }),
  resize: (tabId, fraction) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (!current) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { ...current, fraction: clampDevToolsFraction(fraction) },
        },
      };
    }),
  clear: (tabId) =>
    set((state) => {
      if (!state.byTabId[tabId]) return state;
      const { [tabId]: _cleared, ...byTabId } = state.byTabId;
      return { byTabId };
    }),
}));

/** Opens DevTools where the user's settings put them, or closes them. */
export async function togglePreviewDevTools(tabId: string, open: boolean): Promise<void> {
  const bridge = previewBridge;
  if (!bridge) return;
  const store = usePreviewDevToolsStore.getState();
  if (open) return bridge.closeDevTools(tabId);
  const dock = getClientSettings().browserDevToolsDock;
  if (dock === "window") return bridge.openDevTools(tabId, false);
  store.request(tabId, dock);
  try {
    await bridge.openDevTools(tabId, true);
  } catch (error) {
    store.clear(tabId);
    throw error;
  }
}

export function splitDockedDevToolsRect(
  rect: BrowserSurfaceRect,
  side: DockedDevToolsSide,
  fraction: number,
): { readonly page: BrowserSurfaceRect; readonly devTools: BrowserSurfaceRect } {
  if (side === "right") {
    const devToolsWidth = Math.round(rect.width * fraction);
    return {
      page: { ...rect, width: rect.width - devToolsWidth },
      devTools: { ...rect, x: rect.x + rect.width - devToolsWidth, width: devToolsWidth },
    };
  }
  const devToolsHeight = Math.round(rect.height * fraction);
  return {
    page: { ...rect, height: rect.height - devToolsHeight },
    devTools: { ...rect, y: rect.y + rect.height - devToolsHeight, height: devToolsHeight },
  };
}
