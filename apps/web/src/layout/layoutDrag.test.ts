import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useDiffPanelStore } from "../diffPanelStore";
import { fileSurface, selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useLayoutBehaviorStore } from "./layoutBehavior";
import {
  commitLayoutDrop,
  isLayoutDropUseful,
  type LayoutDragSource,
  type LayoutDragSurface,
} from "./layoutDrag";
import {
  createLayoutState,
  createLayoutTab,
  findLayoutChatForThread,
  findLayoutTab,
  selectFocusedTab,
  type LayoutColumn,
  type LayoutState,
  type LayoutTab,
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

  it("moves the pull requests page out of another workspace to the focused workspace's edges", () => {
    const behavior = useLayoutBehaviorStore.getState().behavior;
    using _fixture = setup();
    using _restore = { [Symbol.dispose]: () => useLayoutBehaviorStore.setState({ behavior }) };
    useLayoutBehaviorStore.setState({ behavior: { ...behavior, scrollingWorkspaces: true } });
    const column = (id: string, tabs: LayoutTab[]): LayoutColumn => ({
      id,
      width: 1,
      panes: [{ id: `${id}-pane`, tabs, activeTabId: tabs[0]!.id, size: 1 }],
    });
    const workspace = (id: string, columns: LayoutColumn[]) => ({
      id,
      name: null,
      focusedPaneId: columns[0]?.panes[0]!.id ?? null,
      cameraWidth: null,
      columns,
    });
    const page = createLayoutTab({ kind: "pull-requests" });
    const layout: LayoutState = {
      focusedWorkspaceId: "focused",
      workspaces: [
        workspace("focused", [
          column("chat", [
            createLayoutTab({ kind: "chat", target: { kind: "server", threadRef } }),
          ]),
        ]),
        workspace("other", [
          column("page", [page]),
          column("other-chat", [
            createLayoutTab({
              kind: "chat",
              target: {
                kind: "server",
                threadRef: scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("other")),
              },
            }),
          ]),
        ]),
        workspace("trailing", []),
      ],
    };
    const source: LayoutDragSource = { kind: "pull-requests" };

    expect(isLayoutDropUseful(layout, source, { kind: "extend", edge: "left" })).toBe(true);
    expect(isLayoutDropUseful(layout, source, { kind: "extend", edge: "right" })).toBe(true);
    expect(isLayoutDropUseful(layout, source, { kind: "extend", edge: "bottom" })).toBe(true);

    useLayoutStore.setState({ layout });
    expect(commitLayoutDrop(source, { kind: "extend", edge: "right" })).toBe(true);
    const moved = findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === page.id)!;
    expect(moved.workspace.id).toBe("focused");
    expect(moved.workspace.columns.at(-1)!.panes[0]!.tabs.map((tab) => tab.id)).toEqual([page.id]);
  });
});

describe("layout drops of a thread's surfaces", () => {
  const surfaceThreadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("surfaces"));
  const runId = RunId.make("run-1");

  function setupSurfaceDrop() {
    const stack = new DisposableStack();
    const { chatPaneId } = stack.use(setup());
    const panels = useRightPanelStore.getState();
    const diffs = useDiffPanelStore.getState();
    const terminals = useTerminalUiStateStore.getState();
    stack.defer(() => useRightPanelStore.setState(panels));
    stack.defer(() => useDiffPanelStore.setState(diffs));
    stack.defer(() => useTerminalUiStateStore.setState(terminals));
    useRightPanelStore.setState({ byThreadKey: {} });
    useDiffPanelStore.setState({ byThreadKey: {} });
    useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
    useTerminalUiStateStore.getState().ensureTerminal(surfaceThreadRef, "default");
    useTerminalUiStateStore.getState().setTerminalOpen(surfaceThreadRef, false);
    return { chatPaneId, [Symbol.dispose]: () => stack.dispose() };
  }

  const panel = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, surfaceThreadRef);
  const terminalOpen = () =>
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      surfaceThreadRef,
    ).terminalOpen;

  it.each<{
    name: string;
    surface: LayoutDragSurface;
    resolvesTo?: LayoutDragSurface;
    opened: () => void;
  }>([
    {
      name: "a file link at the path its click resolves, at its line",
      surface: fileSurface("cloud/http.ts", 42, 0),
      resolvesTo: fileSurface("packages/app/cloud/http.ts", 42, 0),
      opened: () =>
        expect(panel().surfaces).toEqual([
          expect.objectContaining({ id: "file:packages/app/cloud/http.ts", revealLine: 42 }),
        ]),
    },
    {
      name: "a turn's diff at its file",
      surface: { id: "diff", kind: "diff", runId, filePath: "src/app.ts" },
      opened: () =>
        expect(useDiffPanelStore.getState().byThreadKey).toEqual({
          "env:surfaces": expect.objectContaining({
            kind: "turn",
            turnId: runId,
            filePath: "src/app.ts",
          }),
        }),
    },
    {
      name: "the thread's hidden terminal",
      surface: { id: "thread-terminal", kind: "thread-terminal" },
      opened: () => expect(terminalOpen()).toBe(true),
    },
    {
      name: "a browser tab",
      surface: { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" },
      opened: () => {},
    },
  ])("opens $name when dropped", async ({ surface, resolvesTo, opened }) => {
    using fixture = setupSurfaceDrop();
    const { chatPaneId } = fixture;
    const resolved = resolvesTo && Promise.resolve(resolvesTo);
    const source: LayoutDragSource = {
      kind: "surface",
      threadRef: surfaceThreadRef,
      surface,
      ...(resolved ? { resolve: () => resolved } : {}),
    };
    expect(terminalOpen()).toBe(false);

    expect(commitLayoutDrop(source, { kind: "side", paneId: chatPaneId, side: "right" })).toBe(
      true,
    );
    await resolved;
    const opens = resolvesTo ?? surface;
    if (opens.kind !== "thread-terminal") {
      expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: opens.id });
    }
    opened();
  });

  function resolvingFileDrop(path: string) {
    let settle!: (surface: LayoutDragSurface) => void;
    const resolved = new Promise<LayoutDragSurface>((resolve) => {
      settle = resolve;
    });
    const source: LayoutDragSource = {
      kind: "surface",
      threadRef: surfaceThreadRef,
      surface: fileSurface("cloud/http.ts", 3, 0),
      resolve: () => resolved,
    };
    return { source, settle: () => settle(fileSurface(path, 3, 0)), resolved };
  }

  it("lands a resolving drop in the workspace focused at the drop after focus moves", async () => {
    using _fixture = setupSurfaceDrop();
    const column = (id: string, tabs: LayoutTab[]): LayoutColumn => ({
      id,
      width: 1,
      panes: [{ id: `${id}-pane`, tabs, activeTabId: tabs[0]!.id, size: 1 }],
    });
    const workspace = (id: string, columns: LayoutColumn[]) => ({
      id,
      name: null,
      focusedPaneId: columns[0]!.panes[0]!.id,
      cameraWidth: null,
      columns,
    });
    const fileTab = createLayoutTab({
      kind: "surface",
      threadRef: surfaceThreadRef,
      surfaceId: "file:packages/app/cloud/http.ts",
    });
    useLayoutStore.setState({
      layout: {
        focusedWorkspaceId: "dropped",
        workspaces: [
          workspace("dropped", [
            column("chat", [
              createLayoutTab({ kind: "chat", target: { kind: "server", threadRef } }),
            ]),
          ]),
          workspace("other", [
            column("file", [fileTab]),
            column("other-chat", [
              createLayoutTab({
                kind: "chat",
                target: { kind: "server", threadRef: surfaceThreadRef },
              }),
            ]),
          ]),
        ],
      },
    });
    useRightPanelStore.getState().openFile(surfaceThreadRef, "packages/app/cloud/http.ts", 1);
    const drop = resolvingFileDrop("packages/app/cloud/http.ts");

    expect(commitLayoutDrop(drop.source, { kind: "extend", edge: "right" })).toBe(true);
    useLayoutStore.setState({
      layout: { ...useLayoutStore.getState().layout, focusedWorkspaceId: "other" },
    });
    drop.settle();
    await drop.resolved;

    const moved = findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === fileTab.id)!;
    expect(moved.workspace.id).toBe("dropped");
    expect(moved.workspace.columns.at(-1)!.panes[0]!.tabs.map((tab) => tab.id)).toEqual([
      fileTab.id,
    ]);
  });

  it("drops nothing when the pane a resolving drop targets closes before it resolves", async () => {
    using fixture = setupSurfaceDrop();
    const drop = resolvingFileDrop("packages/app/cloud/http.ts");

    expect(
      commitLayoutDrop(drop.source, { kind: "side", paneId: fixture.chatPaneId, side: "right" }),
    ).toBe(true);
    const closed = createLayoutState();
    useLayoutStore.setState({ layout: closed });
    drop.settle();
    await drop.resolved;

    expect(useLayoutStore.getState().layout).toBe(closed);
    expect(panel().surfaces).toEqual([]);
  });
});
