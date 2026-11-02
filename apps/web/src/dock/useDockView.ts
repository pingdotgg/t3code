import type { ScopedThreadRef } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { useSidebar } from "../components/ui/sidebar";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { CHAT_GROUP_ID } from "./dockLayout";
import { useDockLayoutStore, type DockLayout } from "./dockLayoutStore";
import { resolveDockView } from "./dockView";

/** Below the inline breakpoint panels open as sheets, so the chat fills the workspace. */
const NARROW_LAYOUT: DockLayout = {
  root: { kind: "group", id: CHAT_GROUP_ID },
  kindGroups: {},
};

export function useDockView(threadRef: ScopedThreadRef | null) {
  const narrow = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const { open, isMobile } = useSidebar();
  const side = useDockLayoutStore((state) => state.threadsSide);
  const stored = useDockLayoutStore(useShallow(({ root, kindGroups }) => ({ root, kindGroups })));
  const thread = useRightPanelStore((state) =>
    threadRef && !narrow ? selectThreadRightPanelState(state.byThreadKey, threadRef) : null,
  );
  return resolveDockView({
    layout: narrow ? NARROW_LAYOUT : stored,
    thread,
    threadsSide: open && !isMobile ? side : null,
  });
}
