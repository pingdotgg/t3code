import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  createThreadJumpHintVisibilityController,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarThreadIds,
  resolveAdjacentThreadId,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  orderItemsByPreferredIds,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import {
  EnvironmentId,
  OrchestrationLatestTurn,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");

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
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(true);
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

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns only the first visible thread ids up to the prewarm limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2", "t3"], 2)).toEqual(["t1", "t2"]);
  });

  it("returns all visible thread ids when they fit within the limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 10)).toEqual(["t1", "t2"]);
  });

  it("returns no thread ids when the limit is zero", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 0)).toEqual([]);
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
  it("prefers the default worktree mode over active thread context", () => {
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
      envMode: "worktree",
    });
  });

  it("inherits the active server thread context when creating a new thread in the same project", () => {
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
      branch: "effect-atom",
      worktreePath: null,
      envMode: "local",
    });
  });

  it("prefers the active draft thread context when it matches the target project", () => {
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
      branch: "feature/new-draft",
      worktreePath: "/repo/worktree",
      envMode: "worktree",
    });
  });

  it("falls back to the default env mode when there is no matching active thread context", () => {
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
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    session: {
      provider: ProviderDriverKind.make("codex"),
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
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
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
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
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
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
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
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
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
      ThreadId.make("thread-4"),
      ThreadId.make("thread-5"),
      ThreadId.make("thread-6"),
      ThreadId.make("thread-8"),
    ]);
    expect(result.hiddenThreads.map((thread) => thread.id)).toEqual([ThreadId.make("thread-7")]);
  });

  it("returns all threads when the list is expanded", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: true,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
    expect(result.hiddenThreads).toEqual([]);
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
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
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
