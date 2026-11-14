import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLayoutState,
  ghostLoneLayoutChats,
  layoutChatSwaps,
  moveLayoutTab,
  moveLayoutTabToWorkspace,
  openLayoutGhostChat,
  openLayoutKeptTab,
  openLayoutTab,
  placeLayoutContent,
  placeLayoutTabs,
  replaceLayoutTabContent,
  resizeLayoutColumnEdge,
  selectFocusedTab,
  selectFocusedWorkspace,
  selectLayoutPaneSlots,
  showLayoutContent,
  type LayoutState,
  type LayoutTab,
  type LayoutTabContent,
  type LayoutTabPlacement,
} from "./layoutModel";
import type { DraftId } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import type { LayoutWhenNoRoom } from "./layoutBehavior";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const chat: LayoutTabContent = { kind: "chat", target: { kind: "server", threadRef } };
const diff: LayoutTabContent = { kind: "surface", threadRef, surfaceId: "diff" };
const next: LayoutTabContent = {
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make("next")) },
};

const columnsOf = (state: LayoutState) =>
  state.workspaces[0]!.columns.map((column) =>
    column.panes.flatMap((pane) => pane.tabs.map((tab) => tab.content)),
  );

/*
 * Layouts as text: workspaces of columns of panes of tabs. `A` is a kept chat of thread A, `~A`
 * its ghost, `t:A` A's terminal, `+` a launcher, `PR` the pull requests page; `*` marks a pane's
 * active tab and `!` the focused one.
 */
type Shape = string[][][];

const refOf = (name: string) => scopeThreadRef(environmentId, ThreadId.make(name));
const chatOf = (name: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: refOf(name) },
});
const draftOf = (name: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "draft", draftId: name as DraftId },
});

function tabOf(label: string): LayoutTab {
  const name = label.replace(/^~/, "");
  const content: LayoutTabContent =
    name === "+"
      ? { kind: "launcher", id: "launcher", context: null }
      : name === "PR"
        ? { kind: "pull-requests" }
        : name.startsWith("t:")
          ? { kind: "surface", threadRef: refOf(name.slice(2)), surfaceId: "thread-terminal" }
          : chatOf(name);
  return { id: name, content, ...(label.startsWith("~") ? { ghostOf: null } : {}) };
}

function layoutOf(...shapes: Shape[]): LayoutState {
  const paneId = (w: number, c: number, p: number) => `w${w}c${c}p${p}`;
  const focus = shapes
    .flatMap((columns, w) =>
      columns.flatMap((panes, c) =>
        panes.flatMap((labels, p) =>
          labels.some((label) => label.includes("!")) ? [{ w, pane: paneId(w, c, p) }] : [],
        ),
      ),
    )
    .at(0);
  const workspaces = shapes.map((columns, w) => ({
    id: `w${w}`,
    name: null,
    cameraWidth: null,
    focusedPaneId: focus?.w === w ? focus.pane : null,
    columns: columns.map((panes, c) => ({
      id: `w${w}c${c}`,
      width: 1,
      panes: panes.map((labels, p) => {
        const tabs = labels.map((label) => tabOf(label.replace(/[*!]/g, "")));
        const active = Math.max(
          labels.findIndex((label) => /[*!]/.test(label)),
          0,
        );
        return { id: paneId(w, c, p), size: 1 / panes.length, tabs, activeTabId: tabs[active]!.id };
      }),
    })),
  }));
  return { workspaces, focusedWorkspaceId: `w${focus?.w ?? 0}` };
}

function shapeOf(state: LayoutState): Shape[] {
  const focused = selectFocusedTab(state);
  return state.workspaces
    .filter((workspace) => workspace.columns.length > 0)
    .map((workspace) =>
      workspace.columns.map((column) =>
        column.panes.map((pane) =>
          pane.tabs.map((tab) => {
            const content = tab.content;
            const name =
              content.kind === "launcher"
                ? "+"
                : content.kind === "pull-requests"
                  ? "PR"
                  : content.kind === "surface"
                    ? `t:${content.threadRef.threadId}`
                    : content.kind === "chat"
                      ? content.target.kind === "server"
                        ? content.target.threadRef.threadId
                        : `draft:${content.target.draftId}`
                      : content.kind;
            const mark =
              tab.id === focused?.id && workspace.id === state.focusedWorkspaceId
                ? "!"
                : tab.id === pane.activeTabId && pane.tabs.length > 1
                  ? "*"
                  : "";
            return `${tab.ghostOf !== undefined ? "~" : ""}${name}${mark}`;
          }),
        ),
      ),
    );
}

const column = (id: string, width: number) => ({
  id,
  width,
  panes: [{ id: `${id}-pane`, tabs: [], activeTabId: null, size: 1 }],
});

function drawnRightEdges(
  state: LayoutState,
  viewportWidth: number,
  whenNoRoom: LayoutWhenNoRoom = "shrink-then-scroll",
): number[] {
  const { slots, stripWidth } = selectLayoutPaneSlots(state.workspaces[0]!, {
    width: viewportWidth,
    whenNoRoom,
  });
  return slots.map((slot) =>
    Math.round((slot.rect.left + slot.rect.width) * stripWidth * viewportWidth),
  );
}

function chatFor(id: string): LayoutTabContent {
  return {
    kind: "chat",
    target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(id)) },
  };
}

function tabContents(state: LayoutState) {
  return state.workspaces.map((workspace) =>
    workspace.columns
      .flatMap((column) => column.panes)
      .flatMap((pane) => pane.tabs.map((tab) => tab.content)),
  );
}

describe("showLayoutContent", () => {
  it("opens a thread in place of the ghost chat whose side panel has focus, not in the panel", () => {
    const withPanel = openLayoutTab(showLayoutContent(createLayoutState(), chat), diff, {
      placement: "new-column",
    });
    expect(selectFocusedTab(withPanel)?.content).toBe(diff);

    const shown = showLayoutContent(withPanel, next);

    expect(columnsOf(shown)).toEqual([[next], [diff]]);
    expect(selectFocusedTab(shown)?.content).toBe(next);
  });

  // A sidebar click on D, per the open rules: a ghost or launcher is replaced in place, a kept
  // tab never is, and a thread already open is focused where it is.
  it.each<{ case: string; layout: Shape[]; expected: Shape[] }>([
    {
      case: "(a) the first open in an empty window is the ghost",
      layout: [],
      expected: [[[["~D!"]]]],
    },
    {
      case: "(a) one pane, its ghost is replaced in place",
      layout: [[[["~A!"]]]],
      expected: [[[["~D!"]]]],
    },
    {
      case: "(a) one pane, a kept tab gets the ghost after it",
      layout: [[[["A!"]]]],
      expected: [[[["A", "~D!"]]]],
    },
    {
      case: "(a) a launcher is replaced in place by the ghost",
      layout: [[[["A", "+!"]]]],
      expected: [[[["A", "~D!"]]]],
    },
    {
      case: "(a) a launcher replaces the pane's previous ghost, keeping its other tabs",
      layout: [[[["~A", "B", "+!", "C"]]]],
      expected: [[[["B", "~D!", "C"]]]],
    },
    {
      case: "(b) several tabs, the focused ghost is replaced in its slot",
      layout: [[[["A", "~B!", "C"]]]],
      expected: [[[["A", "~D!", "C"]]]],
    },
    {
      case: "(b) a focused kept tab keeps its place; the pane's one ghost moves after it",
      layout: [[[["A", "~B", "C!"]]]],
      expected: [[[["A", "C", "~D!"]]]],
    },
    {
      case: "(b) a page tab is kept",
      layout: [[[["PR!"]]]],
      expected: [[[["PR", "~D!"]]]],
    },
    {
      case: "(c) split, focus left: only the left pane changes",
      layout: [[[["A!"]], [["~B"]]]],
      expected: [[[["A", "~D!"]], [["~B"]]]],
    },
    {
      case: "(c) split, focus right: only the right pane changes",
      layout: [[[["A"]], [["~B!"]]]],
      expected: [[[["A"]], [["~D!"]]]],
    },
    {
      case: "(d) already open in the other pane: focus moves there",
      layout: [[[["A!"]], [["D"]]]],
      expected: [[[["A"]], [["D!"]]]],
    },
    {
      case: "(d) already open in a background tab: it becomes active",
      layout: [[[["A!", "D"]]]],
      expected: [[[["A", "D!"]]]],
    },
    {
      case: "(d) already open in another workspace: that workspace takes focus",
      layout: [[[["A!"]]], [[["D*"]]]],
      expected: [[[["A"]]], [[["D!"]]]],
    },
    {
      case: "(e) a focused terminal hands the open to its thread's ghost chat",
      layout: [[[["~A"], ["t:A!"]]]],
      expected: [[[["~D!"], ["t:A"]]]],
    },
    {
      case: "(e) a focused terminal whose thread's chat is kept: the ghost opens after that chat",
      layout: [[[["A"], ["t:A!"]]]],
      expected: [[[["A", "~D!"], ["t:A"]]]],
    },
    {
      case: "(e) a terminal with no chat of its thread is never replaced",
      layout: [[[["B"]], [["t:A!"]]]],
      expected: [[[["B"]], [["t:A", "~D!"]]]],
    },
  ])("$case", ({ layout, expected }) => {
    const state = layout.length === 0 ? createLayoutState() : layoutOf(...layout);
    expect(shapeOf(showLayoutContent(state, chatOf("D")))).toEqual(expected);
  });
});

describe("openLayoutKeptTab", () => {
  // (f) middle click: a kept tab after the open's target, or the open one kept.
  it.each<{ case: string; layout: Shape[]; expected: Shape[] }>([
    {
      case: "a kept tab after the focused tab, the pane's ghost left alone",
      layout: [[[["~A", "B!"]]]],
      expected: [[[["~A", "B", "D!"]]]],
    },
    {
      case: "a kept tab after a focused ghost, never replacing it",
      layout: [[[["~A!"]]]],
      expected: [[[["~A", "D!"]]]],
    },
    {
      case: "a ghost already showing the thread is kept",
      layout: [[[["A!", "~D"]]]],
      expected: [[[["A", "D!"]]]],
    },
  ])("$case", ({ layout, expected }) => {
    expect(shapeOf(openLayoutKeptTab(layoutOf(...layout), chatOf("D")))).toEqual(expected);
  });
});

describe("placeLayoutContent", () => {
  it("places exact side splits before companions while commands keep their grouping", () => {
    const before = openLayoutTab(showLayoutContent(createLayoutState(), chat), diff, {
      placement: "new-column",
    });
    const paneId = before.workspaces[0]!.columns[0]!.panes[0]!.id;
    const withNext = openLayoutTab(before, next, { placement: "new-column" });
    const tabId = selectFocusedTab(withNext)!.id;
    for (const exact of [false, true]) {
      const destination = { kind: "split", paneId, side: "right", exact } as const;
      const expected = exact ? [[chat], [next], [diff]] : [[chat], [diff], [next]];
      const placed = placeLayoutContent(before, next, destination);
      const moved = moveLayoutTab(withNext, tabId, destination);
      expect(columnsOf(placed)).toEqual(expected);
      expect(columnsOf(moved)).toEqual(expected);
      expect(selectFocusedTab(placed)?.content).toBe(next);
      expect(selectFocusedTab(moved)?.content).toBe(next);
    }
  });
});

describe("placeLayoutTabs", () => {
  // An app's open (focus: false) leaves the user where they are, an empty workspace included.
  const focusOn = (state: LayoutState, workspaceId: string) => ({
    ...state,
    focusedWorkspaceId: workspaceId,
  });
  it.each<{ case: string; layout: LayoutState; placement: LayoutTabPlacement; expected: Shape[] }>([
    {
      case: "into another workspace from an empty middle one",
      layout: focusOn(layoutOf([[["A"]]], [], [[["C"]]], []), "w1"),
      placement: { kind: "after", tabId: "C" },
      expected: [[[["A"]]], [[["C*", "X"]]]],
    },
    {
      case: "into another workspace from the empty last one",
      layout: focusOn(layoutOf([[["A"]]], [[["C"]]], []), "w2"),
      placement: { kind: "after", tabId: "C" },
      expected: [[[["A"]]], [[["C*", "X"]]]],
    },
    {
      case: "into a new workspace from an empty middle one",
      layout: focusOn(layoutOf([[["A"]]], [], [[["C"]]], []), "w1"),
      placement: { kind: "column", workspaceId: "w3", index: 0 },
      expected: [[[["A"]]], [[["C"]]], [[["X"]]]],
    },
    {
      case: "an exact side split from an empty workspace preserves focus",
      layout: focusOn(layoutOf([[["A"]], [["t:A"]]], []), "w1"),
      placement: { kind: "split", paneId: "w0c0p0", side: "right", exact: true },
      expected: [[[["A"]], [["X"]], [["t:A"]]]],
    },
    {
      case: "into the focused workspace",
      layout: layoutOf([[["A!"]], [["B"]]], []),
      placement: { kind: "after", tabId: "B" },
      expected: [[[["A!"]], [["B*", "X"]]]],
    },
  ])("$case", ({ layout, placement, expected }) => {
    const placed = placeLayoutTabs(layout, [tabOf("X")], placement, {
      activate: null,
      focus: false,
    });
    expect(shapeOf(placed)).toEqual(expected);
    expect(placed.focusedWorkspaceId).toBe(layout.focusedWorkspaceId);
  });
});

describe("ghost tabs", () => {
  it("stay ghosts when a sent first message promotes their draft", () => {
    const state = showLayoutContent(createLayoutState(), draftOf("draft"));
    const promoted = replaceLayoutTabContent(state, selectFocusedTab(state)!.id, chatOf("D"));
    expect(shapeOf(promoted)).toEqual([[[["~D!"]]]]);
  });

  it("keep a plain ghost parent when its lineage child opens beside it", () => {
    const opened = openLayoutGhostChat(layoutOf([[["~A!"]]]), refOf("A"), {
      kind: "server",
      threadRef: refOf("child"),
    });
    expect(opened && shapeOf(opened)).toEqual([[[["A", "~child!"]]]]);
  });

  it("start as the lone chat of a layout saved before ghosts", () => {
    expect(shapeOf(ghostLoneLayoutChats(layoutOf([[["A!"]]])))).toEqual([[[["~A!"]]]]);
    expect(shapeOf(ghostLoneLayoutChats(layoutOf([[["A!", "B"]]])))).toEqual([[[["A!", "B"]]]]);
  });
});

describe("layoutChatSwaps", () => {
  // Companions follow the chat: the thread swapped off a pane hides its terminal and side panes.
  it.each<{ case: string; before: Shape[]; after: Shape[]; swaps: string[] }>([
    {
      case: "a ghost replaced in place",
      before: [[[["~A!"]]]],
      after: [[[["~D!"]]]],
      swaps: ["A>D"],
    },
    {
      case: "a kept chat with a ghost opened after it",
      before: [[[["A!"]]]],
      after: [[[["A", "~D!"]]]],
      swaps: ["A>D"],
    },
    {
      case: "focus moving to a thread open in the other pane",
      before: [[[["A!"]], [["D"]]]],
      after: [[[["A"]], [["D!"]]]],
      swaps: [],
    },
    {
      case: "a ghost opening beside a terminal with no chat",
      before: [[[["t:A!"]]]],
      after: [[[["t:A", "~D!"]]]],
      swaps: [],
    },
  ])("$case", ({ before, after, swaps }) => {
    const name = (target: ThreadRouteTarget) =>
      target.kind === "server" ? target.threadRef.threadId : target.kind;
    expect(
      layoutChatSwaps(layoutOf(...before), layoutOf(...after)).map(
        ({ from, to }) => `${name(from)}>${name(to)}`,
      ),
    ).toEqual(swaps);
  });
});

describe("placeLayoutTabs", () => {
  it("gives an empty workspace a focused pane when a surface arrives in the background", () => {
    const before = createLayoutState();
    const tab: LayoutTab = { id: "diff", content: diff };
    const after = placeLayoutTabs(
      before,
      [tab],
      { kind: "column", workspaceId: before.focusedWorkspaceId, index: 0 },
      { activate: null, focus: false },
    );
    expect(selectFocusedTab(after)).toBe(tab);
  });

  it("keeps the current chat focused when a surface arrives in the background", () => {
    const before = layoutOf([[["A!"]]]);
    const after = placeLayoutTabs(
      before,
      [{ id: "diff", content: diff }],
      { kind: "column", workspaceId: before.focusedWorkspaceId, index: 1 },
      { activate: null, focus: false },
    );
    expect(selectFocusedTab(after)).toBe(selectFocusedTab(before));
  });
});

describe("replaceLayoutTabContent", () => {
  it("leaves an open thread alone when the tab to replace has already closed", () => {
    const before = openLayoutTab(createLayoutState(), chat);
    expect(replaceLayoutTabContent(before, "closed-tab", chat)).toBe(before);
  });
});

describe("selectLayoutPaneSlots", () => {
  it("keeps a full-width column on screen when the strip narrows after it was arranged", () => {
    // Arranged with the sidebar closed, then the sidebar opens and the strip narrows.
    const state: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: null,
          cameraWidth: 1300,
          columns: [column("chat", 1), column("terminal", 0.5)],
        },
      ],
    };
    expect(drawnRightEdges(state, 1300)).toEqual([1300, 1950]);
    expect(drawnRightEdges(state, 1000)).toEqual([1000, 1500]);
  });
});

describe("resizeLayoutColumnEdge", () => {
  it("keeps the dragged edge under the pointer when the strip was arranged wider than the window", () => {
    const viewportWidth = 1000;
    const base: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: null,
          cameraWidth: 1200,
          columns: [column("chat", 0.5), column("terminal", 0.55)],
        },
      ],
    };
    const { unitWidth } = selectLayoutPaneSlots(base.workspaces[0]!, {
      width: viewportWidth,
      whenNoRoom: "shrink-then-scroll",
    });
    expect(drawnRightEdges(base, viewportWidth)).toEqual([600, 1260]);

    const pointers = Array.from({ length: 41 }, (_, index) => 300 + index * 10);
    const drawn = pointers.map((pointer) =>
      drawnRightEdges(
        resizeLayoutColumnEdge(
          base,
          "chat",
          pointer / viewportWidth,
          "shrink-then-scroll",
          viewportWidth,
          unitWidth,
        ),
        viewportWidth,
      ),
    );
    expect(drawn).toEqual(pointers.map((pointer) => [pointer, pointer + 660]));
  });

  it("lands the dragged edge where it is released when columns always shrink to fit", () => {
    const viewportWidth = 1000;
    const base: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: null,
          cameraWidth: viewportWidth,
          columns: [column("chat", 0.4), column("diff", 0.4), column("terminal", 0.4)],
        },
      ],
    };
    const { unitWidth } = selectLayoutPaneSlots(base.workspaces[0]!, {
      width: viewportWidth,
      whenNoRoom: "always-shrink",
    });
    expect(drawnRightEdges(base, viewportWidth, "always-shrink")).toEqual([333, 667, 1000]);

    const released = resizeLayoutColumnEdge(
      base,
      "diff",
      (600 - 1000 / 3) / viewportWidth,
      "always-shrink",
      viewportWidth,
      unitWidth,
    );
    expect(drawnRightEdges(released, viewportWidth, "always-shrink")).toEqual([333, 600, 1000]);
  });
});

describe("moveLayoutTabToWorkspace", () => {
  it("moves the top workspace's tab into a new workspace above it", () => {
    const first = chatFor("first");
    const second = chatFor("second");
    const state = [first, second].reduce(
      (layout, content) =>
        openLayoutTab(layout, content, { placement: "active-pane", position: "end" }),
      createLayoutState(),
    );

    const moved = moveLayoutTabToWorkspace(state, -1);

    expect(tabContents(moved)).toEqual([[second], [first], []]);
    expect(selectFocusedWorkspace(moved)).toBe(moved.workspaces[0]);
    expect(selectFocusedTab(moved)?.content).toBe(second);
  });
});
