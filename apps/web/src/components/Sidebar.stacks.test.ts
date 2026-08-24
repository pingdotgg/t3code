import { describe, expect, it } from "vite-plus/test";
import {
  planActiveThreadsWithStacks,
  sidebarStackProjectKey,
  stackOpenPrListProjectRefs,
  type SidebarStackPullRequest,
} from "./Sidebar.stacks";

interface TestThread {
  environmentId: string;
  projectId: string;
  id: string;
}

const thread = (id: string, projectId = "p1"): TestThread => ({
  environmentId: "env1",
  projectId,
  id,
});
const keyOf = (t: TestThread) => `${t.environmentId}:${t.id}`;

const pr = (
  number: number,
  headRef: string,
  baseRef: string,
  overrides?: Partial<SidebarStackPullRequest>,
): SidebarStackPullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://example.com/pull/${number}`,
  headRef,
  baseRef,
  ...overrides,
});

const projectKey = sidebarStackProjectKey({ environmentId: "env1", projectId: "p1" });

// The motivating fixture: a GitButler workspace with the stack
// #25448 → #25390 (no thread) → #25356 → #25312, plus unrelated threads.
const top = pr(25448, "feat/configs", "feat/tour-codes");
const ghost = pr(25390, "feat/tour-codes", "feat/units");
const mid = pr(25356, "feat/units", "feat/base");
const base = pr(25312, "feat/base", "main");
const unrelated = pr(25366, "feat/passthrough", "main");

const tTop = thread("t-25448");
const tWork = thread("t-work");
const tUnrelated = thread("t-25366");
const tMid = thread("t-25356");
const tBase = thread("t-25312");
const activeThreads = [tTop, tWork, tUnrelated, tMid, tBase];

const displayed = new Map([
  [keyOf(tTop), top],
  [keyOf(tUnrelated), unrelated],
  [keyOf(tMid), mid],
  [keyOf(tBase), base],
]);

describe("stackOpenPrListProjectRefs", () => {
  it("selects only projects with at least two open-PR threads", () => {
    const refs = stackOpenPrListProjectRefs({
      activeThreads,
      threadKeyOf: keyOf,
      displayedOpenPrByThreadKey: displayed,
    });
    expect(refs).toEqual([{ environmentId: "env1", projectId: "p1" }]);

    const single = stackOpenPrListProjectRefs({
      activeThreads: [tTop, tWork],
      threadKeyOf: keyOf,
      displayedOpenPrByThreadKey: new Map([[keyOf(tTop), top]]),
    });
    expect(single).toEqual([]);
  });
});

describe("planActiveThreadsWithStacks", () => {
  const plan = (options?: {
    openPrs?: readonly SidebarStackPullRequest[];
    backed?: ReadonlySet<number>;
    threads?: readonly TestThread[];
    displayedPrs?: ReadonlyMap<string, SidebarStackPullRequest>;
  }) =>
    planActiveThreadsWithStacks({
      activeThreads: options?.threads ?? activeThreads,
      threadKeyOf: keyOf,
      displayedOpenPrByThreadKey: options?.displayedPrs ?? displayed,
      openPrsByProjectKey: new Map([[projectKey, options?.openPrs ?? []]]),
      threadBackedPrNumbersByProjectKey: new Map(
        options?.backed ? [[projectKey, options.backed]] : [],
      ),
    });

  it("groups directly chained threads into one stack, top of stack first", () => {
    // No open-PR list fetched: #25448's base (#25390) is unknown, so it stays
    // a plain row and only the directly linked 25356→25312 pair groups,
    // anchored at its most recent member.
    const items = plan();
    expect(items.map((item) => item.kind)).toEqual(["thread", "thread", "thread", "stack"]);
    const stack = items[3];
    if (stack?.kind !== "stack") throw new Error("expected stack");
    expect(stack.group.anchor).toBe(tMid);
    expect(stack.group.entries.map((entry) => entry.pr.number)).toEqual([25356, 25312]);
  });

  it("inserts ghosts from the open-PR list at their true position", () => {
    const items = plan({ openPrs: [ghost, unrelated] });
    const stack = items.find((item) => item.kind === "stack");
    if (stack?.kind !== "stack") throw new Error("expected stack");
    expect(stack.group.entries.map((entry) => entry.pr.number)).toEqual([
      25448, 25390, 25356, 25312,
    ]);
    expect(stack.group.entries.map((entry) => entry.thread?.id ?? null)).toEqual([
      "t-25448",
      null,
      "t-25356",
      "t-25312",
    ]);
    // The unrelated open PR joins no chain and creates no ghost-only group.
    expect(items.filter((item) => item.kind === "stack")).toHaveLength(1);
  });

  it("keeps non-member threads in their original order", () => {
    const items = plan({ openPrs: [ghost] });
    const threadIds = items.flatMap((item) => (item.kind === "thread" ? [item.thread.id] : []));
    expect(threadIds).toEqual(["t-work", "t-25366"]);
  });

  it("omits PRs backed by threads outside the active section instead of ghosting them", () => {
    const items = plan({ openPrs: [ghost], backed: new Set([25390]) });
    const stack = items.find((item) => item.kind === "stack");
    if (stack?.kind !== "stack") throw new Error("expected stack");
    expect(stack.group.entries.map((entry) => entry.pr.number)).toEqual([25448, 25356, 25312]);
  });

  it("yields two groups for two independent chains", () => {
    const otherTop = pr(30, "feat/x2", "feat/x1");
    const otherBase = pr(29, "feat/x1", "main");
    const tOtherTop = thread("t-30");
    const tOtherBase = thread("t-29");
    const items = plan({
      threads: [...activeThreads, tOtherTop, tOtherBase],
      displayedPrs: new Map([
        ...displayed,
        [keyOf(tOtherTop), otherTop],
        [keyOf(tOtherBase), otherBase],
      ]),
    });
    expect(items.filter((item) => item.kind === "stack")).toHaveLength(2);
  });

  it("requires at least two thread-backed PRs per group", () => {
    const items = plan({
      threads: [tTop, tWork],
      displayedPrs: new Map([[keyOf(tTop), top]]),
      openPrs: [ghost, mid, base],
    });
    expect(items.every((item) => item.kind === "thread")).toBe(true);
  });

  it("survives ref cycles without hanging or throwing", () => {
    const cycleA = pr(1, "a", "b");
    const cycleB = pr(2, "b", "a");
    const tA = thread("t-1");
    const tB = thread("t-2");
    const items = plan({
      threads: [tA, tB],
      displayedPrs: new Map([
        [keyOf(tA), cycleA],
        [keyOf(tB), cycleB],
      ]),
    });
    const stack = items.find((item) => item.kind === "stack");
    if (stack?.kind !== "stack") throw new Error("expected stack");
    expect(stack.group.entries).toHaveLength(2);
  });

  it("does not draw siblings of one base as a chain", () => {
    // Two PRs based on feat/base: neither sits on the other, so the rail would
    // be claiming an order the repository does not have.
    const forkA = pr(41, "feat/a", "feat/base");
    const forkB = pr(42, "feat/b", "feat/base");
    const tForkA = thread("t-41");
    const tForkB = thread("t-42");
    const items = plan({
      threads: [tForkA, tForkB, tBase],
      displayedPrs: new Map([
        [keyOf(tForkA), forkA],
        [keyOf(tForkB), forkB],
        [keyOf(tBase), base],
      ]),
    });
    expect(items.every((item) => item.kind === "thread")).toBe(true);
  });

  it("still chains the linear part of a repository that forks elsewhere", () => {
    // #25448 → #25390 → #25356 is linear; two PRs fork off #25312's branch, so
    // the chain stops at #25356 rather than swallowing the fork.
    const forkA = pr(41, "feat/a", "feat/base");
    const forkB = pr(42, "feat/b", "feat/base");
    const tForkA = thread("t-41");
    const items = plan({
      threads: [tTop, tMid, tForkA],
      displayedPrs: new Map([
        [keyOf(tTop), top],
        [keyOf(tMid), mid],
        [keyOf(tForkA), forkA],
      ]),
      openPrs: [ghost, base, forkB],
    });
    const stack = items.find((item) => item.kind === "stack");
    if (stack?.kind !== "stack") throw new Error("expected stack");
    expect(stack.group.entries.map((entry) => entry.pr.number)).toEqual([25448, 25390, 25356]);
  });

  it("does not group threads across projects", () => {
    const tOther = thread("t-other", "p2");
    const items = planActiveThreadsWithStacks({
      activeThreads: [tTop, tOther],
      threadKeyOf: keyOf,
      displayedOpenPrByThreadKey: new Map([
        [keyOf(tTop), top],
        [keyOf(tOther), pr(99, "feat/tour-codes", "main")],
      ]),
      openPrsByProjectKey: new Map(),
      threadBackedPrNumbersByProjectKey: new Map(),
    });
    expect(items.every((item) => item.kind === "thread")).toBe(true);
  });
});
