import type { ScopedThreadRef } from "@t3tools/contracts";
import { LayoutDashboard, MessageSquareReply } from "lucide-react";
import { createElement } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  type ModeSurfaceKind,
  modeSurfaces,
  readThreadDisplay,
  useThreadDisplay,
} from "../displayMode/useThreadDisplayMode";

const MODE_SURFACES = {
  dashboard: { label: "Dashboard", icon: LayoutDashboard },
  replies: { label: "Replies", icon: MessageSquareReply },
} as const satisfies Record<ModeSurfaceKind, unknown>;

/** The right panel's "+" item that opens one tab of the thread's display. */
const modeSurfaceAction = (kind: ModeSurfaceKind, onClick: () => void) => ({
  ...MODE_SURFACES[kind],
  // No key: an empty shortcut matches no key press and renders no hint.
  shortcut: "",
  available: true,
  disabledReason: "",
  onClick,
});

export type ModeSurfaceAction = ReturnType<typeof modeSurfaceAction>;

export const modeSurfaceLabel = (kind: ModeSurfaceKind) => MODE_SURFACES[kind].label;

export const ModeSurfaceIcon = (props: { readonly kind: ModeSurfaceKind }) =>
  createElement(MODE_SURFACES[props.kind].icon, { className: "size-3 shrink-0" });

/** Whether the thread's display has the tab `kind`, read outside React. Other tabs need no display. */
export function threadHasModeSurface(threadRef: ScopedThreadRef, kind: string): boolean {
  if (!(kind in MODE_SURFACES)) return true;
  return modeSurfaces(readThreadDisplay(threadRef)).some((surface) => surface === kind);
}

/** The "+" items that open the tabs of the thread's display: Replies, Dashboard, both or none. */
export function useModeSurfaceActions(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<ModeSurfaceAction> {
  const display = useThreadDisplay(threadRef);
  const open = useStableCallback((kind: ModeSurfaceKind) => {
    if (threadRef !== null) useRightPanelStore.getState().open(threadRef, kind);
  });
  return modeSurfaces(display).map((kind) => modeSurfaceAction(kind, () => open(kind)));
}
