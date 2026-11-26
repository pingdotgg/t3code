import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_THREAD_TABS,
  addThreadTabToGroup,
  closeThreadTab,
  closeThreadTabs,
  createThreadTabGroup,
  decodeThreadTabs,
  dropThreadTab,
  encodeThreadTabs,
  followThreadTabRoute,
  groupThreadTabsByProject,
  projectThreadTabGroupId,
  moveThreadTabGroup,
  moveThreadTabToEdge,
  nextThreadTabGroupColor,
  otherThreadTabs,
  parseThreadTabKey,
  pinThreadTab,
  pruneThreadTabs,
  relativeThreadTab,
  removeThreadTabFromGroup,
  reopenClosedThreadTabs,
  threadTabAt,
  threadTabKeyForDraft,
  threadTabKeyForThread,
  threadTabsToTheRight,
  ungroupThreadTabs,
  unpinThreadTab,
  unpinnedThreadTabs,
  updateThreadTabGroup,
  type ProjectGroupingInput,
  type ThreadTabLivenessInput,
  type ThreadTabsState,
} from "./kaluwaThreadTabs.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const ref = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  threadId: ThreadId.make(id),
});
const key = (id: string) => threadTabKeyForThread(ref(local, id));
const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(key) as [
  string,
  string,
  string,
  string,
  string,
];
const r = threadTabKeyForThread(ref(remote, "r"));
const draft = threadTabKeyForDraft("draft-1");

const tabs = (keys: string[], active: string | null): ThreadTabsState => ({
  ...EMPTY_THREAD_TABS,
  tabs: keys,
  active,
});
const group = (state: ThreadTabsState, keys: string[], id = "g1") =>
  createThreadTabGroup(state, keys, { id, color: "steel" });

describe("thread tab keys", () => {
  it("round-trips threads and drafts", () => {
    expect(parseThreadTabKey(a)).toEqual({ kind: "thread", ref: ref(local, "a") });
    expect(parseThreadTabKey(draft)).toEqual({ kind: "draft", draftId: "draft-1" });
    expect(parseThreadTabKey("thread:nothread")).toBeNull();
    expect(parseThreadTabKey("draft:")).toBeNull();
  });
});

describe("followThreadTabRoute", () => {
  const open = { newTab: true };

  it("opens the first tab", () => {
    expect(followThreadTabRoute(EMPTY_THREAD_TABS, a, open)).toMatchObject({
      tabs: [a],
      active: a,
    });
  });

  it("opens a thread in a new tab right after the active one", () => {
    expect(followThreadTabRoute(tabs([a, b], a), c, open)).toMatchObject({
      tabs: [a, c, b],
      active: c,
    });
  });

  it("activates the open tab instead of opening a duplicate", () => {
    const state = tabs([a, b], a);
    expect(followThreadTabRoute(state, b, open)).toMatchObject({ tabs: [a, b], active: b });
    expect(followThreadTabRoute(state, a, open)).toBe(state);
  });

  it("replaces the active tab when threads open in the current tab", () => {
    expect(followThreadTabRoute(tabs([a, b], a), c, { newTab: false })).toMatchObject({
      tabs: [c, b],
      active: c,
    });
  });

  it("swaps a sent draft for its thread in place, keeping its group", () => {
    const state = group(tabs([a, draft, b], draft), [draft]);
    const next = followThreadTabRoute(state, c, { newTab: true, replaceActive: true });
    expect(next.tabs).toEqual([a, c, b]);
    expect(next.groupOf[c]).toBe("g1");
  });

  it("opens after the pinned tabs from a pinned tab, even in current-tab mode", () => {
    const state = pinThreadTab(tabs([a, b], a), a);
    expect(followThreadTabRoute(state, c, { newTab: false })).toMatchObject({
      tabs: [a, c, b],
      active: c,
      pinned: [a],
    });
  });

  it("joins the active tab's group", () => {
    const state = { ...group(tabs([a, b, c], a), [a, b]), active: a };
    const next = followThreadTabRoute(state, d, open);
    expect(next.tabs).toEqual([a, d, b, c]);
    expect(next.groupOf[d]).toBe("g1");
  });

  it("expands a collapsed group to show the tab it activates", () => {
    const state = updateThreadTabGroup(group(tabs([a, b], a), [b]), "g1", { collapsed: true });
    expect(followThreadTabRoute(state, b, open).groups[0]?.collapsed).toBe(false);
  });
});

describe("pinned tabs", () => {
  it("keep pinned tabs first, in pin order", () => {
    let state = tabs([a, b, c], a);
    state = pinThreadTab(state, c);
    state = pinThreadTab(state, b);
    expect(state.tabs).toEqual([c, b, a]);
    expect(state.pinned).toEqual([c, b]);
  });

  it("unpinning moves a tab to the start of the unpinned tabs", () => {
    const state = unpinThreadTab(pinThreadTab(pinThreadTab(tabs([a, b, c], a), a), b), a);
    expect(state.tabs).toEqual([b, a, c]);
    expect(state.pinned).toEqual([b]);
  });

  it("pinning takes a tab out of its group", () => {
    const state = pinThreadTab(group(tabs([a, b], a), [a, b]), b);
    expect(state.groupOf[b]).toBeUndefined();
    expect(state.groupOf[a]).toBe("g1");
  });

  it("are skipped by close other, right and all", () => {
    const state = pinThreadTab(tabs([a, b, c, d], b), a);
    expect(otherThreadTabs(state, c)).toEqual([b, d]);
    expect(threadTabsToTheRight(state, b)).toEqual([c, d]);
    expect(unpinnedThreadTabs(state)).toEqual([b, c, d]);
  });
});

describe("closing", () => {
  it("activates the right neighbour, then the left one", () => {
    expect(closeThreadTab(tabs([a, b, c], b), b)).toMatchObject({
      state: { tabs: [a, c], active: c },
      activate: c,
    });
    expect(closeThreadTab(tabs([a, b, c], c), c)).toMatchObject({
      state: { tabs: [a, b], active: b },
      activate: b,
    });
  });

  it("skips closed tabs when picking the next active one", () => {
    expect(closeThreadTabs(tabs([a, b, c, d], b), [b, c])).toMatchObject({
      state: { tabs: [a, d], active: d },
      activate: d,
    });
  });

  it("leaves no tab after the last one", () => {
    expect(closeThreadTab(tabs([a], a), a)).toMatchObject({
      state: { tabs: [], active: null },
      activate: null,
    });
  });

  it("ignores tabs that are not open", () => {
    const state = tabs([a], a);
    expect(closeThreadTab(state, b)).toEqual({ state, activate: null });
  });

  it("drops a group whose last tab closes", () => {
    expect(closeThreadTab(group(tabs([a, b], a), [b]), b).state.groups).toEqual([]);
  });
});

describe("reopenClosedThreadTabs", () => {
  it("restores the last closed batch where it was, with pins and groups", () => {
    let state = pinThreadTab(group(tabs([a, b, c, d], a), [c, d]), a);
    state = closeThreadTabs(state, threadTabsToTheRight(state, b)).state;
    expect(state.tabs).toEqual([a, b]);
    expect(state.groups).toEqual([]);
    const reopened = reopenClosedThreadTabs(state);
    expect(reopened.state.tabs).toEqual([a, b, c, d]);
    expect(reopened.state.groupOf).toEqual({ [c]: "g1", [d]: "g1" });
    expect(reopened.activate).toBe(c);
    expect(reopened.state.closed).toEqual([]);
  });

  it("restores a pin", () => {
    const state = closeThreadTab(pinThreadTab(tabs([a, b], b), a), a).state;
    expect(reopenClosedThreadTabs(state).state).toMatchObject({ tabs: [a, b], pinned: [a] });
  });

  it("reopens batches newest first, and does nothing with none", () => {
    let state = tabs([a, b, c], a);
    state = closeThreadTab(state, b).state;
    state = closeThreadTab(state, c).state;
    expect(reopenClosedThreadTabs(state).activate).toBe(c);
    expect(reopenClosedThreadTabs(tabs([a], a))).toEqual({ state: tabs([a], a), activate: null });
  });
});

describe("groups", () => {
  it("gathers a new group's tabs where its first tab is", () => {
    const state = group(tabs([a, b, c, d], a), [b, d]);
    expect(state.tabs).toEqual([a, b, d, c]);
    expect(state.groups).toEqual([{ id: "g1", name: "", color: "steel", collapsed: false }]);
  });

  it("adds and removes tabs at the group's end", () => {
    let state = group(tabs([a, b, c, d], a), [a, b]);
    state = addThreadTabToGroup(state, d, "g1");
    expect(state.tabs).toEqual([a, b, d, c]);
    state = removeThreadTabFromGroup(state, a);
    expect(state.tabs).toEqual([b, d, a, c]);
    expect(state.groupOf[a]).toBeUndefined();
  });

  it("ungroups without moving tabs", () => {
    const state = ungroupThreadTabs(group(tabs([a, b, c], a), [b, c]), "g1");
    expect(state).toMatchObject({ tabs: [a, b, c], groupOf: {}, groups: [] });
  });

  it("picks an unused colour", () => {
    expect(nextThreadTabGroupColor(group(tabs([a], a), [a]))).toBe("clay");
  });

  it("moves a whole group without splitting another", () => {
    let state = group(tabs([a, b, c, d, e], a), [a, b], "g1");
    state = group(state, [c, d], "g2");
    expect(moveThreadTabGroup(state, "g1", c, "after").tabs).toEqual([c, d, a, b, e]);
    expect(moveThreadTabGroup(state, "g1", e, "after").tabs).toEqual([c, d, e, a, b]);
    expect(moveThreadTabGroup(state, "g1", null, "after").tabs).toEqual([c, d, e, a, b]);
  });

  it("keeps a moved group after the pinned tabs", () => {
    const state = group(pinThreadTab(tabs([a, b, c], a), a), [c]);
    expect(moveThreadTabGroup(state, "g1", a, "before").tabs).toEqual([a, c, b]);
  });
});

describe("dropThreadTab", () => {
  it("joins a group when dropped between two of its tabs", () => {
    const state = dropThreadTab(group(tabs([a, b, c, d], a), [b, c]), a, b, "after");
    expect(state.tabs).toEqual([b, a, c, d]);
    expect(state.groupOf[a]).toBe("g1");
  });

  it("stays in its group beside it, and leaves it farther away", () => {
    const state = group(tabs([a, b, c, d], a), [a, b]);
    expect(dropThreadTab(state, a, b, "after").groupOf[a]).toBe("g1");
    const moved = dropThreadTab(state, a, d, "after");
    expect(moved.tabs).toEqual([b, c, d, a]);
    expect(moved.groupOf[a]).toBeUndefined();
  });

  it("keeps pinned and unpinned tabs in their own sections", () => {
    const state = pinThreadTab(tabs([a, b, c], a), a);
    expect(dropThreadTab(state, c, a, "before").tabs).toEqual([a, c, b]);
    expect(dropThreadTab(state, a, c, "after").tabs).toEqual([a, b, c]);
  });

  it("moves to the start or end and out of the group", () => {
    const state = group(tabs([a, b, c], a), [b, c]);
    const moved = moveThreadTabToEdge(state, c, "start");
    expect(moved.tabs).toEqual([c, a, b]);
    expect(moved.groupOf[c]).toBeUndefined();
  });
});

describe("switching tabs", () => {
  it("wraps around and skips collapsed groups", () => {
    const state = tabs([a, b, c], c);
    expect(relativeThreadTab(state, 1)).toBe(a);
    expect(relativeThreadTab(state, -1)).toBe(b);
    const collapsed = updateThreadTabGroup(group(state, [a]), "g1", { collapsed: true });
    expect(relativeThreadTab(collapsed, 1)).toBe(b);
  });

  it("treats the ninth tab as the last, like a browser", () => {
    const state = tabs([a, b, c], a);
    expect(threadTabAt(state, 1)).toBe(b);
    expect(threadTabAt(state, 5)).toBeNull();
    expect(threadTabAt(state, 8)).toBe(c);
  });
});

describe("decodeThreadTabs", () => {
  it("round-trips pins, groups and closed tabs", () => {
    let state = group(pinThreadTab(tabs([a, draft, c, r], c), a), [c, r]);
    state = closeThreadTab(state, draft).state;
    expect(decodeThreadTabs(encodeThreadTabs(state))).toEqual(state);
  });

  it("reads the first version's tabs", () => {
    expect(decodeThreadTabs(JSON.stringify({ tabs: [a, b], active: b }))).toEqual(tabs([a, b], b));
  });

  it("drops malformed tabs, unknown groups and a stray active tab", () => {
    expect(
      decodeThreadTabs(
        JSON.stringify({
          tabs: [a, a, 3, "bogus", b],
          active: "thread:x:y",
          groupOf: { [a]: "missing" },
          groups: [{ id: "g", color: "neon" }],
        }),
      ),
    ).toEqual(tabs([a, b], null));
  });

  it("starts empty on missing or broken storage", () => {
    expect(decodeThreadTabs(null)).toEqual(EMPTY_THREAD_TABS);
    expect(decodeThreadTabs("{")).toEqual(EMPTY_THREAD_TABS);
    expect(decodeThreadTabs("[1]")).toEqual(EMPTY_THREAD_TABS);
  });
});

describe("pruneThreadTabs", () => {
  const input = (overrides: Partial<ThreadTabLivenessInput> = {}): ThreadTabLivenessInput => ({
    knownThreadKeys: new Set(["local:a"]),
    liveEnvironmentIds: new Set([local]),
    draftExists: () => false,
    promotedTo: () => null,
    ...overrides,
  });

  it("drops threads that are gone from a live environment", () => {
    expect(pruneThreadTabs(tabs([a, b], a), input())).toEqual(tabs([a], a));
  });

  it("keeps threads whose environment is not live yet, and the active tab", () => {
    const state = tabs([a, r], a);
    expect(pruneThreadTabs(state, input())).toBe(state);
    const active = tabs([a, b], b);
    expect(pruneThreadTabs(active, input())).toBe(active);
  });

  it("swaps a sent draft for its thread, keeping its pin", () => {
    const state = pinThreadTab(tabs([b, draft], b), draft);
    expect(pruneThreadTabs(state, input({ promotedTo: () => ref(local, "a") }))).toMatchObject({
      tabs: [a, b],
      pinned: [a],
    });
  });

  it("dedupes a sent draft whose thread is already open", () => {
    expect(
      pruneThreadTabs(tabs([a, draft], a), input({ promotedTo: () => ref(local, "a") })),
    ).toEqual(tabs([a], a));
  });
});

describe("groupThreadTabsByProject", () => {
  // a, b, c are in project "p1"; d and e in "p2".
  const projectOfKey: Record<string, string> = {
    [a]: "p1",
    [b]: "p1",
    [c]: "p1",
    [d]: "p2",
    [e]: "p2",
  };
  const byProject = (overrides: Partial<ProjectGroupingInput> = {}): ProjectGroupingInput => ({
    enabled: true,
    projectOf: (key) => projectOfKey[key] ?? null,
    colorOf: (project) => (project === "p1" ? "sage" : "plum"),
    ...overrides,
  });
  const p1 = projectThreadTabGroupId("p1");
  const p2 = projectThreadTabGroupId("p2");
  const grouped = (state: ThreadTabsState, input = byProject()) =>
    groupThreadTabsByProject(state, input);

  it("groups two or more tabs of a project where its first tab is", () => {
    const state = grouped(tabs([a, d, b, e], a));
    expect(state.tabs).toEqual([a, b, d, e]);
    expect(state.groupOf).toEqual({ [a]: p1, [b]: p1, [d]: p2, [e]: p2 });
    expect(state.groups).toEqual([
      { id: p1, name: "", color: "sage", collapsed: false, project: "p1" },
      { id: p2, name: "", color: "plum", collapsed: false, project: "p2" },
    ]);
  });

  it("leaves a project's only tab ungrouped", () => {
    const state = tabs([a, d], a);
    expect(grouped(state)).toBe(state);
  });

  it("puts a newly opened tab in its project's group", () => {
    let state = grouped(tabs([a, b, d], d));
    state = grouped(followThreadTabRoute(state, c, { newTab: true }));
    expect(state.tabs).toEqual([a, b, c, d]);
    expect(state.groupOf[c]).toBe(p1);
  });

  it("does not let another project's new tab join a project group", () => {
    const state = followThreadTabRoute(grouped(tabs([a, b], b)), d, { newTab: true });
    expect(state.groupOf[d]).toBeUndefined();
  });

  it("dissolves a project group when one tab is left, keeping it collapsed state otherwise", () => {
    let state = grouped(tabs([a, b, d], d));
    state = updateThreadTabGroup(state, p1, { collapsed: true });
    expect(grouped(state).groups[0]?.collapsed).toBe(true);
    state = grouped(closeThreadTab(state, b).state);
    expect(state.groups).toEqual([]);
    expect(state.groupOf).toEqual({});
  });

  it("respects a tab the user dragged out", () => {
    let state = grouped(tabs([a, b, c, d], d));
    state = grouped(dropThreadTab(state, a, d, "after"));
    expect(state.tabs).toEqual([b, c, d, a]);
    expect(state.groupOf[a]).toBeUndefined();
    expect(state.ungrouped).toEqual([a]);
    // Dragging it back between its project's tabs rejoins.
    state = grouped(dropThreadTab(state, a, b, "after"));
    expect(state.groupOf[a]).toBe(p1);
    expect(state.ungrouped).toEqual([]);
  });

  it("respects removing a tab from its project group and ungrouping it", () => {
    let state = grouped(tabs([a, b, c], a));
    state = grouped(removeThreadTabFromGroup(state, c));
    expect(state.groupOf[c]).toBeUndefined();
    state = grouped(ungroupThreadTabs(state, p1));
    expect(state.groups).toEqual([]);
    expect(new Set(state.ungrouped)).toEqual(new Set([a, b, c]));
  });

  it("leaves pinned tabs and manual groups alone", () => {
    let state = pinThreadTab(tabs([a, b, c, d], d), a);
    state = createThreadTabGroup(state, [b], { id: "mine", color: "steel" });
    state = grouped(state);
    expect(state.groupOf).toEqual({ [b]: "mine" });
    expect(state.pinned).toEqual([a]);
  });

  it("keeps a tab in its group while its project is not known yet", () => {
    const state = grouped(tabs([a, b], a));
    const unknown = byProject({ projectOf: (key) => (key === a ? undefined : projectOfKey[key]) });
    expect(grouped(state, unknown)).toBe(state);
  });

  it("dissolves project groups when turned off", () => {
    const state = grouped(tabs([a, b], a));
    expect(grouped(state, byProject({ enabled: false }))).toMatchObject({
      groups: [],
      groupOf: {},
    });
    const plain = tabs([a, b], a);
    expect(grouped(plain, byProject({ enabled: false }))).toBe(plain);
  });

  it("groups tabs saved before grouping existed, and round-trips", () => {
    const loaded = decodeThreadTabs(JSON.stringify({ tabs: [a, d, b], active: a }));
    const state = grouped(loaded);
    expect(state.tabs).toEqual([a, b, d]);
    expect(decodeThreadTabs(encodeThreadTabs(state))).toEqual(state);
  });
});
