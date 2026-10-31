import { useLayoutPane } from "../../layout/layoutPaneContext";
import { useAtomMount } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import { type ScopedThreadRef } from "@t3tools/contracts";

import { useUiStateStore } from "../../uiStateStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { findLayoutTab, type LayoutTab } from "../../layout/layoutModel";
import { useLayoutStore } from "../../layout/layoutStore";

function makeVisitTracker() {
  return createThreadVisitTracker({
    dispatchedVisits: new Map(),
    threadShellAtom: environmentThreadShells.threadShellAtom,
    visit: threadEnvironment.visit,
    markLocalVisit: (ref, visitedAt) =>
      useUiStateStore.getState().markThreadVisited(scopedThreadKey(ref), visitedAt),
  });
}

const trackersByTab = new WeakMap<LayoutTab, ReturnType<typeof makeVisitTracker>>();
const loneTracker = makeVisitTracker();
function trackerForTab(tab: LayoutTab | null) {
  if (!tab) return loneTracker;
  let tracker = trackersByTab.get(tab);
  if (!tracker) {
    tracker = makeVisitTracker();
    trackersByTab.set(tab, tracker);
  }
  return tracker;
}

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. The tracker subscribes to
// it outside React, so ChatView keeps reading the quiet shell.
export function ThreadVisitWatermark(props: { readonly threadRef: ScopedThreadRef }) {
  const { visible, tabId } = useLayoutPane();
  const tab = useLayoutStore(
    (state) => findLayoutTab(state.layout, (candidate) => candidate.id === tabId)?.tab ?? null,
  );
  useAtomMount(trackerForTab(tab)(visible ? props.threadRef : null));
  return null;
}
