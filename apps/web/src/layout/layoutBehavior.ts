/**
 * How the layout behaves when things open: where the terminal and the side
 * pane go, which tab the side pane starts on, where new tabs land, and what
 * happens when a new pane has no room. Settings › Layout sets these for
 * this client (`useSyncLayoutBehavior`, mounted once with the layout host).
 */
import type { LayoutSettings } from "@t3tools/contracts";
import { create } from "zustand";

import type { LayoutCompanionKind } from "./layoutModel";

export type {
  LayoutNewTabPosition,
  LayoutSidePaneOpensOn,
  LayoutSidePanePlacement,
  LayoutTerminalPlacement,
  LayoutWhenNoRoom,
} from "@t3tools/contracts";

export type LayoutBehavior = Omit<LayoutSettings, "template"> & {
  /** The share a new terminal or side pane takes from its chat (Your layout). */
  readonly companionShares: Partial<Record<LayoutCompanionKind, number>>;
};

const DEFAULT_LAYOUT_BEHAVIOR: LayoutBehavior = {
  terminalPlacement: "attached-below",
  sidePanePlacement: "beside-chat",
  sidePaneOpensOn: "last-used",
  newTabPosition: "after-current",
  whenNoRoom: "shrink-then-scroll",
  companionShares: {},
};

export const useLayoutBehaviorStore = create<{ behavior: LayoutBehavior }>(() => ({
  behavior: DEFAULT_LAYOUT_BEHAVIOR,
}));

/** The layout behavior for this client. */
export function useLayoutBehavior(): LayoutBehavior {
  return useLayoutBehaviorStore((state) => state.behavior);
}

/** For event handlers and store actions outside React. */
export function getLayoutBehavior(): LayoutBehavior {
  return useLayoutBehaviorStore.getState().behavior;
}
