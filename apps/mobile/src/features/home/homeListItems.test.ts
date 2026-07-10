import {
  presentThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { subagentThreadKey } from "@t3tools/client-runtime/state/thread-relationships";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeListLayout,
  DEFAULT_GROUP_DISPLAY_STATE,
  HOME_INITIAL_VISIBLE_THREADS,
  HOME_SHOW_MORE_STEP,
  nextGroupDisplayState,
  type HomeGroupDisplayState,
  type HomeListItem,
} from "./homeListItems";
import type { HomeThreadGroup } from "./homeThreadList";

const environmentId = EnvironmentId.make("environment-1");

function makeProject(id: string, title: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

const threadTimestamp = DateTime.makeUnsafe("2026-06-01T00:00:00.000Z");

function makeThread(id: string, projectId: ProjectId): EnvironmentThreadShell {
  const threadId = ThreadId.make(id);
  return presentThreadShell(environmentId, {
    id: threadId,
    projectId,
    title: `Thread ${id}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "mobile",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: threadTimestamp,
    updatedAt: threadTimestamp,
    archivedAt: null,
    deletedAt: null,
  });
}

function makeGroup(key: string, threadCount: number): HomeThreadGroup {
  const project = makeProject(key, key);
  const threads = Array.from({ length: threadCount }, (_, index) =>
    makeThread(`${key}-thread-${index}`, project.id),
  );
  return {
    key,
    title: key,
    representative: project,
    projects: [project],
    pendingTasks: [],
    threads,
    // All threads inside the recency window, so the baseline stays at the
    // initial page size and the pagination expectations below hold.
    recentThreads: threads,
    newThreadTarget: project,
  };
}

function itemTypes(items: ReadonlyArray<HomeListItem>): string[] {
  return items.map((item) => item.type);
}

function displayStates(
  entries: Record<string, HomeGroupDisplayState>,
): ReadonlyMap<string, HomeGroupDisplayState> {
  return new Map(Object.entries(entries));
}

describe("buildHomeListLayout", () => {
  it("hides subagents by default and paginates only roots when nesting is enabled", () => {
    const project = makeProject("nested", "nested");
    const roots = Array.from({ length: 8 }, (_, index) => makeThread(`root-${index}`, project.id));
    const children = roots.map((root, index) => {
      const child = makeThread(`child-${index}`, project.id);
      return {
        ...child,
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: "subagent" as const,
        },
      };
    });
    const group: HomeThreadGroup = {
      key: "nested",
      title: "nested",
      representative: project,
      projects: [project],
      pendingTasks: [],
      threads: roots.flatMap((root, index) => [root, children[index] as EnvironmentThreadShell]),
      recentThreads: roots,
      newThreadTarget: project,
    };

    const hidden = buildHomeListLayout({ groups: [group], displayStates: new Map() });
    expect(
      hidden.items.filter((item) => item.type === "thread").map((item) => item.thread.id),
    ).toEqual(roots.slice(0, HOME_INITIAL_VISIBLE_THREADS).map((thread) => thread.id));
    expect(hidden.items.at(-1)).toMatchObject({ type: "show-more", hiddenCount: 2 });

    const expandedThreadKeys = new Set(
      roots.slice(0, HOME_INITIAL_VISIBLE_THREADS).map(subagentThreadKey),
    );
    const nested = buildHomeListLayout({
      groups: [group],
      displayStates: new Map(),
      showSubagentThreads: true,
      expandedThreadKeys,
    });
    const nestedRows = nested.items.filter((item) => item.type === "thread");
    expect(nestedRows).toHaveLength(HOME_INITIAL_VISIBLE_THREADS * 2);
    expect(nestedRows.map((item) => item.depth)).toEqual(
      Array.from({ length: HOME_INITIAL_VISIBLE_THREADS }, () => [0, 1]).flat(),
    );
    expect(nested.items.at(-1)).toMatchObject({ type: "show-more", hiddenCount: 2 });
  });

  it("renders a header plus all threads for a small group without a show-more row", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 3)],
      displayStates: displayStates({}),
    });

    expect(itemTypes(layout.items)).toEqual(["header", "thread", "thread", "thread"]);
    expect(layout.stickyHeaderIndices).toEqual([0]);
    expect(layout.items.at(-1)).toMatchObject({ type: "thread", isLast: true });
  });

  it("limits large groups to the initial visible count with a show-more row", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 133)],
      displayStates: displayStates({}),
    });

    const threadItems = layout.items.filter((item) => item.type === "thread");
    expect(threadItems).toHaveLength(HOME_INITIAL_VISIBLE_THREADS);
    expect(layout.items.at(-1)).toMatchObject({
      type: "show-more",
      groupKey: "alpha",
      hiddenCount: 133 - HOME_INITIAL_VISIBLE_THREADS,
      canShowLess: false,
    });
    // The show-more row takes over the last slot, so no thread is marked last.
    expect(threadItems.every((item) => item.type === "thread" && !item.isLast)).toBe(true);
  });

  it("reveals more threads per show-more step and offers show-less when exhausted", () => {
    const group = makeGroup("alpha", 20);

    const expandedOnce = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
      }),
    });
    expect(expandedOnce.items.filter((item) => item.type === "thread")).toHaveLength(
      HOME_INITIAL_VISIBLE_THREADS + HOME_SHOW_MORE_STEP,
    );
    expect(expandedOnce.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 4,
      canShowLess: true,
    });

    const fullyExpanded = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(
          nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
          "show-more",
        ),
      }),
    });
    expect(fullyExpanded.items.filter((item) => item.type === "thread")).toHaveLength(20);
    expect(fullyExpanded.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 0,
      canShowLess: true,
    });

    const reset = nextGroupDisplayState(
      nextGroupDisplayState(
        nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
        "show-more",
      ),
      "show-less",
    );
    expect(reset.visibleCount).toBe(HOME_INITIAL_VISIBLE_THREADS);
  });

  it("offers show-less after expanding a stale group whose baseline is below the page size", () => {
    // Stale project: 10 threads total but only 3 within the recency window.
    const project = makeProject("stale", "stale");
    const threads = Array.from({ length: 10 }, (_, index) =>
      makeThread(`stale-thread-${index}`, project.id),
    );
    const group: HomeThreadGroup = {
      key: "stale",
      title: "stale",
      representative: project,
      projects: [project],
      pendingTasks: [],
      threads,
      recentThreads: threads.slice(0, 3),
      newThreadTarget: project,
    };

    const collapsedToRecent = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({}),
    });
    expect(collapsedToRecent.items.filter((item) => item.type === "thread")).toHaveLength(3);
    expect(collapsedToRecent.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 7,
      canShowLess: false,
    });

    const expanded = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({
        stale: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
      }),
    });
    expect(expanded.items.filter((item) => item.type === "thread")).toHaveLength(10);
    expect(expanded.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 0,
      canShowLess: true,
    });
  });

  it("hides threads and the show-more row for collapsed groups", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 12), makeGroup("beta", 2)],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "toggle-collapsed"),
      }),
    });

    expect(itemTypes(layout.items)).toEqual(["header", "header", "thread", "thread"]);
    expect(layout.items[0]).toMatchObject({ type: "header", collapsed: true, isFirst: true });
    expect(layout.items[1]).toMatchObject({ type: "header", collapsed: false, isFirst: false });
    expect(layout.stickyHeaderIndices).toEqual([0, 1]);
  });

  it("suspends collapse and pagination while searching", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 12)],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "toggle-collapsed"),
      }),
      showAllThreads: true,
    });

    expect(layout.items.filter((item) => item.type === "thread")).toHaveLength(12);
    expect(layout.items.some((item) => item.type === "show-more")).toBe(false);
  });

  it("keeps sticky indices aligned across multiple expanded groups", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 8), makeGroup("beta", 1)],
      displayStates: displayStates({}),
    });

    // header + 6 threads + show-more = 8 items, so beta's header is index 8.
    expect(layout.stickyHeaderIndices).toEqual([0, 8]);
    expect(layout.items[8]).toMatchObject({ type: "header", isFirst: false });
  });
});
