import type { ScopedThreadRef } from "@t3tools/contracts";

import { MAX_PANES, isSplitLayout } from "../../paneLayout";
import { usePaneLayoutStore } from "../../paneLayoutStore";

/**
 * Open `ref` beside the conversations already showing. `current` is what the single view shows
 * now, which becomes the first pane when this starts a split. The route follows, so the sidebar
 * and links agree with the pane that has focus.
 */
export function openThreadInPane(
  current: ScopedThreadRef | null,
  ref: ScopedThreadRef,
  openRoute: (ref: ScopedThreadRef) => void,
) {
  usePaneLayoutStore.getState().addPane(current, ref);
  openRoute(ref);
}

/** The add-pane drop zone and menu entry both make sense only while a split could start or grow. */
export function canAddPane(current: ScopedThreadRef | null): boolean {
  const layout = usePaneLayoutStore.getState();
  return isSplitLayout(layout) ? layout.panes.length < MAX_PANES : current !== null;
}
