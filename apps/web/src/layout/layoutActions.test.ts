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

import { useClosedViewStore } from "../closedViewStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { planNextReopen, reopenClosedView } from "../reopenClosedView";
import {
  closeLayoutTabByUser,
  closeOtherLayoutTabsByUser,
  createLayoutNewTabContent,
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

describe("reopening a closed list page", () => {
  it.each([
    { kind: "issues", href: "/issues?status=closed" },
    { kind: "pull-requests", href: "/pull-requests?state=merged" },
    { kind: "workflows", href: "/workflows" },
  ] as const)("puts the $kind tab back where it was, with its URL", async (content) => {
    using layout = setup([other, content, parent]);
    useClosedViewStore.setState({ entries: [] });
    const page = findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.content === content)!;
    closeLayoutTabByUser(page.tab.id);
    expect(layout.tabOf(content)).toBeUndefined();
    const { restore } = planNextReopen(useClosedViewStore.getState().entries, () => ({
      environmentKnown: true,
      catalogReady: true,
      ownerExists: true,
      sideChatExists: true,
      shellLive: true,
      panel: { isOpen: false, activeSurfaceId: null, surfaces: [] },
    }));
    expect(
      await reopenClosedView(restore!, { openPreview: vi.fn(), workspaceAvailable: true }),
    ).toBe(true);
    const reopened = findLayoutTab(
      useLayoutStore.getState().layout,
      (tab) => tab.content.kind === content.kind,
    )!;
    expect(reopened.tab.content).toEqual(content);
    expect([reopened.pane.id, reopened.tabIndex]).toEqual([page.pane.id, page.tabIndex]);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(reopened.tab.id);
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

describe("createLayoutNewTabContent", () => {
  it("keeps draft context when opening a new tab from a draft's surface tab", () => {
    const draftId = DraftId.make("draft-1");
    const draftThreadRef = scopeThreadRef(environmentId, ThreadId.make("draft-thread"));
    const surface: LayoutTabContent = {
      kind: "surface",
      threadRef: draftThreadRef,
      surfaceId: "files",
    };
    const spy = vi
      .spyOn(useComposerDraftStore.getState(), "getDraftIdByRef")
      .mockReturnValue(draftId);
    try {
      using layout = setup([surface]);
      const surfaceTab = layout.tabOf(surface)!;
      expect(createLayoutNewTabContent(surfaceTab.id).context).toEqual({
        kind: "draft",
        draftId,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
