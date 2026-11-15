import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../test/render";
import { pullRequestSurface, useRightPanelStore } from "../rightPanelStore";
import { commitLayoutDrop, isLayoutDropUseful, type LayoutDragSource } from "./layoutDrag";
import {
  createLayoutState,
  findLayoutChatForThread,
  findLayoutSurfaceTabs,
  findLayoutTab,
  selectFocusedTab,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { useLayoutSurfaceSync } from "./surfaceSync";

const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("chat"));
const pullRequestThreadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("pr"));

function SurfaceSync() {
  useLayoutSurfaceSync();
  return null;
}

function setup() {
  const stack = new DisposableStack();
  const layout = useLayoutStore.getState().layout;
  const panels = useRightPanelStore.getState();
  stack.defer(() => useLayoutStore.setState({ layout }));
  stack.defer(() => useRightPanelStore.setState(panels));
  useLayoutStore.setState({ layout: createLayoutState() });
  useRightPanelStore.setState({ byThreadKey: {} });
  useLayoutStore.getState().openTab({ kind: "chat", target: { kind: "server", threadRef } });
  const chatPaneId = findLayoutChatForThread(useLayoutStore.getState().layout, threadRef)!.pane.id;
  return { chatPaneId, [Symbol.dispose]: () => stack.dispose() };
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

  it("opens a thread's pull request beside a chat of another thread, and it survives a reload", async () => {
    using fixture = setup();
    const { chatPaneId } = fixture;
    const source: LayoutDragSource = {
      kind: "surface",
      threadRef: pullRequestThreadRef,
      surface: pullRequestSurface({
        projectId: "project",
        repository: "owner/repo",
        number: 7,
        url: "https://github.com/owner/repo/pull/7",
      }),
    };
    const surfaceTab = () =>
      findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef).find(
        ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === source.surface.id,
      );
    await using screen = await render(createElement(SurfaceSync));

    await act(() => {
      expect(commitLayoutDrop(source, { kind: "side", paneId: chatPaneId, side: "down" })).toBe(
        true,
      );
    });
    const chatColumn = findLayoutChatForThread(useLayoutStore.getState().layout, threadRef)!.column;
    expect(surfaceTab()!.column.id).toBe(chatColumn.id);
    expect(chatColumn.panes.map((pane) => pane.id)).toEqual([chatPaneId, surfaceTab()!.pane.id]);
    expect(findLayoutChatForThread(useLayoutStore.getState().layout, pullRequestThreadRef)).toBe(
      null,
    );
    expect(
      isLayoutDropUseful(useLayoutStore.getState().layout, source, {
        kind: "side",
        paneId: surfaceTab()!.pane.id,
        side: "left",
      }),
    ).toBe(false);

    await screen.unmount();
    await using _reloaded = await render(createElement(SurfaceSync));
    expect(surfaceTab()?.pane.id).toBeDefined();

    await act(() => {
      expect(commitLayoutDrop(source, { kind: "into", paneId: chatPaneId })).toBe(true);
    });
    expect(surfaceTab()!.pane.id).toBe(chatPaneId);
    expect(
      findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef),
    ).toHaveLength(1);
  });
});
