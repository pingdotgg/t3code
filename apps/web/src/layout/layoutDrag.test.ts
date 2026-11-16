import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { commitLayoutDrop, isLayoutDropUseful, type LayoutDragSource } from "./layoutDrag";
import {
  createLayoutState,
  findLayoutChatForThread,
  findLayoutTab,
  selectFocusedTab,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("chat"));

function setup() {
  const layout = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: createLayoutState() });
  useLayoutStore.getState().openTab({ kind: "chat", target: { kind: "server", threadRef } });
  const chatPaneId = findLayoutChatForThread(useLayoutStore.getState().layout, threadRef)!.pane.id;
  return { chatPaneId, [Symbol.dispose]: () => useLayoutStore.setState({ layout }) };
}

describe("layout drops from sidebar buttons", () => {
  it("places the pull requests page, then moves its one tab instead of opening another", () => {
    using fixture = setup();
    const { chatPaneId } = fixture;
    const source: LayoutDragSource = { kind: "pull-requests" };
    const page = () =>
      findLayoutTab(
        useLayoutStore.getState().layout,
        (tab) => tab.content.kind === "pull-requests",
      );
    const pageTabCount = () =>
      useLayoutStore
        .getState()
        .layout.workspaces.flatMap((workspace) => workspace.columns)
        .flatMap((column) => column.panes)
        .flatMap((pane) => pane.tabs)
        .filter((tab) => tab.content.kind === "pull-requests").length;

    expect(commitLayoutDrop(source, { kind: "side", paneId: chatPaneId, side: "right" })).toBe(
      true,
    );
    expect(page()!.pane.id).not.toBe(chatPaneId);
    expect(page()!.workspace.columns).toHaveLength(2);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.content.kind).toBe("pull-requests");

    const layout = useLayoutStore.getState().layout;
    const pagePaneId = page()!.pane.id;
    expect(isLayoutDropUseful(layout, source, { kind: "into", paneId: pagePaneId })).toBe(false);
    expect(
      isLayoutDropUseful(layout, source, { kind: "side", paneId: pagePaneId, side: "down" }),
    ).toBe(false);
    expect(commitLayoutDrop(source, { kind: "into", paneId: pagePaneId })).toBe(false);
    expect(useLayoutStore.getState().layout).toBe(layout);

    expect(commitLayoutDrop(source, { kind: "into", paneId: chatPaneId })).toBe(true);
    expect(page()!.pane.id).toBe(chatPaneId);
    expect(page()!.workspace.columns).toHaveLength(1);
    expect(pageTabCount()).toBe(1);
  });
});
