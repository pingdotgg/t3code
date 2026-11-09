import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("local");
const parentRef = scopeThreadRef(environmentId, ThreadId.make("parent"));
const subagentRef = scopeThreadRef(environmentId, ThreadId.make("subagent"));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadLineage: ((ref: typeof subagentRef) =>
    ref.threadId === subagentRef.threadId
      ? { parentThreadId: parentRef.threadId, relationshipToParent: "subagent" }
      : null) as never,
}));

import { closeLayoutTabByUser, closeOtherLayoutTabsByUser } from "./layoutActions";
import {
  createLayoutState,
  findLayoutTab,
  selectFocusedTab,
  type LayoutTabContent,
} from "./layoutModel";
import {
  runInNewLayoutTab,
  subscribeLayoutThreadsClosedByUser,
  useLayoutStore,
} from "./layoutStore";

const parent: LayoutTabContent = { kind: "chat", target: { kind: "server", threadRef: parentRef } };
const subagent: LayoutTabContent = {
  kind: "chat",
  target: { kind: "server", threadRef: subagentRef },
};
const other: LayoutTabContent = {
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make("other")) },
};

function setup(contents: ReadonlyArray<LayoutTabContent>) {
  const original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: createLayoutState() });
  for (const content of contents) {
    useLayoutStore.getState().openTab(content, { placement: "active-pane", position: "end" });
  }
  const closed: unknown[] = [];
  const unsubscribe = subscribeLayoutThreadsClosedByUser((targets) => closed.push(...targets));
  return {
    closed,
    tabOf: (content: LayoutTabContent) =>
      findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.content === content)?.tab,
    chats: () =>
      useLayoutStore
        .getState()
        .layout.workspaces.flatMap((workspace) => workspace.columns)
        .flatMap((column) => column.panes)
        .flatMap((pane) => pane.tabs.map((tab) => tab.content)),
    [Symbol.dispose]: () => {
      unsubscribe();
      useLayoutStore.setState({ layout: original });
    },
  };
}

describe("closeLayoutTabByUser", () => {
  it("returns a subagent's tab to its parent thread without closing or settling the parent", () => {
    using layout = setup([other, subagent]);
    const subagentTab = layout.tabOf(subagent)!;
    closeLayoutTabByUser(subagentTab.id);
    expect(selectFocusedTab(useLayoutStore.getState().layout)).toEqual({
      ...subagentTab,
      content: parent,
    });
    expect(layout.chats()).toEqual([other, parent]);
    expect(layout.closed).toEqual([]);
  });

  it("closes a subagent's tab onto the parent's own tab when the parent is already open", () => {
    using layout = setup([parent, other, subagent]);
    const parentTab = layout.tabOf(parent)!;
    closeLayoutTabByUser(layout.tabOf(subagent)!.id);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(parentTab.id);
    expect(layout.chats()).toEqual([parent, other]);
    expect(layout.closed).toEqual([]);
  });

  it("closes a subagent's tab outright when closing the others", () => {
    using layout = setup([other, subagent]);
    closeOtherLayoutTabsByUser(layout.tabOf(other)!.id);
    expect(layout.chats()).toEqual([other]);
  });
});

describe("runInNewLayoutTab", () => {
  it("keeps a later new tab request when an earlier one settles", async () => {
    vi.useFakeTimers();
    try {
      let finishFirst = () => {};
      const first = runInNewLayoutTab(
        () => new Promise<void>((resolve) => (finishFirst = resolve)),
      );
      // The first route rendered and took its request.
      useLayoutStore.getState().clearNewTabRequest();
      void runInNewLayoutTab(() => new Promise<void>(() => {}));
      finishFirst();
      await first;
      vi.runAllTimers();
      expect(useLayoutStore.getState().newTabRequest).not.toBeNull();
    } finally {
      vi.useRealTimers();
      useLayoutStore.getState().clearNewTabRequest();
    }
  });
});
