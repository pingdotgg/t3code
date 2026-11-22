import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { selectThreadRightPanelState } from "../rightPanelStore";
import {
  createLayoutState,
  layoutTabContentKey,
  selectFocusedTab,
  selectFocusedWorkspace,
} from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { openSideThread, resolveThreadOpenRoute } from "./sideChatPane";

const environmentId = EnvironmentId.make("environment:test");
const mainRef = scopeThreadRef(environmentId, ThreadId.make("main"));
const sideChatRef = scopeThreadRef(environmentId, ThreadId.make("side-chat"));

it("routes a side chat to its parent with the side chat tab active", () => {
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  const route = resolveThreadOpenRoute(sideChatRef, {
    lineage: { sideChat: true, parentThreadId: mainRef.threadId } as never,
  });

  expect(route).toEqual(mainRef);
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, mainRef)?.id,
  ).toBe("thread:side-chat");
  expect(
    resolveThreadOpenRoute(mainRef, {
      lineage: { sideChat: false, parentThreadId: null } as never,
    }),
  ).toBe(mainRef);
});

it("opens a side thread beside the thread the click was in, or in its place", () => {
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  const navigated: unknown[] = [];
  const open = (
    input: Pick<Parameters<typeof openSideThread>[0], "threadRef" | "panelRef" | "intent">,
  ) => openSideThread({ ...input, navigate: (ref) => void navigated.push(ref) });
  const surfaces = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, mainRef).surfaces;

  expect(open({ threadRef: sideChatRef, panelRef: mainRef, intent: "primary" })).toBe("panel");
  expect(surfaces().map((surface) => surface.id)).toEqual(["thread:side-chat"]);
  expect(navigated).toEqual([]);

  expect(open({ threadRef: sideChatRef, panelRef: mainRef, intent: "alternate" })).toBe("main");
  expect(navigated).toEqual([sideChatRef]);

  // No panel shows a thread beside itself, of another environment, or where there is none.
  const elsewhere = scopeThreadRef(EnvironmentId.make("environment:other"), sideChatRef.threadId);
  expect(open({ threadRef: mainRef, panelRef: mainRef, intent: "panel" })).toBe("main");
  expect(open({ threadRef: elsewhere, panelRef: mainRef, intent: "panel" })).toBe("main");
  expect(open({ threadRef: sideChatRef, panelRef: null, intent: "panel" })).toBe("main");
  expect(navigated).toEqual([sideChatRef, mainRef, elsewhere, sideChatRef]);
  expect(surfaces()).toHaveLength(1);
});

it("opens a side chat in the main view in place of its tab, keeping its parent's tabs", () => {
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  useLayoutStore.setState({ layout: createLayoutState() });
  const store = useLayoutStore.getState();
  store.openTab({ kind: "chat", target: { kind: "server", threadRef: mainRef } });
  const parentTab = selectFocusedTab(useLayoutStore.getState().layout)!;
  store.keepTab(parentTab.id);
  store.openTab({ kind: "surface", threadRef: mainRef, surfaceId: "diff" });
  store.openTab(
    { kind: "surface", threadRef: mainRef, surfaceId: "thread:side-chat" },
    { placement: "new-column" },
  );
  const sideTab = selectFocusedTab(useLayoutStore.getState().layout)!;
  store.focusTab(parentTab.id);
  const tabsOf = (paneIndex: number) => {
    const { columns } = selectFocusedWorkspace(useLayoutStore.getState().layout);
    const pane = columns.flatMap((column) => column.panes)[paneIndex]!;
    return pane.tabs.map((tab) => [tab.id, layoutTabContentKey(tab.content)]);
  };
  const parentPane = tabsOf(0);
  const navigated: unknown[] = [];

  expect(
    openSideThread({
      threadRef: sideChatRef,
      panelRef: mainRef,
      intent: "alternate",
      navigate: (ref) => void navigated.push(ref),
    }),
  ).toBe("main");

  // The focused tab's route follows on its own, as after a tab click.
  expect(navigated).toEqual([]);
  expect(tabsOf(0)).toEqual(parentPane);
  expect(tabsOf(1)).toEqual([
    [
      sideTab.id,
      layoutTabContentKey({ kind: "chat", target: { kind: "server", threadRef: sideChatRef } }),
    ],
  ]);
  expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(sideTab.id);
});
