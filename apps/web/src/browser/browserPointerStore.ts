import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { create } from "zustand";

interface BrowserPointerStoreState {
  readonly byTabId: Record<string, DesktopPreviewPointerEvent>;
  readonly apply: (event: DesktopPreviewPointerEvent) => void;
  readonly clear: (tabId: string) => void;
}

export const useBrowserPointerStore = create<BrowserPointerStoreState>()((set) => ({
  byTabId: {},
  apply: (event) =>
    set((state) => ({
      byTabId: {
        ...state.byTabId,
        [event.tabId]: event,
      },
    })),
  clear: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTabId)) return state;
      const { [tabId]: _removed, ...byTabId } = state.byTabId;
      return { byTabId };
    }),
}));
