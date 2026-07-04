import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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

function makeThread(id: string, projectId: ProjectId): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function makeGroup(key: string, threadCount: number): HomeThreadGroup {
  const project = makeProject(key, key);
  return {
    key,
    title: key,
    representative: project,
    projects: [project],
    pendingTasks: [],
    threads: Array.from({ length: threadCount }, (_, index) =>
      makeThread(`${key}-thread-${index}`, project.id),
    ),
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
