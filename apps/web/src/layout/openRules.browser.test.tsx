import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { registerLayoutOpenBesideAction, toggleFocusedSidePaneFill } from "./layoutActions";
import { useLayoutBehaviorStore } from "./layoutBehavior";
import {
  createLayoutState,
  findLayoutTabByContent,
  isLayoutGhostTab,
  selectFocusedTab,
  showLayoutContent,
  type LayoutTabContent,
} from "./layoutModel";
import { setLayoutStripViewportWidth, useLayoutStore } from "./layoutStore";
import { followLayoutCompanions, toggleThreadSidePaneFill } from "./openRules";
import { requestLayoutSurfacePlacement, useLayoutSurfaceSync } from "./surfaceSync";

function SurfaceSync() {
  useLayoutSurfaceSync();
  return null;
}

function setup() {
  const layout = useLayoutStore.getState();
  const behavior = useLayoutBehaviorStore.getState();
  const panel = useRightPanelStore.getState();
  const terminal = useTerminalUiStateStore.getState();
  useLayoutStore.setState({ layout: createLayoutState(), companionShares: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
  useLayoutBehaviorStore.setState({
    behavior: {
      ...behavior.behavior,
      scrollingWorkspaces: true,
      whenNoRoom: "shrink-then-scroll",
      terminalPlacement: "new-column",
      sidePanePlacement: "beside-chat",
    },
  });
  setLayoutStripViewportWidth(1000);
  return {
    [Symbol.dispose]() {
      useLayoutStore.setState(layout);
      useLayoutBehaviorStore.setState(behavior);
      useRightPanelStore.setState(panel);
      useTerminalUiStateStore.setState(terminal);
      setLayoutStripViewportWidth(0);
    },
  };
}

it.each(["terminal", "panel"] as const)(
  "restores resized columns after switching away from a thread with a %s and back",
  async (kind) => {
    using _state = setup();
    const environmentId = EnvironmentId.make("local");
    const threadRef = scopeThreadRef(environmentId, ThreadId.make(`resized-${kind}`));
    const chat = { kind: "chat", target: { kind: "server", threadRef } } as const;
    const other = {
      kind: "chat",
      target: {
        kind: "server",
        threadRef: scopeThreadRef(environmentId, ThreadId.make("other")),
      },
    } as const;
    const store = useLayoutStore.getState();
    store.openTab(chat);
    const chatTab = findLayoutTabByContent(useLayoutStore.getState().layout, chat)!;
    store.focusTab(chatTab.tab.id);
    await using _screen = await render(<SurfaceSync />);
    requestLayoutSurfacePlacement(threadRef, {
      kind: "column",
      workspaceId: chatTab.workspace.id,
      index: 1,
    });
    if (kind === "terminal") useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
    else useRightPanelStore.getState().open(threadRef, "files");
    store.focusTab(chatTab.tab.id);
    store.resizeColumnEdge(chatTab.column.id, 1, 1000);
    const widths = () =>
      useLayoutStore.getState().layout.workspaces[0]!.columns.map((c) => c.width);
    const expanded = widths();
    expect(expanded).toEqual([1, 0.5]);

    followLayoutCompanions(() => store.openTab(other));
    expect(widths()).toEqual([1]);
    followLayoutCompanions(() => store.openTab(chat));
    expect(widths()).toEqual(expanded);
  },
);

it("restores both resized columns when a sidebar open replaced the thread's ghost tab", async () => {
  using _state = setup();
  const environmentId = EnvironmentId.make("local");
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("resized-ghost"));
  const chat = { kind: "chat", target: { kind: "server", threadRef } } as const;
  const other = {
    kind: "chat",
    target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make("other")) },
  } as const;
  // A sidebar click commits the route the way useLayoutRouteSync does.
  const showFromSidebar = (content: LayoutTabContent) =>
    followLayoutCompanions(() => {
      const base = useLayoutStore.getState().layout;
      useLayoutStore
        .getState()
        .commitDerived(base, showLayoutContent(base, content), (current) =>
          showLayoutContent(current, content),
        );
    });
  const store = useLayoutStore.getState();
  showFromSidebar(chat);
  const chatTab = findLayoutTabByContent(useLayoutStore.getState().layout, chat)!;
  expect(isLayoutGhostTab(chatTab.tab)).toBe(true);
  await using _screen = await render(<SurfaceSync />);
  requestLayoutSurfacePlacement(threadRef, {
    kind: "column",
    workspaceId: chatTab.workspace.id,
    index: 1,
  });
  useRightPanelStore.getState().open(threadRef, "files");
  store.focusTab(chatTab.tab.id);
  store.resizeColumnEdge(chatTab.column.id, 1, 1000);
  const widths = () => useLayoutStore.getState().layout.workspaces[0]!.columns.map((c) => c.width);
  const expanded = widths();
  expect(expanded).toEqual([1, 0.5]);

  showFromSidebar(other);
  expect(findLayoutTabByContent(useLayoutStore.getState().layout, other)?.tab.id).toBe(
    chatTab.tab.id,
  );
  expect(widths()).toEqual([1]);
  showFromSidebar(chat);
  expect(widths()).toEqual(expanded);
});

it.each(["closed, pressed from the chat", "open, pressed from the side pane"] as const)(
  "mod+alt+E fills the side pane and a second press from the filled pane restores the layout (pane %s)",
  async (start) => {
    using _state = setup();
    const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("fill-toggle"));
    const chat = { kind: "chat", target: { kind: "server", threadRef } } as const;
    const store = useLayoutStore.getState();
    store.openTab(chat);
    const chatTab = findLayoutTabByContent(useLayoutStore.getState().layout, chat)!;
    store.focusTab(chatTab.tab.id);
    await using _screen = await render(<SurfaceSync />);
    using _chat = {
      [Symbol.dispose]: registerLayoutOpenBesideAction({
        available: new Set(),
        open: () => {},
        fillSidePane: () =>
          toggleThreadSidePaneFill(threadRef, () => {
            useRightPanelStore.getState().open(threadRef, "files");
            return true;
          }),
      }),
    };
    const files = () =>
      findLayoutTabByContent(useLayoutStore.getState().layout, {
        kind: "surface",
        threadRef,
        surfaceId: "files",
      });
    const widths = () =>
      useLayoutStore.getState().layout.workspaces[0]!.columns.map((c) => c.width);
    const paneWasOpen = start === "open, pressed from the side pane";
    if (paneWasOpen) {
      useRightPanelStore.getState().open(threadRef, "files");
      await vi.waitFor(() => expect(files()).toBeDefined());
      store.focusTab(files()!.tab.id);
    }
    const before = widths();
    const focusedBefore = selectFocusedTab(useLayoutStore.getState().layout)?.id;

    expect(toggleFocusedSidePaneFill()).toBe(true);
    await vi.waitFor(() => expect(useLayoutStore.getState().maximizedTabId).toBe(files()?.tab.id));
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(files()!.tab.id);

    expect(toggleFocusedSidePaneFill()).toBe(true);
    expect(useLayoutStore.getState().maximizedTabId).toBeNull();
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(focusedBefore);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
    ).toBe(paneWasOpen);
    await vi.waitFor(() => expect(widths()).toEqual(before));
  },
);
