import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";

const environmentId = EnvironmentId.make("local");
const parentRef = scopeThreadRef(environmentId, ThreadId.make("parent"));
const subagentRef = scopeThreadRef(environmentId, ThreadId.make("subagent"));
const projectId = ProjectId.make("project");

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadLineage: ((ref: typeof subagentRef) =>
    ref.threadId === subagentRef.threadId
      ? { parentThreadId: parentRef.threadId, relationshipToParent: "subagent" }
      : null) as never,
  readThreadShell: ((ref: typeof parentRef) =>
    ref.threadId === parentRef.threadId ? { environmentId, projectId } : null) as never,
  readProjects: () => [],
}));

import { useClosedViewStore } from "../closedViewStore";
import {
  closeLayoutTabByUser,
  closeLayoutTabGroupByUser,
  closeOtherLayoutTabsByUser,
  openLayoutNewThreadTab,
} from "./layoutActions";
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
        .flatMap((pane) => pane.tabs.map((tab) => tab.content))
        .filter((content) => content.kind === "chat"),
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

  it("closes a group's tabs as user closes, so each can reopen, moving focus once", () => {
    const third: LayoutTabContent = {
      kind: "chat",
      target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make("third")) },
    };
    using layout = setup([parent, other, third]);
    const store = useLayoutStore.getState();
    store.createTabGroup(layout.tabOf(parent)!.id, { title: "g", color: "red" });
    const groupId = layout.tabOf(parent)!.groupId!;
    store.addTabToGroup(layout.tabOf(other)!.id, groupId);
    store.focusTab(layout.tabOf(parent)!.id);
    const remembered = useClosedViewStore.getState().entries.length;
    const focused: unknown[] = [];
    const unsubscribe = useLayoutStore.subscribe((state) =>
      focused.push(selectFocusedTab(state.layout)?.content),
    );
    closeLayoutTabGroupByUser(groupId);
    unsubscribe();
    expect(layout.chats()).toEqual([third]);
    expect(useClosedViewStore.getState().entries.length - remembered).toBe(2);
    expect([...new Set(focused)]).toEqual([parent, third]);
  });

  it.each([{ contents: [subagent, other] }, { contents: [parent, subagent, other] }])(
    "closes a background subagent tab without opening or focusing its parent: $contents",
    ({ contents }) => {
      using layout = setup(contents);
      const focused = selectFocusedTab(useLayoutStore.getState().layout);
      closeLayoutTabByUser(layout.tabOf(subagent)!.id);
      expect(selectFocusedTab(useLayoutStore.getState().layout)).toBe(focused);
      expect(layout.chats()).toEqual(contents.filter((content) => content !== subagent));
    },
  );
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

describe("openLayoutNewThreadTab", () => {
  it("starts a thread in the focused thread's project, in a new tab", async () => {
    using _layout = setup([parent]);
    const handleNewThread = vi.fn(async () => {
      expect(useLayoutStore.getState().newTabRequest?.request).toBe("active-pane");
      return null;
    });
    await openLayoutNewThreadTab(handleNewThread);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(environmentId, projectId));
  });

  it("starts a thread in an unsent draft's project from that draft's surface", async () => {
    const draftThreadId = ThreadId.make("draft-thread");
    const draftProjectRef = scopeProjectRef(environmentId, ProjectId.make("draft-project"));
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId("draft-project", draftProjectRef, DraftId.make("draft"), {
        threadId: draftThreadId,
      });
    using _layout = setup([
      {
        kind: "surface",
        threadRef: scopeThreadRef(environmentId, draftThreadId),
        surfaceId: "terminal",
      },
    ]);
    const handleNewThread = vi.fn(async () => null);
    await openLayoutNewThreadTab(handleNewThread);
    expect(handleNewThread).toHaveBeenCalledWith(draftProjectRef);
  });

  it("opens the launcher when no project can take the thread", async () => {
    using layout = setup([other]);
    const handleNewThread = vi.fn(async () => null);
    await openLayoutNewThreadTab(handleNewThread);
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.content.kind).toBe("launcher");
    expect(layout.chats()).toEqual([other]);
  });
});
