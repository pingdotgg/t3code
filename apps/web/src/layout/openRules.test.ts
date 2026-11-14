import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useLayoutBehaviorStore } from "./layoutBehavior";
import { createLayoutState, findLayoutTabByContent } from "./layoutModel";
import { setLayoutStripViewportWidth, useLayoutStore } from "./layoutStore";
import { followLayoutCompanions } from "./openRules";
import { requestLayoutSurfacePlacement, startLayoutSurfaceSync } from "./surfaceSync";

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
  (kind) => {
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
    store.openKeptTab(chat);
    store.openKeptTab(other);
    const chatTab = findLayoutTabByContent(useLayoutStore.getState().layout, chat)!;
    const otherTab = findLayoutTabByContent(useLayoutStore.getState().layout, other)!;
    store.focusTab(chatTab.tab.id);
    using _sync = { [Symbol.dispose]: startLayoutSurfaceSync() };
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

    followLayoutCompanions(() => store.focusTab(otherTab.tab.id));
    expect(widths()).toEqual([1]);
    followLayoutCompanions(() => store.focusTab(chatTab.tab.id));
    expect(widths()).toEqual(expanded);
  },
);
