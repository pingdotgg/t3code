import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  createSidebarHoverPrewarmController,
  createThreadJumpHintVisibilityController,
  getVisibleSidebarThreadIds,
  resolveAdjacentThreadId,
  getFallbackThreadIdAfterDelete,
  getProjectSortTimestamp,
  hasUnseenChildNotification,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  isCollapsedSettledRow,
  orderItemsByPreferredIds,
  partitionSettledSidebarRows,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarDraftPreview,
  resolveExistingThreadDraftPreview,
  shouldRenderSidebarDraft,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarThreadGitCwd,
  selectVisibleSettledSidebarRows,
  resolveFilteredSidebarProjects,
  resolveProjectExpanded,
  resolveSidebarThreadRowStatus,
  compactSidebarTimeLabel,
  formatWorkingDurationLabel,
  resolveThreadLifecycleSupport,
  resolveWorkingStartedAt,
  resolveSidebarThreadClickKind,
  matchesSidebarThreadFilter,
  filterSidebarThreads,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { buildSidebarThreadRows, selectVisibleThreadRows } from "../sidebarThreadTree";

import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  OrchestrationLatestTurn,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type SidebarThreadSummary,
  type Thread,
  type ThreadSession,
} from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("matchesSidebarThreadFilter", () => {
  const baseThread = {
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasPendingQueuedTurn: false,
    backgroundAgentRuns: [],
    pullRequest: null,
    pullRequests: [],
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
  } as const;

  it("matches all threads by default", () => {
    expect(matchesSidebarThreadFilter({ ...baseThread }, "all")).toBe(true);
  });

  it("matches active threads with pending work", () => {
    expect(matchesSidebarThreadFilter({ ...baseThread, hasPendingUserInput: true }, "active")).toBe(
      true,
    );
    expect(matchesSidebarThreadFilter({ ...baseThread }, "active")).toBe(false);
  });

  it("matches threads whose latest turn is still running", () => {
    expect(
      matchesSidebarThreadFilter(
        {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "running",
            requestedAt: "2026-09-24T20:00:00.000Z",
            startedAt: "2026-09-24T20:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        },
        "active",
      ),
    ).toBe(true);
  });

  it("matches threads with an active orchestration turn before latest turn data arrives", () => {
    expect(
      matchesSidebarThreadFilter(
        {
          ...baseThread,
          session: {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            orchestrationStatus: "running",
            activeTurnId: TurnId.make("turn-1"),
            createdAt: "2026-09-24T20:00:00.000Z",
            updatedAt: "2026-09-24T20:00:00.000Z",
          },
        },
        "active",
      ),
    ).toBe(true);
  });

  it("matches threads with any linked pull request", () => {
    expect(
      matchesSidebarThreadFilter(
        {
          ...baseThread,
          pullRequest: {
            number: 1,
            title: "PR",
            url: "https://example.test/pr/1",
            baseBranch: "main",
            headBranch: "feature",
            state: "merged",
          },
        },
        "with_pr",
      ),
    ).toBe(true);
  });

  it("matches only open pull requests for the open PR filter", () => {
    expect(
      matchesSidebarThreadFilter(
        {
          ...baseThread,
          pullRequests: [
            {
              pullRequest: {
                number: 1,
                title: "PR",
                url: "https://example.test/pr/1",
                baseBranch: "main",
                headBranch: "feature",
                state: "open",
              },
              source: "manual",
              linkedAt: "2026-09-25T00:00:00.000Z",
            },
          ],
        },
        "open_pr",
      ),
    ).toBe(true);
    expect(
      matchesSidebarThreadFilter(
        {
          ...baseThread,
          pullRequest: {
            number: 2,
            title: "Historical PR",
            url: "https://example.test/pr/2",
            baseBranch: "main",
            headBranch: "old-feature",
            state: null,
          },
        },
        "open_pr",
      ),
    ).toBe(false);
  });

  it("returns the original array for the all filter and retains matching ancestors", () => {
    const parent = {
      ...makeThread({
        id: ThreadId.make("parent"),
        parentThreadId: null,
      }),
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasPendingQueuedTurn: false,
      backgroundAgentRuns: [],
      pullRequest: null,
      pullRequests: [],
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
    } as SidebarThreadSummary;
    const child = {
      ...makeThread({
        id: ThreadId.make("child"),
        parentThreadId: parent.id,
      }),
      hasPendingApprovals: false,
      hasPendingUserInput: true,
      hasPendingQueuedTurn: false,
      backgroundAgentRuns: [],
      pullRequest: null,
      pullRequests: [],
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
    } as SidebarThreadSummary;
    const threads = [parent, child] as const;

    expect(filterSidebarThreads(threads, "all")).toBe(threads);
    expect(filterSidebarThreads(threads, "active")).toEqual([parent, child]);
  });
});

describe("shouldRenderSidebarDraft", () => {
  it("keeps a sent draft visible until the server thread is published", () => {
    expect(
      shouldRenderSidebarDraft({
        hasUserContent: false,
        isPromoting: true,
        serverThreadPublished: false,
      }),
    ).toBe(true);
  });

  it("hands off to the regular thread row once it is published", () => {
    expect(
      shouldRenderSidebarDraft({
        hasUserContent: false,
        isPromoting: true,
        serverThreadPublished: true,
      }),
    ).toBe(false);
  });
});

describe("resolveSidebarDraftPreview", () => {
  it("keeps the submitted message visible after composer cleanup", () => {
    expect(
      resolveSidebarDraftPreview({
        draftPrompt: null,
        draftAttachmentCount: 0,
        optimisticMessage: { text: "Implement the sidebar fix\nwith tests" },
      }),
    ).toBe("Implement the sidebar fix");
  });
});

describe("resolveExistingThreadDraftPreview", () => {
  it("returns the first non-empty line", () => {
    expect(resolveExistingThreadDraftPreview("  follow up on this\nwith details ")).toBe(
      "follow up on this",
    );
  });

  it("hides empty prompts", () => {
    expect(resolveExistingThreadDraftPreview(" \n ")).toBeNull();
  });
});

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("hasUnseenChildNotification", () => {
  it("returns true when a child lifecycle notification arrived after the parent visit", () => {
    expect(
      hasUnseenChildNotification({
        latestChildNotificationAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(true);
  });

  it("returns false after the parent has visited the latest child notification", () => {
    expect(
      hasUnseenChildNotification({
        latestChildNotificationAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "2026-03-09T10:05:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("resolveSidebarThreadGitCwd", () => {
  it("uses the worktree path before project cwd fallbacks", () => {
    expect(
      resolveSidebarThreadGitCwd({
        worktreePath: "/repo/.worktrees/thread",
        threadProjectCwd: "/repo/thread-project",
        projectCwd: "/repo/project",
      }),
    ).toBe("/repo/.worktrees/thread");
  });

  it("uses the owning thread project cwd before the displayed project cwd", () => {
    expect(
      resolveSidebarThreadGitCwd({
        worktreePath: null,
        threadProjectCwd: "/repo/thread-project",
        projectCwd: "/repo/display-project",
      }),
    ).toBe("/repo/thread-project");
  });

  it("falls back to the displayed project cwd when the thread project is unknown", () => {
    expect(
      resolveSidebarThreadGitCwd({
        worktreePath: null,
        threadProjectCwd: null,
        projectCwd: "/repo/display-project",
      }),
    ).toBe("/repo/display-project");
  });
});

describe("createThreadJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("createSidebarHoverPrewarmController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeController = () => {
    const targets: Array<string | null> = [];
    const controller = createSidebarHoverPrewarmController({
      delayMs: SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS,
      onPrewarmTargetChange: (threadKey) => {
        targets.push(threadKey);
      },
    });
    return { controller, targets };
  };

  it("prewarms a row only after the pointer rests on it", () => {
    const { controller, targets } = makeController();

    controller.hover("t1");
    vi.advanceTimersByTime(SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS - 1);
    expect(targets).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(targets).toEqual(["t1"]);
  });

  it("prewarms at most one thread while sweeping across rows", () => {
    const { controller, targets } = makeController();

    controller.hover("t1");
    vi.advanceTimersByTime(SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS / 2);
    controller.hover("t2");
    vi.advanceTimersByTime(SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS / 2);
    controller.hover("t3");
    vi.advanceTimersByTime(SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS);

    expect(targets).toEqual(["t3"]);
  });

  it("releases the prewarm target when the pointer leaves thread rows", () => {
    const { controller, targets } = makeController();

    controller.hover("t1");
    vi.advanceTimersByTime(SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS);
    controller.hover(null);

    expect(targets).toEqual(["t1", null]);
  });

  it("cancels a pending prewarm when the pointer leaves early", () => {
    const { controller, targets } = makeController();

    controller.hover("t1");
    vi.advanceTimersByTime(SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS / 2);
    controller.hover(null);
    vi.advanceTimersByTime(SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS);

    expect(targets).toEqual([]);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveSidebarNewThreadSeedContext", () => {
  it("starts on a new worktree off main instead of inheriting thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "worktree",
        activeThread: {
          projectId: "project-1",
          branch: "feature/existing",
          worktreePath: "/repo/.t3/worktrees/existing",
        },
        activeDraftThread: {
          projectId: "project-1",
          branch: "feature/draft",
          worktreePath: "/repo/.t3/worktrees/draft",
          envMode: "worktree",
        },
      }),
    ).toEqual({
      branch: "main",
      worktreePath: null,
      envMode: "worktree",
    });
  });

  it("does not inherit the active server thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      branch: "main",
      worktreePath: null,
      envMode: "worktree",
    });
  });

  it("does not inherit the active draft thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: {
          projectId: "project-1",
          branch: "feature/new-draft",
          worktreePath: "/repo/worktree",
          envMode: "worktree",
        },
      }),
    ).toEqual({
      branch: "main",
      worktreePath: null,
      envMode: "worktree",
    });
  });

  it("uses a new worktree off main when there is no matching active thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-2",
        defaultEnvMode: "worktree",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      branch: "main",
      worktreePath: null,
      envMode: "worktree",
    });
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
        { id: ProjectId.make("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.make("project-3"),
        ProjectId.make("project-missing"),
        ProjectId.make("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-3"),
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.make("project-2"),
        ProjectId.make("project-1"),
        ProjectId.make("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("honors projectOrder physical keys via getProjectOrderKey", async () => {
    // Regression guard for #1904 / the regression introduced by #2055:
    // `projectOrder` is populated with physical keys (envId + cwd-derived)
    // by the store and by drag-end handlers. Readers must identify projects
    // with the same key format, or manual sort silently snaps back.
    const { getProjectOrderKey } = await import("../logicalProject");
    const projects = [
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-alpha"),
        cwd: "/work/alpha",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-beta"),
        cwd: "/work/beta",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-gamma"),
        cwd: "/work/gamma",
      },
    ];
    const ordered = orderItemsByPreferredIds({
      items: projects,
      preferredIds: [getProjectOrderKey(projects[2]!), getProjectOrderKey(projects[0]!)],
      getId: getProjectOrderKey,
    });

    expect(ordered.map((project) => project.cwd)).toEqual([
      "/work/gamma",
      "/work/alpha",
      "/work/beta",
    ]);
  });
});

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("returns only the rendered visible thread order across projects", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          renderedThreadIds: [
            ThreadId.make("thread-12"),
            ThreadId.make("thread-11"),
            ThreadId.make("thread-10"),
          ],
        },
        {
          renderedThreadIds: [ThreadId.make("thread-8"), ThreadId.make("thread-6")],
        },
      ]),
    ).toEqual([
      ThreadId.make("thread-12"),
      ThreadId.make("thread-11"),
      ThreadId.make("thread-10"),
      ThreadId.make("thread-8"),
      ThreadId.make("thread-6"),
    ]);
  });

  it("skips threads from collapsed projects whose thread panels are not shown", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          shouldShowThreadPanel: false,
          renderedThreadIds: [ThreadId.make("thread-hidden-2"), ThreadId.make("thread-hidden-1")],
        },
        {
          shouldShowThreadPanel: true,
          renderedThreadIds: [ThreadId.make("thread-12"), ThreadId.make("thread-11")],
        },
      ]),
    ).toEqual([ThreadId.make("thread-12"), ThreadId.make("thread-11")]);
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingQueuedTurn: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    session: {
      provider: ProviderDriverKind.make("codex"),
      status: "running" as const,
      activeTurnId: TurnId.make("turn-running"),
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("does not mark an idle parent when a child finishes after its last visit", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          session: null,
          latestChildNotificationAt: "2026-03-09T10:05:00.000Z",
        },
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBeNull();
  });

  it("preserves the parent's own unread completion after a child update", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          session: null,
          latestTurn: makeLatestTurn(),
          latestChildNotificationAt: "2026-03-09T10:06:00.000Z",
        },
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toMatchObject({ label: "Completed" });
  });

  it("shows working for a running virtual background agent", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: null,
          session: null,
          virtualAgentRun: {
            parentThreadId: ThreadId.make("parent-thread"),
            taskId: "agent-1",
            status: "running",
          },
        },
        lastVisitedAt: null,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("renders purely informational states as a top-right corner badge", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          virtualAgentRun: {
            parentThreadId: ThreadId.make("parent-thread"),
            taskId: "agent-1",
            status: "running",
          },
        },
        lastVisitedAt: null,
      }),
    ).toMatchObject({ label: "Working", presentation: "corner-badge", pulse: true });
  });

  it("keeps a label on states that ask the user to act", () => {
    expect(
      resolveThreadStatusPill({
        thread: { ...baseThread, hasPendingApprovals: true },
        lastVisitedAt: null,
      }),
    ).toMatchObject({ label: "Pending Approval", presentation: "label" });
  });

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
        lastVisitedAt: null,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
        },
        lastVisitedAt: null,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        lastVisitedAt: null,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows working immediately while a turn dispatch is pending locally", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: null,
          session: null,
        },
        lastVisitedAt: null,
        hasPendingTurn: true,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows working while a non-failed queued continuation is waiting to start", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingQueuedTurn: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "idle",
            activeTurnId: undefined,
          },
        },
        lastVisitedAt: "2026-03-09T10:06:00.000Z",
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("does not show working for a running session that has no active turn", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          session: {
            ...baseThread.session,
            activeTurnId: undefined,
          },
        },
        lastVisitedAt: null,
      }),
    ).toBeNull();
  });

  it("does not show working when only the provider session status is stale", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            activeTurnId: TurnId.make("turn-1"),
          },
        },
        lastVisitedAt: "2026-03-09T10:06:00.000Z",
      }),
    ).toBeNull();
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          hasPendingQueuedTurn: false,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        lastVisitedAt: null,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not show plan ready after the proposed plan was implemented elsewhere", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        lastVisitedAt: null,
      }),
    ).toMatchObject({ label: "Completed", pulse: false, presentation: "corner-badge" });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toMatchObject({ label: "Completed", pulse: false, presentation: "corner-badge" });
  });

  it("hides completed when the latest completion has already been visited", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        lastVisitedAt: "2026-03-09T10:06:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("resolveSidebarThreadRowStatus", () => {
  it("preserves a seen completion when no local turn is pending", () => {
    expect(
      resolveSidebarThreadRowStatus({
        threadStatus: null,
        hasPendingTurn: false,
      }),
    ).toBeNull();
  });

  it("overlays working while a local turn is pending", () => {
    expect(
      resolveSidebarThreadRowStatus({
        threadStatus: null,
        hasPendingTurn: true,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("keeps an actionable status above a local pending turn", () => {
    expect(
      resolveSidebarThreadRowStatus({
        threadStatus: {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
          presentation: "label",
        },
        hasPendingTurn: true,
      }),
    ).toMatchObject({ label: "Pending Approval" });
  });
});

describe("resolveProjectExpanded", () => {
  it("honours the stored state while the project has a header", () => {
    expect(resolveProjectExpanded({ storedExpanded: false, hasHeader: true })).toBe(false);
    expect(resolveProjectExpanded({ storedExpanded: true, hasHeader: true })).toBe(true);
  });

  it("forces expansion when the header is hidden", () => {
    // The header holds the only disclosure control, so a collapsed project
    // would otherwise filter down to an empty, unrecoverable list. The same
    // effective value must drive keyboard jump targets and prev/next.
    expect(resolveProjectExpanded({ storedExpanded: false, hasHeader: false })).toBe(true);
    expect(resolveProjectExpanded({ storedExpanded: true, hasHeader: false })).toBe(true);
  });
});

describe("resolveFilteredSidebarProjects", () => {
  const web = { memberProjects: [{ physicalProjectKey: "local:/code/web" }] };
  const api = {
    memberProjects: [
      { physicalProjectKey: "local:/code/api" },
      { physicalProjectKey: "remote:/code/api" },
    ],
  };
  const projects = [web, api];

  it("shows every project when no filter is set", () => {
    const result = resolveFilteredSidebarProjects({ projects, filterKey: null });
    expect(result.projects).toEqual(projects);
    expect(result.activeProject).toBeNull();
  });

  it("narrows to the filtered project", () => {
    const result = resolveFilteredSidebarProjects({ projects, filterKey: "local:/code/api" });
    expect(result.projects).toEqual([api]);
    expect(result.activeProject).toBe(api);
  });

  it("matches a grouped project through its remote member", () => {
    const result = resolveFilteredSidebarProjects({ projects, filterKey: "remote:/code/api" });
    expect(result.projects).toEqual([api]);
    expect(result.activeProject).toBe(api);
  });

  it("keeps same-path projects in different environments separately selectable", () => {
    // Regression: keying the filter on cwd alone made the second of two
    // `separate`-mode checkouts sharing a path impossible to select.
    const localRepo = { memberProjects: [{ physicalProjectKey: "local:/repo" }] };
    const remoteRepo = { memberProjects: [{ physicalProjectKey: "remote:/repo" }] };
    const sameCwdProjects = [localRepo, remoteRepo];

    expect(
      resolveFilteredSidebarProjects({ projects: sameCwdProjects, filterKey: "remote:/repo" })
        .activeProject,
    ).toBe(remoteRepo);
    expect(
      resolveFilteredSidebarProjects({ projects: sameCwdProjects, filterKey: "local:/repo" })
        .activeProject,
    ).toBe(localRepo);
  });

  it("falls back to all projects when the filtered project is gone", () => {
    const result = resolveFilteredSidebarProjects({ projects, filterKey: "local:/code/removed" });
    expect(result.projects).toEqual(projects);
    expect(result.activeProject).toBeNull();
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the darker selected palette when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-primary/22");
    expect(className).toContain("hover:bg-primary/26");
    expect(className).toContain("dark:bg-primary/30");
    expect(className).not.toContain("bg-accent/85");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-primary/15");
    expect(className).toContain("hover:bg-primary/19");
    expect(className).toContain("dark:bg-primary/22");
    expect(className).not.toContain("hover:bg-accent");
  });

  it("keeps the accent palette for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-accent/85");
    expect(className).toContain("hover:bg-accent");
  });
});

describe("resolveSidebarThreadClickKind", () => {
  it("toggles on Cmd+Click on macOS", () => {
    expect(
      resolveSidebarThreadClickKind({
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        isMac: true,
      }),
    ).toBe("toggle");
  });

  it("toggles on Ctrl+Click off macOS", () => {
    expect(
      resolveSidebarThreadClickKind({
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        isMac: false,
      }),
    ).toBe("toggle");
  });

  it("ignores Ctrl+Click on macOS, where Cmd owns toggle", () => {
    expect(
      resolveSidebarThreadClickKind({
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        isMac: true,
      }),
    ).toBe("open");
  });

  it("extends a range on Shift+Click", () => {
    expect(
      resolveSidebarThreadClickKind({
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        isMac: true,
      }),
    ).toBe("range");
    expect(
      resolveSidebarThreadClickKind({
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        isMac: false,
      }),
    ).toBe("range");
  });

  it("prefers toggle when both the modifier and Shift are held", () => {
    expect(
      resolveSidebarThreadClickKind({
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        isMac: true,
      }),
    ).toBe("toggle");
  });

  it("opens on a plain click", () => {
    expect(
      resolveSidebarThreadClickKind({
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        isMac: false,
      }),
    ).toBe("open");
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
          presentation: "corner-badge",
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
          presentation: "label",
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
          presentation: "corner-badge",
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
          presentation: "corner-badge",
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
          presentation: "label",
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    codexThreadId: null,
    projectId: ProjectId.make("project-1"),
    parentThreadId: null,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    pendingRuntimeMode: null,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-oldest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-other-project"),
          projectId: ProjectId.make("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });
});
describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-1"), name: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), name: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.make("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            createdAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:01:00.000Z",
          },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            createdAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:05:00.000Z",
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          name: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          name: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-2"),
          name: "Beta",
          createdAt: undefined,
          updatedAt: undefined,
        }),
        makeProject({
          id: ProjectId.make("project-1"),
          name: "Alpha",
          createdAt: undefined,
          updatedAt: undefined,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-2"), name: "Second" }),
      makeProject({ id: ProjectId.make("project-1"), name: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("ignores archived threads when sorting projects", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          name: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          name: "Archived-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      [
        makeThread({
          id: ThreadId.make("thread-visible"),
          projectId: ProjectId.make("project-1"),
          updatedAt: "2026-03-09T10:02:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          projectId: ProjectId.make("project-2"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-09T10:11:00.000Z",
        }),
      ].filter((thread) => thread.archivedAt === null),
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});

const SETTLED_NOW = "2026-03-09T12:00:00.000Z";

function makeSummary(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    parentThreadId: null,
    title: "Thread",
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasPendingQueuedTurn: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    provider: "codex",
    status: "ready",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    orchestrationStatus: "idle",
    ...overrides,
  } as ThreadSession;
}

function summaryKey(thread: SidebarThreadSummary): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function buildSettledRows(
  threads: readonly SidebarThreadSummary[],
  input: {
    pinnedThreadKeys?: readonly string[];
    expandedThreadKeys?: readonly string[];
  } = {},
) {
  return buildSidebarThreadRows({
    threads,
    pinnedThreadKeys: input.pinnedThreadKeys ?? [],
    expandedOverrideByThreadKey: new Map(
      (input.expandedThreadKeys ?? []).map((threadKey) => [threadKey, true]),
    ),
    sortOrder: "created_at",
    resolveThreadStatus: (thread) => resolveThreadStatusPill({ thread, lastVisitedAt: null }),
  }).rowViews;
}

describe("isCollapsedSettledRow", () => {
  it("fades a quiet settled thread", () => {
    expect(
      isCollapsedSettledRow({
        status: null,
        thread: makeSummary({ settledOverride: "settled" }),
        now: SETTLED_NOW,
      }),
    ).toBe(true);
  });

  it("keeps a settled thread with a failed pill full-strength", () => {
    const status = resolveThreadStatusPill({
      thread: makeSummary({
        settledOverride: "settled",
        latestTurn: { ...makeLatestTurn(), state: "error" },
      }),
      lastVisitedAt: null,
    });
    expect(status).not.toBeNull();
    expect(
      isCollapsedSettledRow({
        status,
        thread: makeSummary({ settledOverride: "settled" }),
        now: SETTLED_NOW,
      }),
    ).toBe(false);
  });

  it("keeps an unsettled thread full-strength", () => {
    expect(isCollapsedSettledRow({ status: null, thread: makeSummary(), now: SETTLED_NOW })).toBe(
      false,
    );
  });
});

describe("shared sidebar lifecycle presentation helpers", () => {
  it("resolves thread-settlement and snooze support independently per environment", () => {
    const localId = EnvironmentId.make("environment-local-capable");
    const remoteId = EnvironmentId.make("environment-remote-stale");
    const support = resolveThreadLifecycleSupport([
      {
        environmentId: localId,
        capabilities: { threadSettlement: true, threadSnooze: true },
      } as unknown as ExecutionEnvironmentDescriptor,
      {
        environmentId: remoteId,
        capabilities: { threadSettlement: false, threadSnooze: false },
      } as unknown as ExecutionEnvironmentDescriptor,
    ]);

    expect(support.get(localId)).toEqual({ settlement: true, snooze: true });
    expect(support.get(remoteId)).toEqual({ settlement: false, snooze: false });
  });

  it("uses the first valid timestamp for a working thread", () => {
    const startedAt = "2026-01-01T00:00:05.000Z";
    expect(
      resolveWorkingStartedAt({
        latestTurn: {
          startedAt: "not-a-date",
          requestedAt: "also-not-a-date",
          completedAt: null,
        } as NonNullable<SidebarThreadSummary["latestTurn"]>,
        session: makeSession({ updatedAt: startedAt }),
        createdAt: "2025-12-31T00:00:00.000Z",
      }),
    ).toBe(startedAt);
  });

  it("formats elapsed durations compactly and removes the repeated relative suffix", () => {
    expect(formatWorkingDurationLabel(4_200)).toBe("4s");
    expect(formatWorkingDurationLabel(4 * 60_000)).toBe("4m");
    expect(formatWorkingDurationLabel(125 * 60_000)).toBe("2h 5m");
    expect(formatWorkingDurationLabel(Number.NaN)).toBe("0s");
    expect(compactSidebarTimeLabel("3m ago")).toBe("3m");
    expect(compactSidebarTimeLabel("just now")).toBe("now");
  });
});

describe("selectVisibleSettledSidebarRows", () => {
  const settledThreads = Array.from({ length: 7 }, (_, index) =>
    makeSummary({
      id: ThreadId.make(`thread-settled-${index}`),
      title: `Settled ${index}`,
      createdAt: `2026-03-09T10:0${index}:00.000Z`,
      updatedAt: `2026-03-09T10:0${index}:00.000Z`,
      settledOverride: "settled",
      settledAt: `2026-03-09T11:0${index}:00.000Z`,
    }),
  );
  const active = makeSummary({
    id: ThreadId.make("thread-active-for-settled-shelf"),
    title: "Active",
  });
  const partitioned = partitionSettledSidebarRows(buildSettledRows([...settledThreads, active]), {
    now: SETTLED_NOW,
  });

  it("shows the configured recent groups and counts the rest", () => {
    const visible = selectVisibleSettledSidebarRows({
      activeRows: partitioned.activeRows,
      settledGroups: partitioned.settledGroups,
      visibleCount: 5,
      showAll: false,
      activeThreadKey: null,
    });

    expect(
      visible.settledRows.filter((row) => row.depth === 0).map((row) => row.thread.title),
    ).toEqual(["Settled 6", "Settled 5", "Settled 4", "Settled 3", "Settled 2"]);
    expect(visible.remainingCount).toBe(2);
    expect(visible.activeRows.map((row) => row.thread.title)).toEqual(["Active"]);
  });

  it("keeps an older routed group visible while preserving its hidden count", () => {
    const oldest = settledThreads[0]!;
    const visible = selectVisibleSettledSidebarRows({
      activeRows: partitioned.activeRows,
      settledGroups: partitioned.settledGroups,
      visibleCount: 5,
      showAll: false,
      activeThreadKey: summaryKey(oldest),
    });

    expect(
      visible.settledRows.filter((row) => row.depth === 0).map((row) => row.thread.title),
    ).toEqual(["Settled 6", "Settled 5", "Settled 4", "Settled 3", "Settled 2", "Settled 0"]);
    expect(visible.remainingCount).toBe(1);
  });

  it("shows every settled group after Show more", () => {
    const visible = selectVisibleSettledSidebarRows({
      activeRows: partitioned.activeRows,
      settledGroups: partitioned.settledGroups,
      visibleCount: 5,
      showAll: true,
      activeThreadKey: null,
    });

    expect(
      visible.settledRows.filter((row) => row.depth === 0).map((row) => row.thread.title),
    ).toEqual(settledThreads.map((thread) => thread.title).reverse());
    expect(visible.remainingCount).toBe(0);
  });
});

describe("partitionSettledSidebarRows", () => {
  it("sinks settled roots below active roots", () => {
    const settled = makeSummary({
      id: ThreadId.make("thread-settled"),
      title: "Settled",
      createdAt: "2026-03-09T10:05:00.000Z",
      updatedAt: "2026-03-09T10:05:00.000Z",
      settledOverride: "settled",
      settledAt: "2026-03-09T11:00:00.000Z",
    });
    const active = makeSummary({
      id: ThreadId.make("thread-active"),
      title: "Active",
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const rowViews = buildSettledRows([settled, active]);
    // Newest-created sorts first, so the settled root starts on top.
    expect(rowViews.map((row) => row.thread.title)).toEqual(["Settled", "Active"]);

    const partitioned = partitionSettledSidebarRows(rowViews, { now: SETTLED_NOW });

    expect(partitioned.rowViews.map((row) => row.thread.title)).toEqual(["Active", "Settled"]);
    expect(partitioned.orderedThreadKeys).toEqual(partitioned.rowViews.map((row) => row.threadKey));
    expect(partitioned.settledThreadKeys).toEqual(new Set([summaryKey(settled)]));
  });

  it("keeps a settled parent's subtree whole and marks nested children settled", () => {
    const parent = makeSummary({
      id: ThreadId.make("thread-parent"),
      title: "Parent",
      settledOverride: "settled",
      settledAt: "2026-03-09T11:00:00.000Z",
    });
    const child = makeSummary({
      id: ThreadId.make("thread-child"),
      title: "Child",
      parentThreadId: parent.id,
    });
    const rowViews = buildSettledRows([parent, child], {
      expandedThreadKeys: [summaryKey(parent)],
    });

    const partitioned = partitionSettledSidebarRows(rowViews, { now: SETTLED_NOW });

    expect(partitioned.rowViews.map((row) => row.thread.title)).toEqual(["Parent", "Child"]);
    // Nested children of a settled root fade too.
    expect(partitioned.settledThreadKeys).toEqual(new Set([summaryKey(parent), summaryKey(child)]));
  });

  it("keeps a settled root active when a descendant needs attention", () => {
    const parent = makeSummary({
      id: ThreadId.make("thread-parent"),
      title: "Parent",
      settledOverride: "settled",
      settledAt: "2026-03-09T11:00:00.000Z",
    });
    const child = makeSummary({
      id: ThreadId.make("thread-child"),
      title: "Child",
      parentThreadId: parent.id,
      hasPendingUserInput: true,
    });
    const rowViews = buildSettledRows([parent, child]);

    const partitioned = partitionSettledSidebarRows(rowViews, { now: SETTLED_NOW });

    // A settled parent cannot bury a child that is blocked on the user.
    expect(partitioned.rowViews.map((row) => row.thread.title)).toEqual(["Parent", "Child"]);
    expect(partitioned.settledThreadKeys).toEqual(new Set());
  });

  it("sorts settled roots most-recently-settled first", () => {
    const older = makeSummary({
      id: ThreadId.make("thread-older"),
      title: "Older",
      createdAt: "2026-03-09T10:30:00.000Z",
      updatedAt: "2026-03-09T10:30:00.000Z",
      settledOverride: "settled",
      settledAt: "2026-03-09T10:00:00.000Z",
    });
    const newer = makeSummary({
      id: ThreadId.make("thread-newer"),
      title: "Newer",
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      settledOverride: "settled",
      settledAt: "2026-03-09T11:00:00.000Z",
    });
    const rowViews = buildSettledRows([older, newer]);
    expect(rowViews.map((row) => row.thread.title)).toEqual(["Older", "Newer"]);

    const partitioned = partitionSettledSidebarRows(rowViews, { now: SETTLED_NOW });

    expect(partitioned.rowViews.map((row) => row.thread.title)).toEqual(["Newer", "Older"]);
  });

  it("keeps a pinned settled root leading but faded", () => {
    const settled = makeSummary({
      id: ThreadId.make("thread-settled"),
      title: "Settled",
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      settledOverride: "settled",
      settledAt: "2026-03-09T11:00:00.000Z",
    });
    const active = makeSummary({
      id: ThreadId.make("thread-active"),
      title: "Active",
      createdAt: "2026-03-09T10:05:00.000Z",
      updatedAt: "2026-03-09T10:05:00.000Z",
    });
    const rowViews = buildSettledRows([settled, active], {
      pinnedThreadKeys: [summaryKey(settled)],
    });

    const partitioned = partitionSettledSidebarRows(rowViews, {
      now: SETTLED_NOW,
      pinnedThreadKeys: new Set([summaryKey(settled)]),
    });

    // A pin is an explicit order override the settle must not defeat.
    expect(partitioned.rowViews.map((row) => row.thread.title)).toEqual(["Settled", "Active"]);
    expect(partitioned.settledThreadKeys).toEqual(new Set([summaryKey(settled)]));
  });

  it("keeps a settled root active when its own turn failed", () => {
    const failed = makeSummary({
      id: ThreadId.make("thread-failed"),
      title: "Failed",
      createdAt: "2026-03-09T10:05:00.000Z",
      updatedAt: "2026-03-09T10:05:00.000Z",
      settledOverride: "settled",
      settledAt: "2026-03-09T11:00:00.000Z",
      latestTurn: { ...makeLatestTurn(), state: "error" },
    });
    const active = makeSummary({
      id: ThreadId.make("thread-active"),
      title: "Active",
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const rowViews = buildSettledRows([failed, active]);

    const partitioned = partitionSettledSidebarRows(rowViews, { now: SETTLED_NOW });

    // The failed pill needs attention even though no canSettle blocker fires.
    expect(partitioned.rowViews.map((row) => row.thread.title)).toEqual(["Failed", "Active"]);
    expect(partitioned.settledThreadKeys).toEqual(new Set());
  });

  it("keeps a settled root with an unseen completion active", () => {
    const done = makeSummary({
      id: ThreadId.make("thread-done"),
      title: "Done",
      createdAt: "2026-03-09T10:05:00.000Z",
      updatedAt: "2026-03-09T10:05:00.000Z",
      settledOverride: "settled",
      settledAt: "2026-03-09T11:00:00.000Z",
      latestUserMessageAt: "2026-03-09T09:55:00.000Z",
      latestTurn: makeLatestTurn(),
    });
    const active = makeSummary({
      id: ThreadId.make("thread-active"),
      title: "Active",
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const rowViews = buildSettledRows([done, active]);

    const partitioned = partitionSettledSidebarRows(rowViews, { now: SETTLED_NOW });

    // buildSettledRows visits nothing, so the completed turn reads as unseen.
    expect(partitioned.rowViews.map((row) => row.thread.title)).toEqual(["Done", "Active"]);
    expect(partitioned.settledThreadKeys).toEqual(new Set());
  });

  it("keeps the active-route settled row visible below the window", () => {
    const active = makeSummary({
      id: ThreadId.make("thread-active"),
      title: "Active",
      createdAt: "2026-03-09T10:30:00.000Z",
      updatedAt: "2026-03-09T10:30:00.000Z",
    });
    const settledThreads = ["s1", "s2", "s3"].map((suffix, index) =>
      makeSummary({
        id: ThreadId.make(`thread-settled-${suffix}`),
        title: `Settled ${suffix}`,
        createdAt: `2026-03-09T10:0${index}:00.000Z`,
        updatedAt: `2026-03-09T10:0${index}:00.000Z`,
        settledOverride: "settled",
        settledAt: `2026-03-09T11:0${index}:00.000Z`,
      }),
    );
    const partitioned = partitionSettledSidebarRows(buildSettledRows([active, ...settledThreads]), {
      now: SETTLED_NOW,
    });
    const routedKey = summaryKey(settledThreads[0]!);

    const withoutRoute = selectVisibleThreadRows({
      rowViews: partitioned.rowViews,
      rootLimit: 1,
    });
    expect(withoutRoute.hasOverflow).toBe(true);
    expect(withoutRoute.rows.some((row) => row.threadKey === routedKey)).toBe(false);

    const withRoute = selectVisibleThreadRows({
      rowViews: partitioned.rowViews,
      rootLimit: 1,
      requiredThreadKey: routedKey,
    });
    expect(withRoute.hasOverflow).toBe(true);
    expect(withRoute.rows.some((row) => row.threadKey === routedKey)).toBe(true);
  });
});
