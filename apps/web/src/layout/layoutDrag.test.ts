import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { dropLayoutDrag, moveLayoutDrag, openThreadToTheSide } from "./layoutDrag";
import { createLayoutState, selectFocusedWorkspace, type LayoutTabContent } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

const environmentId = EnvironmentId.make("local");
const chatRef = scopeThreadRef(environmentId, ThreadId.make("chat"));
const droppedRef = scopeThreadRef(environmentId, ThreadId.make("dropped"));
const chat: LayoutTabContent = { kind: "chat", target: { kind: "server", threadRef: chatRef } };
const sidePane: LayoutTabContent = { kind: "surface", threadRef: chatRef, surfaceId: "pr" };

function rect(left: number, right: number) {
  return { left, right, top: 0, bottom: 800, width: right - left, height: 800 };
}

function setupChatWithSidePane() {
  const original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: createLayoutState() });
  const store = useLayoutStore.getState();
  store.openTab(chat, { placement: "active-pane", position: "end" });
  const chatPaneId = selectFocusedWorkspace(useLayoutStore.getState().layout).focusedPaneId!;
  store.placeContent(sidePane, { kind: "split", paneId: chatPaneId, side: "right" });
  const columns = () =>
    selectFocusedWorkspace(useLayoutStore.getState().layout).columns.map((column) =>
      column.panes.flatMap((pane) => pane.tabs.map((tab) => tab.content)),
    );
  const panes = selectFocusedWorkspace(useLayoutStore.getState().layout).columns.map(
    (column, index) => ({
      dataset: { layoutPaneId: column.panes[0]!.id },
      getBoundingClientRect: () => rect(index * 500, index * 500 + 500),
      querySelectorAll: () => [],
    }),
  );
  vi.stubGlobal("document", {
    querySelector: () => ({ getBoundingClientRect: () => rect(0, 1000) }),
    querySelectorAll: () => panes,
  });
  return {
    columns,
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      useLayoutStore.setState({ layout: original });
    },
  };
}

describe("dropLayoutDrag", () => {
  it("puts a thread dropped on a chat's right half between the chat and its side pane", () => {
    using layout = setupChatWithSidePane();
    expect(layout.columns()).toEqual([[chat], [sidePane]]);

    moveLayoutDrag({ kind: "thread", threadRef: droppedRef }, { x: 450, y: 400 });
    expect(dropLayoutDrag()).toBe(true);

    expect(layout.columns()).toEqual([
      [chat],
      [{ kind: "chat", target: { kind: "server", threadRef: droppedRef } }],
      [sidePane],
    ]);
  });

  it("opens a thread to the side after the chat's side pane from the menu", () => {
    using layout = setupChatWithSidePane();

    openThreadToTheSide(droppedRef);

    expect(layout.columns()).toEqual([
      [chat],
      [sidePane],
      [{ kind: "chat", target: { kind: "server", threadRef: droppedRef } }],
    ]);
  });
});
