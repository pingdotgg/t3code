import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface ThreadBrowserPanelState {
  readonly visible: boolean;
  readonly tabId: string | null;
}

interface RightPanelStoreState {
  readonly browserByThreadKey: Readonly<Record<string, ThreadBrowserPanelState>>;
  readonly openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  readonly closeBrowser: (ref: ScopedThreadRef) => void;
  readonly toggleBrowser: (ref: ScopedThreadRef) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_STATE: ThreadBrowserPanelState = Object.freeze({ visible: false, tabId: null });

/**
 * Narrow adapter between the fork's right-panel/chat boundary and the browser
 * slice. Automation (`preview.open` with `show`) needs to reveal the browser
 * panel from outside React, which the fork's component-local right-panel state
 * cannot express; `ChatView` mirrors this store for the browser slot only.
 */
export const useRightPanelStore = create<RightPanelStoreState>()((set) => ({
  browserByThreadKey: {},
  openBrowser: (ref, tabId) =>
    set((state) => ({
      browserByThreadKey: {
        ...state.browserByThreadKey,
        [scopedThreadKey(ref)]: { visible: true, tabId },
      },
    })),
  closeBrowser: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const current = state.browserByThreadKey[key] ?? EMPTY_STATE;
      if (!current.visible) return state;
      return {
        browserByThreadKey: { ...state.browserByThreadKey, [key]: { ...current, visible: false } },
      };
    }),
  toggleBrowser: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const current = state.browserByThreadKey[key] ?? EMPTY_STATE;
      return {
        browserByThreadKey: {
          ...state.browserByThreadKey,
          [key]: { ...current, visible: !current.visible },
        },
      };
    }),
  removeThread: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (!(key in state.browserByThreadKey)) return state;
      const { [key]: _removed, ...rest } = state.browserByThreadKey;
      return { browserByThreadKey: rest };
    }),
}));

export function readBrowserPanelState(ref: ScopedThreadRef): ThreadBrowserPanelState {
  return useRightPanelStore.getState().browserByThreadKey[scopedThreadKey(ref)] ?? EMPTY_STATE;
}

export function useBrowserPanelState(ref: ScopedThreadRef | null): ThreadBrowserPanelState {
  return useRightPanelStore((state) =>
    ref === null ? EMPTY_STATE : (state.browserByThreadKey[scopedThreadKey(ref)] ?? EMPTY_STATE),
  );
}
