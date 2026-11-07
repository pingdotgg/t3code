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
  /**
   * Labs › Scrolling workspaces. Off, `whenNoRoom` is always "always-shrink" and the
   * workspace, overview and strip-scroll commands do nothing.
   */
  readonly scrollingWorkspaces: boolean;
};

const DEFAULT_LAYOUT_BEHAVIOR: LayoutBehavior = {
  terminalPlacement: "attached-below",
  sidePanePlacement: "beside-chat",
  sidePaneOpensOn: "last-used",
  newTabPosition: "after-current",
  whenNoRoom: "always-shrink",
  companionShares: {},
  scrollingWorkspaces: false,
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

/**
 * The layout commands that only drive scrolling workspaces: switching, moving and
 * overviewing workspaces, and centering a column on the strip. With the Labs toggle off
 * they do nothing and are not listed in keybinding settings, the shortcut overlays or
 * the command palette.
 */
const SCROLLING_WORKSPACE_COMMANDS: ReadonlySet<string> = new Set([
  "layout.focusWorkspaceDown",
  "layout.focusWorkspaceUp",
  "layout.moveToWorkspaceDown",
  "layout.moveToWorkspaceUp",
  "layout.moveWorkspaceDown",
  "layout.moveWorkspaceUp",
  "layout.overview",
  "layout.centerColumn",
]);

export function isScrollingWorkspaceCommand(command: string | null): boolean {
  return command !== null && SCROLLING_WORKSPACE_COMMANDS.has(command);
}

/** Whether the Labs scrolling workspaces are on, for event handlers and store actions. */
export function isScrollingWorkspacesEnabled(): boolean {
  return useLayoutBehaviorStore.getState().behavior.scrollingWorkspaces;
}
