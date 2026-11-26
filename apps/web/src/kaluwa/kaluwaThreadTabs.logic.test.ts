import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_THREAD_TABS,
  closeThreadTab,
  decodeThreadTabs,
  encodeThreadTabs,
  followThreadTabRoute,
  moveThreadTab,
  parseThreadTabKey,
  pruneThreadTabs,
  relativeThreadTab,
  threadTabAt,
  threadTabKeyForDraft,
  threadTabKeyForThread,
  type ThreadTabLivenessInput,
  type ThreadTabsState,
} from "./kaluwaThreadTabs.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const ref = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  threadId: ThreadId.make(id),
});
const a = threadTabKeyForThread(ref(local, "a"));
const b = threadTabKeyForThread(ref(local, "b"));
const c = threadTabKeyForThread(ref(remote, "c"));
const draft = threadTabKeyForDraft("draft-1");

const tabs = (keys: string[], active: string | null): ThreadTabsState => ({ tabs: keys, active });

describe("thread tab keys", () => {
  it("round-trips threads and drafts", () => {
    expect(parseThreadTabKey(a)).toEqual({ kind: "thread", ref: ref(local, "a") });
    expect(parseThreadTabKey(draft)).toEqual({ kind: "draft", draftId: "draft-1" });
    expect(parseThreadTabKey("thread:nothread")).toBeNull();
    expect(parseThreadTabKey("draft:")).toBeNull();
    expect(parseThreadTabKey("other")).toBeNull();
  });
});

describe("followThreadTabRoute", () => {
  it("opens the first tab", () => {
    expect(followThreadTabRoute(EMPTY_THREAD_TABS, a, { newTab: false })).toEqual(tabs([a], a));
  });

  it("replaces the current tab when a thread opens from the sidebar", () => {
    expect(followThreadTabRoute(tabs([a, b], a), c, { newTab: false })).toEqual(tabs([c, b], c));
  });

  it("opens beside the current tab when asked for a new tab", () => {
    expect(followThreadTabRoute(tabs([a, b], a), c, { newTab: true })).toEqual(tabs([a, c, b], c));
  });

  it("activates an open tab instead of opening it twice", () => {
    const state = tabs([a, b], a);
    expect(followThreadTabRoute(state, b, { newTab: true })).toEqual(tabs([a, b], b));
    expect(followThreadTabRoute(state, a, { newTab: false })).toBe(state);
  });

  it("appends when no tab is active", () => {
    expect(followThreadTabRoute(tabs([a], null), b, { newTab: false })).toEqual(tabs([a, b], b));
  });
});

describe("closeThreadTab", () => {
  it("activates the right neighbour, then the left one", () => {
    expect(closeThreadTab(tabs([a, b, c], b), b)).toEqual({ state: tabs([a, c], c), activate: c });
    expect(closeThreadTab(tabs([a, b, c], c), c)).toEqual({ state: tabs([a, b], b), activate: b });
  });

  it("keeps the active tab when closing another", () => {
    expect(closeThreadTab(tabs([a, b], a), b)).toEqual({ state: tabs([a], a), activate: null });
  });

  it("leaves no tab after the last one", () => {
    expect(closeThreadTab(tabs([a], a), a)).toEqual({ state: tabs([], null), activate: null });
  });

  it("ignores a tab that is not open", () => {
    const state = tabs([a], a);
    expect(closeThreadTab(state, b)).toEqual({ state, activate: null });
  });
});

describe("switching tabs", () => {
  it("wraps around", () => {
    const state = tabs([a, b, c], c);
    expect(relativeThreadTab(state, 1)).toBe(a);
    expect(relativeThreadTab(state, -1)).toBe(b);
    expect(relativeThreadTab(EMPTY_THREAD_TABS, 1)).toBeNull();
  });

  it("treats the ninth tab as the last, like a browser", () => {
    const state = tabs([a, b, c], a);
    expect(threadTabAt(state, 1)).toBe(b);
    expect(threadTabAt(state, 5)).toBeNull();
    expect(threadTabAt(state, 8)).toBe(c);
  });
});

describe("moveThreadTab", () => {
  it("reorders and clamps the target", () => {
    expect(moveThreadTab(tabs([a, b, c], a), a, 2)).toEqual(tabs([b, c, a], a));
    expect(moveThreadTab(tabs([a, b, c], a), c, -4)).toEqual(tabs([c, a, b], a));
    const state = tabs([a, b], a);
    expect(moveThreadTab(state, a, 0)).toBe(state);
  });
});

describe("decodeThreadTabs", () => {
  it("round-trips", () => {
    const state = tabs([a, draft, c], draft);
    expect(decodeThreadTabs(encodeThreadTabs(state))).toEqual(state);
  });

  it("drops malformed and repeated tabs and a stray active tab", () => {
    expect(
      decodeThreadTabs(JSON.stringify({ tabs: [a, a, 3, "bogus", b], active: "thread:x:y" })),
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

  it("keeps threads whose environment is not live yet", () => {
    const state = tabs([a, c], a);
    expect(pruneThreadTabs(state, input())).toBe(state);
  });

  it("keeps the active tab, which the route owns", () => {
    const state = tabs([a, b], b);
    expect(pruneThreadTabs(state, input())).toBe(state);
  });

  it("keeps open drafts and swaps a sent draft for its thread", () => {
    expect(pruneThreadTabs(tabs([a, draft], a), input({ draftExists: () => true }))).toEqual(
      tabs([a, draft], a),
    );
    expect(
      pruneThreadTabs(tabs([b, draft], b), input({ promotedTo: () => ref(local, "a") })),
    ).toEqual(tabs([b, a], b));
  });

  it("dedupes a sent draft whose thread is already open", () => {
    expect(
      pruneThreadTabs(tabs([a, draft], a), input({ promotedTo: () => ref(local, "a") })),
    ).toEqual(tabs([a], a));
  });
});
