import type { ScopedThreadRef } from "@t3tools/contracts";
import { LayoutDashboard, MessageSquareReply, Presentation } from "lucide-react";
import { createElement } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  type ModeSurfaceKind,
  modeSurfaces,
  readThreadDisplay,
  useThreadDisplay,
} from "../displayMode/useThreadDisplayMode";
import {
  boardOfferedFor,
  isBoardHost,
  isTopWindow,
  readThreadProjectRoot,
  useBoardHostRole,
  useBoardOfferedFor,
  useThreadProjectRoot,
} from "../whiteboard/role";

/** The fork's right-panel tabs. `shortcut` is the built-in menu letter; "" is none. */
export const FORK_SURFACES = {
  dashboard: { label: "Dashboard", icon: LayoutDashboard, shortcut: "" },
  replies: { label: "Replies", icon: MessageSquareReply, shortcut: "" },
  whiteboard: { label: "Whiteboard", icon: Presentation, shortcut: "W" },
} as const satisfies Record<ModeSurfaceKind | "whiteboard", unknown>;

type ForkSurfaceKind = keyof typeof FORK_SURFACES;

/** The right panel's "+" and launcher item that opens the fork tab `kind`. */
const forkSurfaceAction = (kind: ForkSurfaceKind, available: boolean, onClick: () => void) => ({
  id: kind,
  label: FORK_SURFACES[kind].label,
  icon: FORK_SURFACES[kind].icon,
  shortcut: FORK_SURFACES[kind].shortcut as string,
  available,
  disabledReason: kind === "whiteboard" ? "Available in a project thread on this machine." : "",
  onClick,
});

export type ModeSurfaceAction = ReturnType<typeof forkSurfaceAction>;

export const modeSurfaceLabel = (kind: ForkSurfaceKind) => FORK_SURFACES[kind].label;

export const ModeSurfaceIcon = (props: { readonly kind: ForkSurfaceKind }) =>
  createElement(FORK_SURFACES[props.kind].icon, { className: "size-3 shrink-0" });

/** Whether the thread offers the tab `kind`, read outside React. Upstream tabs always pass. */
export function threadHasModeSurface(threadRef: ScopedThreadRef, kind: string): boolean {
  if (kind === "whiteboard") return boardOfferedFor(threadRef, readThreadProjectRoot(threadRef));
  if (!(kind in FORK_SURFACES)) return true;
  return modeSurfaces(readThreadDisplay(threadRef)).some((surface) => surface === kind);
}

/** The fork's "+" items: the display's Replies and Dashboard, then Whiteboard on a board host. */
export function useModeSurfaceActions(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<ModeSurfaceAction> {
  const display = useThreadDisplay(threadRef);
  const boardPanel = isBoardHost(useBoardHostRole()) && isTopWindow();
  const projectRoot = useThreadProjectRoot(boardPanel ? threadRef : null);
  const boardOffered = useBoardOfferedFor(threadRef, projectRoot);
  const open = useStableCallback((kind: ForkSurfaceKind) => {
    if (threadRef !== null) useRightPanelStore.getState().open(threadRef, kind);
  });
  return [
    ...modeSurfaces(display).map((kind) => forkSurfaceAction(kind, true, () => open(kind))),
    ...(boardPanel
      ? [forkSurfaceAction("whiteboard", boardOffered, () => open("whiteboard"))]
      : []),
  ];
}
