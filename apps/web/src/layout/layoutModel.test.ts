import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addLayoutTabToGroup,
  canCloseLayoutTab,
  closeLayoutTab,
  closedLayoutTabIds,
  focusAdjacentLayoutTab,
  createLayoutTabGroup,
  moveLayoutTabToNewWorkspace,
  createLayoutState,
  decodePersistedLayoutState,
  findLayoutTab,
  focusLayoutTab,
  ghostLoneLayoutChats,
  isBlankLayoutWorkspace,
  layoutChatSwaps,
  moveLayoutTab,
  moveLayoutTabToWorkspace,
  nextLayoutTabGroupColor,
  openLayoutGhostChat,
  openLayoutKeptTab,
  openLayoutTab,
  placeLayoutContent,
  placeLayoutTabs,
  removeLayoutTabFromGroup,
  replaceLayoutTabContent,
  resizeLayoutColumnEdge,
  sameLayoutSpan,
  selectFocusedTab,
  selectFocusedLayoutGhostId,
  selectFocusedWorkspace,
  selectLayoutPaneSlots,
  selectLayoutStripSize,
  setLayoutWorkingGroupExpanded,
  shareLayoutBeside,
  showLayoutContent,
  THREAD_TERMINAL_SURFACE_ID,
  ungroupLayoutTabGroup,
  updateLayoutTabGroup,
  type LayoutPaneTabOrder,
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
const otherRef = scopeThreadRef(environmentId, ThreadId.make("other"));
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
 * its ghost, `t:A` A's terminal, `+` (or `+2`) a launcher, `+:A` one opened from A, `PR` the pull
 * requests page; `@g` puts a tab in its pane's group titled g; `*` marks a pane's active tab and
 * `!` the focused one.
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

function tabOf(grouped: string): LayoutTab {
  const [label = "", groupId] = grouped.split("@");
  const name = label.replace(/^~/, "");
  const content: LayoutTabContent = name.startsWith("+")
    ? {
        kind: "launcher",
        id: name,
        context: name.startsWith("+:") ? { kind: "server", threadRef: refOf(name.slice(2)) } : null,
      }
    : name === "PR"
      ? { kind: "pull-requests" }
      : name.startsWith("t:")
        ? { kind: "surface", threadRef: refOf(name.slice(2)), surfaceId: "thread-terminal" }
        : chatOf(name);
  return {
    id: name,
    content,
    ...(label.startsWith("~") ? { ghostOf: null } : {}),
    ...(groupId ? { groupId } : {}),
  };
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
        const groups = [
          ...new Set(tabs.flatMap((tab) => (tab.groupId === undefined ? [] : [tab.groupId]))),
        ].map((id) => ({ id, title: id, color: "grey" as const, collapsed: false }));
        return {
          id: paneId(w, c, p),
          size: 1 / panes.length,
          tabs,
          activeTabId: tabs[active]!.id,
          groups,
        };
      }),
    })),
  }));
  return { workspaces, focusedWorkspaceId: `w${focus?.w ?? 0}` };
}

function shapeOf(state: LayoutState): Shape[] {
  const focused = selectFocusedTab(state);
  return state.workspaces
    .filter((workspace, index, all) => index < all.length - 1 || !isBlankLayoutWorkspace(workspace))
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
            const group = pane.groups.find((candidate) => candidate.id === tab.groupId);
            return `${tab.ghostOf !== undefined ? "~" : ""}${name}${group ? `@${group.title}` : ""}${mark}`;
          }),
        ),
      ),
    );
}

const column = (id: string, width: number) => ({
  id,
  width,
  panes: [{ id: `${id}-pane`, tabs: [], activeTabId: null, size: 1, groups: [] }],
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
      expected: [[[["A"]]], [[["+!"]]], [[["C*", "X"]]]],
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
      expected: [[[["A"]]], [[["+!"]]], [[["C"]]], [[["X"]]]],
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

  it("are kept by opening them again while focused, even as a lone tab", () => {
    const ghostOfD = (layout: LayoutState) => selectFocusedLayoutGhostId(layout, chatOf("D"));
    expect(ghostOfD(layoutOf([[["A", "~D!"]]]))).toBe("D");
    expect(ghostOfD(layoutOf([[["~D"]], [["A!"]]]))).toBeNull();
    expect(ghostOfD(layoutOf([[["A", "D!"]]]))).toBeNull();
    expect(ghostOfD(layoutOf([[["~D!"]]]))).toBe("D");
    const lineage = openLayoutGhostChat(layoutOf([[["A!"]]]), refOf("A"), {
      kind: "server",
      threadRef: refOf("D"),
    })!;
    expect(ghostOfD(lineage)).toBe(selectFocusedTab(lineage)!.id);
  });

  it("start as the lone chat of a layout saved before ghosts", () => {
    expect(shapeOf(ghostLoneLayoutChats(layoutOf([[["A!"]]])))).toEqual([[[["~A!"]]]]);
    expect(shapeOf(ghostLoneLayoutChats(layoutOf([[["A!", "B"]]])))).toEqual([[[["A!", "B"]]]]);
  });
});

describe("blank workspaces", () => {
  const launcher: LayoutTabContent = { kind: "launcher", id: "new", context: null };
  it.each<{ case: string; open: (state: LayoutState) => LayoutState; expected: Shape[] }>([
    {
      case: "a thread opened as a new tab takes the blank tab's place",
      open: (state) => openLayoutTab(state, chatOf("D"), { placement: "active-pane" }),
      expected: [[[["D!"]]]],
    },
    {
      case: "a thread opened in a new column takes the blank tab's place",
      open: (state) => openLayoutTab(state, chatOf("D"), { placement: "new-column" }),
      expected: [[[["D!"]]]],
    },
    {
      case: "a thread split below takes the blank tab's place",
      open: (state) => openLayoutTab(state, chatOf("D"), { placement: "split-down" }),
      expected: [[[["D!"]]]],
    },
    {
      case: "a surface placed in the background takes the blank tab's place",
      open: (state) =>
        placeLayoutTabs(
          state,
          [tabOf("t:A")],
          { kind: "column", workspaceId: "w0", index: 1 },
          { activate: null, focus: false },
        ),
      expected: [[[["t:A!"]]]],
    },
    {
      case: "another blank tab sits beside it",
      open: (state) => openLayoutTab(state, launcher, { placement: "active-pane" }),
      expected: [[[["+", "+!"]]]],
    },
  ])("$case", ({ open, expected }) => {
    expect(shapeOf(open(layoutOf([[["+!"]]])))).toEqual(expected);
  });

  it("gives up the spare's blank tab to a tab moved down into it", () => {
    const moved = moveLayoutTabToWorkspace(layoutOf([[["A!"], ["B"]]], [[["+"]]]), 1);
    expect(shapeOf(moved)).toEqual([[[["B"]]], [[["A!"]]]]);
    expect(moved.workspaces.map(isBlankLayoutWorkspace)).toEqual([false, false, true]);
  });

  it("loads a layout saved with tabless empty workspaces as blank tabs", () => {
    const saved = JSON.parse(
      JSON.stringify({ ...layoutOf([[["A"]]], [], []), focusedWorkspaceId: "w1" }),
    );
    const loaded = decodePersistedLayoutState(saved);
    expect(tabContents(loaded)).toEqual([
      [chatOf("A")],
      [{ kind: "launcher", id: expect.any(String), context: null }],
    ]);
    expect(selectFocusedTab(loaded)?.content.kind).toBe("launcher");
  });
});

/** A strip order that draws every tab of a pane but `hidden` and collapsed ones, unless shown. */
const drawingAllBut =
  (...hidden: string[]): LayoutPaneTabOrder =>
  (pane) =>
    pane.tabs.flatMap((tab) => {
      const collapsed = pane.groups.some((group) => group.id === tab.groupId && group.collapsed);
      return tab.id === pane.activeTabId || (!hidden.includes(tab.id) && !collapsed)
        ? [tab.id]
        : [];
    });

describe("closeLayoutTab", () => {
  it.each<{
    case: string;
    layout: Shape[];
    close: string;
    hidden?: string[];
    expected: Shape[];
  }>([
    {
      case: "the strip's next drawn tab takes over, past hidden ones",
      layout: [[[["A", "B!", "C", "D"]]], [[["+"]]]],
      close: "B",
      hidden: ["C"],
      expected: [[[["A", "C", "D!"]]]],
    },
    {
      case: "the last drawn tab hands over to the drawn one before it",
      layout: [[[["A", "B", "C!", "D"]]], [[["+"]]]],
      close: "C",
      hidden: ["B", "D"],
      expected: [[[["A!", "B", "D"]]]],
    },
    {
      case: "a workspace's last thread gives way to a blank tab",
      layout: [[[["A!"]]], [[["B"]]], [[["+"]]]],
      close: "A",
      expected: [[[["+!"]]], [[["B"]]]],
    },
    {
      case: "a workspace's last surface gives way to a blank tab",
      layout: [[[["t:A!"]]], [[["B"]]], [[["+"]]]],
      close: "t:A",
      expected: [[[["+!"]]], [[["B"]]]],
    },
    {
      case: "a blank tab beside other tabs closes like any tab",
      layout: [[[["A", "+!"]]], [[["+2"]]]],
      close: "+",
      expected: [[[["A!"]]]],
    },
    {
      case: "a workspace's last blank tab closes it and lands in the one above",
      layout: [[[["A"]]], [[["+!"]]], [[["B"]]], [[["+2"]]]],
      close: "+",
      expected: [[[["A!"]]], [[["B"]]]],
    },
    {
      case: "the top workspace's last blank tab closes it and lands in the one below",
      layout: [[[["+!"]]], [[["A"]]], [[["+2"]]]],
      close: "+",
      expected: [[[["A!"]]]],
    },
    {
      case: "the spare's blank tab goes back up and the spare stays",
      layout: [[[["A"]]], [[["+!"]]]],
      close: "+",
      expected: [[[["A!"]]]],
    },
  ])("$case", ({ layout, close, hidden = [], expected }) => {
    const state = layoutOf(...layout);
    const closed = closeLayoutTab(state, close, drawingAllBut(...hidden));
    expect(shapeOf(closed)).toEqual(expected);
    expect(closed.workspaces.map(isBlankLayoutWorkspace).at(-1)).toBe(true);
    expect(closed.workspaces).toHaveLength(expected.length + 1);
    expect(canCloseLayoutTab(state, close)).toBe(true);
  });

  it.each<{ case: string; after: (state: LayoutState) => LayoutState; thread: string | null }>([
    {
      case: "a blank tab loses its thread once the thread's chat closes",
      after: (state) => closeLayoutTab(state, "A"),
      thread: null,
    },
    {
      case: "a blank tab loses its thread once the thread's chat moves to another workspace",
      after: (state) => moveLayoutTabToWorkspace(focusLayoutTab(state, "A"), 1),
      thread: null,
    },
    {
      case: "a blank tab keeps its thread while one of the thread's surfaces stays",
      after: (state) =>
        closeLayoutTab(
          placeLayoutTabs(
            state,
            [tabOf("t:A")],
            { kind: "after", tabId: "A" },
            {
              activate: null,
              focus: false,
            },
          ),
          "A",
        ),
      thread: "A",
    },
  ])("$case", ({ after, thread }) => {
    const state = after(layoutOf([[["A", "C", "+:A!"]]], [[["B"]]]));
    const blank = findLayoutTab(state, (tab) => tab.id === "+:A")?.tab.content;
    expect(blank?.kind === "launcher" ? blank.context : undefined).toEqual(
      thread === null ? null : { kind: "server", threadRef: refOf(thread) },
    );
  });

  it("keeps a blank tab's thread when the draft it was opened from becomes a thread", () => {
    const drafted = showLayoutContent(createLayoutState(), draftOf("draft"));
    const draftTab = selectFocusedTab(drafted)!;
    const withBlank = openLayoutTab(drafted, {
      kind: "launcher",
      id: "blank",
      context: { kind: "draft", draftId: "draft" as DraftId },
    });
    const promoted = replaceLayoutTabContent(withBlank, draftTab.id, chatOf("D"));
    const blank = findLayoutTab(promoted, (tab) => tab.content.kind === "launcher")?.tab.content;
    expect(blank?.kind === "launcher" ? blank.context : undefined).toEqual({
      kind: "server",
      threadRef: refOf("D"),
    });
  });

  it("leaves the window's last blank tab, which has no close", () => {
    const state = layoutOf([[["+!"]]]);
    expect(closeLayoutTab(state, "+")).toBe(state);
    expect(canCloseLayoutTab(state, "+")).toBe(false);
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
      case: "focus moving to a thread already open in the same pane",
      before: [[[["A!", "~D"]]]],
      after: [[[["A", "~D!"]]]],
      swaps: ["A>D focus only"],
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
        ({ from, to, focusOnly }) => `${name(from)}>${name(to)}${focusOnly ? " focus only" : ""}`,
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

describe("selectLayoutStripSize", () => {
  it("gives the strip width the slots are drawn at, for any viewport width", () => {
    const workspaces = [
      { cameraWidth: null, widths: [1] },
      { cameraWidth: null, widths: [0.66, 0.34] },
      { cameraWidth: null, widths: [0.5, 0.5, 0.5] },
      { cameraWidth: 1650, widths: [0.66, 0.34] },
      { cameraWidth: 1490, widths: [0.4, 0.3, 0.3] },
      { cameraWidth: 1200, widths: [0.5, 0.55] },
      { cameraWidth: 1400, widths: [0.4, 0.4] },
      { cameraWidth: 900, widths: [1] },
    ];
    const modes: LayoutWhenNoRoom[] = ["shrink-then-scroll", "always-scroll", "always-shrink"];
    for (const { cameraWidth, widths } of workspaces) {
      const workspace = {
        id: "workspace",
        name: null,
        focusedPaneId: null,
        cameraWidth,
        columns: widths.map((width, index) => column(`c${index}`, width)),
      };
      for (const whenNoRoom of modes) {
        const { share, minPx } = selectLayoutStripSize(workspace, whenNoRoom);
        for (let width = 700; width <= 2200; width += 25) {
          const { stripWidth } = selectLayoutPaneSlots(workspace, { width, whenNoRoom });
          expect(Math.max(share * width, minPx)).toBeCloseTo(stripWidth * width, 6);
        }
      }
    }
  });
});

describe("sameLayoutSpan", () => {
  const workspace = {
    id: "workspace",
    name: null,
    focusedPaneId: "chat-pane",
    cameraWidth: 1094,
    columns: [column("chat", 0.75), column("pulls", 0.75)],
  };
  const spanAt = (width: number, at = workspace, index = 0) => {
    const { slots, stripWidth } = selectLayoutPaneSlots(at, {
      width,
      whenNoRoom: "shrink-then-scroll",
    });
    const slot = slots[index]!;
    return {
      paneId: slot.paneId,
      left: slot.rect.left,
      width: slot.rect.width,
      px: Math.round(slot.rect.width * stripWidth * width),
    };
  };

  it("keeps the focused pane's span at every strip width, where its pixel width rounds either way", () => {
    const widths = Array.from({ length: 532 }, (_, index) => 900 + index);
    const resting = spanAt(1174);
    expect(widths.filter((width) => spanAt(width).px !== resting.px).length).toBeGreaterThan(0);
    for (const width of widths) expect(sameLayoutSpan(spanAt(width), resting)).toBe(true);
  });

  it("tells a resized column and another pane apart", () => {
    const resized = { ...workspace, columns: [column("chat", 0.76), column("pulls", 0.74)] };
    expect(sameLayoutSpan(spanAt(1174, resized), spanAt(1174))).toBe(false);
    expect(sameLayoutSpan(spanAt(1174, workspace, 1), spanAt(1174))).toBe(false);
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

    expect(tabContents(moved).slice(0, 2)).toEqual([[second], [first]]);
    expect(moved.workspaces.map(isBlankLayoutWorkspace)).toEqual([false, false, true]);
    expect(selectFocusedWorkspace(moved)).toBe(moved.workspaces[0]);
    expect(selectFocusedTab(moved)?.content).toBe(second);
  });
});

describe("moveLayoutTab", () => {
  it("gives a pane's height back to the pane in its column it moves into", () => {
    const base: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: "chat-pane",
          cameraWidth: 1200,
          columns: [
            {
              id: "column",
              width: 1,
              panes: [
                {
                  id: "chat-pane",
                  size: 0.55,
                  activeTabId: "chat",
                  groups: [],
                  tabs: [
                    {
                      id: "chat",
                      content: { kind: "chat", target: { kind: "server", threadRef } },
                    },
                    {
                      id: "terminal",
                      content: {
                        kind: "surface",
                        threadRef,
                        surfaceId: THREAD_TERMINAL_SURFACE_ID,
                      },
                    },
                  ],
                },
                {
                  id: "other-pane",
                  size: 0.45,
                  activeTabId: "other-terminal",
                  groups: [],
                  tabs: [
                    {
                      id: "other-terminal",
                      content: {
                        kind: "surface",
                        threadRef: otherRef,
                        surfaceId: THREAD_TERMINAL_SURFACE_ID,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const shown = shareLayoutBeside(
      moveLayoutTab(base, "terminal", { kind: "split", paneId: "chat-pane", side: "down" }),
      "terminal",
      "chat",
      "terminal",
      1 / 3,
      "shrink-then-scroll",
      0,
    );
    const hidden = moveLayoutTab(shown, "terminal", {
      kind: "pane",
      paneId: "chat-pane",
      index: 1,
    });
    const sizes = hidden.workspaces[0]!.columns[0]!.panes.map((pane) => [pane.id, pane.size]);
    expect(sizes).toEqual([
      ["chat-pane", expect.closeTo(0.55)],
      ["other-pane", expect.closeTo(0.45)],
    ]);
  });
});

describe("closedLayoutTabIds", () => {
  it("lists a tab that left the layout, not one that moved to another workspace", () => {
    const layout = openLayoutTab(openLayoutTab(createLayoutState(), chat), diff, {
      placement: "new-column",
    });
    const diffTabId = selectFocusedTab(layout)!.id;

    expect(closedLayoutTabIds(layout, closeLayoutTab(layout, diffTabId))).toEqual([diffTabId]);
    expect(closedLayoutTabIds(layout, moveLayoutTabToNewWorkspace(layout, diffTabId, 1))).toEqual(
      [],
    );
  });
});

describe("tab groups", () => {
  const paneOf = (state: LayoutState) => state.workspaces[0]!.columns[0]!.panes[0]!;
  const groupId = (state: LayoutState, title: string) =>
    state.workspaces
      .flatMap((workspace) => workspace.columns)
      .flatMap((column) => column.panes)
      .flatMap((pane) => pane.groups)
      .find((group) => group.title === title)!.id;

  it.each<{
    case: string;
    layout: Shape[];
    act: (state: LayoutState) => LayoutState;
    expected: Shape[];
  }>([
    {
      case: "a tab starts a group",
      layout: [[[["A!", "B", "C"]]]],
      act: (state) => createLayoutTabGroup(state, "B", { title: " h ", color: "red" }),
      expected: [[[["A!", "B@h", "C"]]]],
    },
    {
      case: "a grouped tab starts a new group after its old one",
      layout: [[[["A@g!", "B@g", "C@g", "D"]]]],
      act: (state) => createLayoutTabGroup(state, "B", { title: "h", color: "red" }),
      expected: [[[["A@g!", "C@g", "B@h", "D"]]]],
    },
    {
      case: "a tab added to a group moves to its end",
      layout: [[[["A!", "B@g", "C@g", "D"]]]],
      act: (state) => addLayoutTabToGroup(state, "A", "g"),
      expected: [[[["B@g", "C@g", "A@g!", "D"]]]],
    },
    {
      case: "a tab removed from a group lands right after it",
      layout: [[[["A!", "B@g", "C@g", "D@g", "E"]]]],
      act: (state) => removeLayoutTabFromGroup(state, "C"),
      expected: [[[["A!", "B@g", "D@g", "C", "E"]]]],
    },
    {
      case: "a group's last tab leaving drops the group",
      layout: [[[["A!", "B@g"]]]],
      act: (state) => removeLayoutTabFromGroup(state, "B"),
      expected: [[[["A!", "B"]]]],
    },
    {
      case: "a tab dropped between two of a group joins it",
      layout: [[[["A!", "B@g", "C@g", "D"]]]],
      act: (state) => moveLayoutTab(state, "A", { kind: "pane", paneId: "w0c0p0", index: 1 }),
      expected: [[[["B@g", "A@g!", "C@g", "D"]]]],
    },
    {
      case: "a tab dropped at a group's edge stays out of it",
      layout: [[[["A!", "B@g", "C@g", "D"]]]],
      act: (state) => moveLayoutTab(state, "D", { kind: "pane", paneId: "w0c0p0", index: 1 }),
      expected: [[[["A", "D!", "B@g", "C@g"]]]],
    },
    {
      case: "a member dragged past the group leaves it",
      layout: [[[["A!", "B@g", "C@g", "D@g", "E"]]]],
      act: (state) => moveLayoutTab(state, "C", { kind: "pane", paneId: "w0c0p0", index: 4 }),
      expected: [[[["A", "B@g", "D@g", "E", "C!"]]]],
    },
    {
      case: "a member dragged to its group's edge stays in it",
      layout: [[[["A!", "B@g", "C@g", "D"]]]],
      act: (state) => moveLayoutTab(state, "C", { kind: "pane", paneId: "w0c0p0", index: 1 }),
      expected: [[[["A", "C@g!", "B@g", "D"]]]],
    },
    {
      case: "a tab moved into another pane's group joins it, and its old group goes",
      layout: [[[["A!", "B@g"]], [["C@h", "D@h"]]]],
      act: (state) => moveLayoutTab(state, "B", { kind: "pane", paneId: "w0c1p0", index: 1 }),
      expected: [[[["A"]], [["C@h", "B@h!", "D@h"]]]],
    },
    {
      case: "a tab moved past another pane's group leaves its own behind",
      layout: [[[["A!", "B@g"]], [["C@h", "D@h"]]]],
      act: (state) => moveLayoutTab(state, "B", { kind: "pane", paneId: "w0c1p0", index: 2 }),
      expected: [[[["A"]], [["C@h", "D@h", "B!"]]]],
    },
    {
      case: "a tab moved to a new column leaves its group",
      layout: [[[["A!", "B@g"]]]],
      act: (state) => moveLayoutTab(state, "B", { kind: "column", workspaceId: "w0", index: 1 }),
      expected: [[[["A"]], [["B!"]]]],
    },
    {
      case: "a tab opened inside a group joins it",
      layout: [[[["A", "B@g!", "C@g"]]]],
      act: (state) => openLayoutTab(state, chatOf("N")),
      expected: [[[["A", "B@g", "N@g!", "C@g"]]]],
    },
    {
      case: "a tab opened after a group's last tab stays out of it",
      layout: [[[["A", "B@g!", "C"]]]],
      act: (state) => openLayoutTab(state, chatOf("N")),
      expected: [[[["A", "B@g", "N!", "C"]]]],
    },
    {
      case: "closing a group's last tab drops the group",
      layout: [[[["A!", "B@g"]]]],
      act: (state) => closeLayoutTab(state, "B"),
      expected: [[[["A!"]]]],
    },
    {
      case: "ungrouping keeps the tabs in place",
      layout: [[[["A@g!", "B@g", "C"]]]],
      act: (state) => ungroupLayoutTabGroup(state, "g"),
      expected: [[[["A!", "B", "C"]]]],
    },
    {
      case: "ctrl+Tab steps over tabs the strip leaves out",
      layout: [[[["A", "B!", "C", "D"]]]],
      act: (state) => focusAdjacentLayoutTab(state, 1, drawingAllBut("C")),
      expected: [[[["A", "B", "C", "D!"]]]],
    },
    {
      case: "ctrl+shift+Tab wraps over tabs the strip leaves out",
      layout: [[[["A!", "B", "C", "D"]]]],
      act: (state) => focusAdjacentLayoutTab(state, -1, drawingAllBut("D")),
      expected: [[[["A", "B", "C!", "D"]]]],
    },
    {
      case: "a tab moved away hands its pane to the next drawn tab",
      layout: [[[["A", "B!", "C", "D"]]]],
      act: (state) =>
        moveLayoutTab(
          state,
          "B",
          { kind: "column", workspaceId: "w0", index: 1 },
          drawingAllBut("C"),
        ),
      expected: [[[["A", "C", "D*"]], [["B!"]]]],
    },
    {
      case: "a tab moved to the next workspace hands its pane to the next drawn tab",
      layout: [[[["A", "B!", "C", "D"]]], [[["E"]]]],
      act: (state) => moveLayoutTabToWorkspace(state, 1, drawingAllBut("C")),
      expected: [[[["A", "C", "D*"]]], [[["E"]], [["B!"]]]],
    },
    {
      case: "a group's only tab keeps its group wherever it is dragged",
      layout: [[[["A!", "B@g", "C"]]]],
      act: (state) => moveLayoutTab(state, "B", { kind: "pane", paneId: "w0c0p0", index: 0 }),
      expected: [[[["B@g!", "A", "C"]]]],
    },
    {
      case: "a group's only drawn tab keeps its group, and its left-out tabs follow it",
      layout: [[[["X!", "A@g", "H@g", "Y"]]]],
      act: (state) =>
        moveLayoutTab(state, "A", { kind: "pane", paneId: "w0c0p0", index: 3 }, drawingAllBut("H")),
      expected: [[[["X", "Y", "A@g!", "H@g"]]]],
    },
    {
      case: "a collapsed group's only drawn tab keeps it, and its left-out tabs follow it",
      layout: [[[["X!", "A@g", "H@g", "Y"]]]],
      act: (state) =>
        moveLayoutTab(
          updateLayoutTabGroup(state, "g", { collapsed: true }),
          "A",
          { kind: "pane", paneId: "w0c0p0", index: 3 },
          drawingAllBut("H"),
        ),
      expected: [[[["X", "Y", "A@g!", "H@g"]]]],
    },
    {
      case: "a tab dragged out of a collapsed group leaves it to its folded tabs",
      layout: [[[["X!", "A@g", "B@g", "Y"]]]],
      act: (state) =>
        moveLayoutTab(
          updateLayoutTabGroup(state, "g", { collapsed: true }),
          "A",
          { kind: "pane", paneId: "w0c0p0", index: 3 },
          drawingAllBut(),
        ),
      expected: [[[["X", "B@g", "Y", "A!"]]]],
    },
    {
      case: "a ghost starting a group is kept",
      layout: [[[["A!", "~B"]]]],
      act: (state) => createLayoutTabGroup(state, "B", { title: "h", color: "red" }),
      expected: [[[["A!", "B@h"]]]],
    },
    {
      case: "a ghost added to a group is kept",
      layout: [[[["A@g!", "~B"]]]],
      act: (state) => addLayoutTabToGroup(state, "B", "g"),
      expected: [[[["A@g!", "B@g"]]]],
    },
    {
      case: "a launcher in a group turns into a kept tab of it",
      layout: [[[["A@g", "+@g!", "B@g"]]]],
      act: (state) => showLayoutContent(showLayoutContent(state, chatOf("N")), chatOf("M")),
      expected: [[[["A@g", "N@g", "B@g", "~M!"]]]],
    },
    {
      case: "a preview opened from a grouped tab lands past the group, ungrouped",
      layout: [[[["A", "B@g!", "C@g", "D"]]]],
      act: (state) => showLayoutContent(state, chatOf("N")),
      expected: [[[["A", "B@g", "C@g", "~N!", "D"]]]],
    },
  ])("$case", ({ layout, act, expected }) => {
    const after = act(layoutOf(...layout));
    expect(shapeOf(after)).toEqual(expected);
    const groupIds = paneOf(after).groups.map((group) => group.id);
    const memberIds = new Set(paneOf(after).tabs.flatMap((tab) => tab.groupId ?? []));
    expect(groupIds.toSorted()).toEqual([...memberIds].toSorted());
  });

  it("starts a group open, with the trimmed title and color given", () => {
    const created = createLayoutTabGroup(layoutOf([[["A!"]]]), "A", {
      title: " h ",
      color: "red",
    });
    expect(paneOf(created).groups).toEqual([
      { id: groupId(created, "h"), title: "h", color: "red", collapsed: false },
    ]);
  });

  it("renames, recolors and collapses a group, and leaves an unchanged one alone", () => {
    const state = layoutOf([[["A@g!", "B@g"]]]);
    const updated = updateLayoutTabGroup(state, "g", {
      title: "Review ",
      color: "green",
      collapsed: true,
    });
    expect(paneOf(updated).groups).toEqual([
      { id: "g", title: "Review", color: "green", collapsed: true },
    ]);
    expect(selectFocusedTab(updated)?.id).toBe("A");
    expect(updateLayoutTabGroup(state, "g", { title: "g", collapsed: false })).toBe(state);
  });

  it("picks the least used color for a pane's next group", () => {
    const state = layoutOf([[["A@g!", "B@h"]]]);
    const pane = paneOf(updateLayoutTabGroup(state, "h", { color: "blue" }));
    expect(nextLayoutTabGroupColor(pane)).toBe("red");
  });

  it("opens and collapses a pane's Working group, storing only an open one", () => {
    const state = layoutOf([[["A!"]]]);
    const opened = setLayoutWorkingGroupExpanded(state, "w0c0p0", true);
    expect(paneOf(opened).workingGroupExpanded).toBe(true);
    expect(setLayoutWorkingGroupExpanded(opened, "w0c0p0", true)).toBe(opened);
    expect(
      "workingGroupExpanded" in paneOf(setLayoutWorkingGroupExpanded(opened, "w0c0p0", false)),
    ).toBe(false);
  });

  it("loads groups saved with the layout, and layouts saved before groups", () => {
    const saved = layoutOf([[["A@g!", "B@g", "C"]]]);
    const withWorking = setLayoutWorkingGroupExpanded(
      updateLayoutTabGroup(saved, "g", { collapsed: true }),
      "w0c0p0",
      true,
    );
    const loaded = decodePersistedLayoutState(JSON.parse(JSON.stringify(withWorking)));
    expect(shapeOf(loaded)).toEqual([[[["A@g!", "B@g", "C"]]]]);
    expect(paneOf(loaded).groups).toEqual([
      { id: "g", title: "g", color: "grey", collapsed: true },
    ]);
    expect(paneOf(loaded).workingGroupExpanded).toBe(true);

    const beforeGroups = JSON.parse(JSON.stringify(layoutOf([[["A!", "B"]]])));
    delete beforeGroups.workspaces[0].columns[0].panes[0].groups;
    expect(paneOf(decodePersistedLayoutState(beforeGroups)).groups).toEqual([]);
  });

  it("drops a malformed saved group and ungroups its tabs, keeping the layout", () => {
    const saved = JSON.parse(JSON.stringify(layoutOf([[["A@g!", "B@h", "C"]]])));
    saved.workspaces[0].columns[0].panes[0].groups[0] = { title: 3 };
    saved.workspaces[0].columns[0].panes[0].groups[1].color = "chartreuse";
    const loaded = decodePersistedLayoutState(saved);
    expect(shapeOf(loaded)).toEqual([[[["A!", "B@h", "C"]]]]);
    expect(paneOf(loaded).groups).toEqual([
      { id: "h", title: "h", color: "grey", collapsed: false },
    ]);
  });
});
