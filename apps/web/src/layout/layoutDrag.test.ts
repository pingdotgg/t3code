import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { cancelLayoutDrag, dropLayoutDrag, moveLayoutDrag } from "./layoutDrag";
import {
  createLayoutState,
  findLayoutChatForThread,
  findLayoutPane,
  selectFocusedPane,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

function setup() {
  const original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: createLayoutState() });
  const refs = ["A", "B", "C", "D"].map((id) =>
    scopeThreadRef(EnvironmentId.make("local"), ThreadId.make(id)),
  );
  for (const threadRef of refs.slice(0, 3)) {
    useLayoutStore
      .getState()
      .openTab(
        { kind: "chat", target: { kind: "server", threadRef } },
        { placement: "active-pane", position: "end" },
      );
  }
  const ownPaneId = selectFocusedPane(useLayoutStore.getState().layout)!.id;
  useLayoutStore
    .getState()
    .placeContent(
      { kind: "chat", target: { kind: "server", threadRef: refs[3]! } },
      { kind: "split", paneId: ownPaneId, side: "right" },
    );
  const otherPaneId = findLayoutChatForThread(useLayoutStore.getState().layout, refs[3]!)!.pane.id;
  const rect = (left: number, right: number, bottom = 400) => ({
    left,
    right,
    top: 0,
    bottom,
    width: right - left,
    height: bottom,
  });
  const panes = [ownPaneId, otherPaneId].map((paneId, index) => {
    const left = 20 + index * 420;
    const pane = findLayoutPane(useLayoutStore.getState().layout, paneId)!.pane;
    return {
      dataset: { layoutPaneId: paneId },
      getBoundingClientRect: () => rect(left, left + 400),
      querySelectorAll: () =>
        pane.tabs.map((tab, tabIndex) => ({
          dataset: { layoutPaneTab: tab.id },
          getBoundingClientRect: () => rect(left + tabIndex * 100, left + (tabIndex + 1) * 100, 48),
        })),
    };
  });
  vi.stubGlobal("document", {
    querySelector: () => ({ getBoundingClientRect: () => rect(0, 860) }),
    querySelectorAll: () => panes,
  });
  return {
    threadRef: refs[0]!,
    ownPaneId,
    otherPaneId,
    tabIds: refs.map(
      (ref) => findLayoutChatForThread(useLayoutStore.getState().layout, ref)!.tab.id,
    ),
    [Symbol.dispose]: () => {
      cancelLayoutDrag();
      vi.unstubAllGlobals();
      useLayoutStore.setState({ layout: original });
    },
  };
}

describe("sidebar thread drops", () => {
  it.each([
    { drop: "before B in its own pane", x: 130, own: [0, 1, 2], other: [3] },
    { drop: "after C in its own pane", x: 400, own: [1, 2, 0], other: [3] },
    { drop: "before D in another pane", x: 450, own: [1, 2], other: [0, 3] },
  ])("places an already-open thread $drop", ({ x, own, other }) => {
    using layout = setup();
    moveLayoutDrag({ kind: "thread", threadRef: layout.threadRef }, { x, y: 20 });
    expect(dropLayoutDrag()).toBe(true);
    const state = useLayoutStore.getState().layout;
    expect(findLayoutPane(state, layout.ownPaneId)!.pane.tabs.map((tab) => tab.id)).toEqual(
      own.map((index) => layout.tabIds[index]),
    );
    expect(findLayoutPane(state, layout.otherPaneId)!.pane.tabs.map((tab) => tab.id)).toEqual(
      other.map((index) => layout.tabIds[index]),
    );
  });
});
