import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildSidebarThreadRows,
  createThreadJumpHintVisibilityController,
  filterProjectsForVscodeScope,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarThreadIds,
  isContextualSubagentSidebarThread,
  resolveAdjacentThreadId,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  isRootSidebarThread,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarOptionsMenuVisibility,
  resolveSidebarStageBadgeLabel,
  resolveThreadListClassName,
  resolveVscodeProjectScope,
  resolveVscodeInitialThreadRef,
  resolveThreadRowClassName,
  resolveThreadRowIndentStyle,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import {
  EnvironmentId,
  OrchestrationLatestTurn,
  ProjectId,
  ProviderItemId,
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
} from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("resolveSidebarStageBadgeLabel", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("returns the fallback label for stable primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.27",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });

  it("returns the fallback label when the primary server version is missing", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: null,
        fallbackStageLabel: "Dev",
      }),
    ).toBe("Dev");
  });

  it("returns the fallback label for malformed nightly prerelease versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
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

  it("treats a missing client visit marker as read", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: undefined,
        session: null,
      }),
    ).toBe(false);
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

describe("filterProjectsForVscodeScope", () => {
  it("keeps only the current VS Code project by environment and bootstrap project id", () => {
    const project1 = {
      id: ProjectId.make("project-1"),
      environmentId: localEnvironmentId,
      cwd: "/repo/current",
    };
    const project2 = {
      id: ProjectId.make("project-2"),
      environmentId: localEnvironmentId,
      cwd: "/repo/other",
    };
    const remoteProject = {
      id: ProjectId.make("project-1"),
      environmentId: remoteEnvironmentId,
      cwd: "/repo/current",
    };

    expect(
      filterProjectsForVscodeScope([project1, project2, remoteProject], {
        environmentId: localEnvironmentId,
        projectId: ProjectId.make("project-1"),
        cwd: "/repo/current",
      }),
    ).toEqual([project1]);
  });

  it("falls back to the current backend cwd before the bootstrap project id is known", () => {
    const currentProject = {
      id: ProjectId.make("project-current"),
      environmentId: localEnvironmentId,
      cwd: "/repo/current",
    };
    const otherProject = {
      id: ProjectId.make("project-other"),
      environmentId: localEnvironmentId,
      cwd: "/repo/other",
    };

    expect(
      filterProjectsForVscodeScope([otherProject, currentProject], {
        environmentId: localEnvironmentId,
        cwd: "/repo/current",
      }),
    ).toEqual([currentProject]);
  });

  it("keeps all bootstrapped VS Code projects in multi-root workspaces", () => {
    const project1 = {
      id: ProjectId.make("project-1"),
      environmentId: localEnvironmentId,
      cwd: "/repo/api",
    };
    const project2 = {
      id: ProjectId.make("project-2"),
      environmentId: localEnvironmentId,
      cwd: "/repo/web",
    };
    const otherProject = {
      id: ProjectId.make("project-3"),
      environmentId: localEnvironmentId,
      cwd: "/repo/other",
    };

    expect(
      filterProjectsForVscodeScope([project1, otherProject, project2], {
        environmentId: localEnvironmentId,
        projectIds: [project1.id, project2.id],
        activeProjectId: project2.id,
      }),
    ).toEqual([project1, project2]);
  });

  it("falls back to bootstrapped cwds before project ids are known", () => {
    const project1 = {
      id: ProjectId.make("project-1"),
      environmentId: localEnvironmentId,
      cwd: "/repo/api",
    };
    const project2 = {
      id: ProjectId.make("project-2"),
      environmentId: localEnvironmentId,
      cwd: "/repo/web",
    };
    const otherProject = {
      id: ProjectId.make("project-3"),
      environmentId: localEnvironmentId,
      cwd: "/repo/other",
    };

    expect(
      filterProjectsForVscodeScope([project1, otherProject, project2], {
        environmentId: localEnvironmentId,
        cwds: ["/repo/api", "/repo/web"],
      }),
    ).toEqual([project1, project2]);
  });
});

describe("resolveVscodeProjectScope", () => {
  it("uses the VS Code host bridge workspace bootstrap when desktop welcome has no VS Code projects", () => {
    expect(
      resolveVscodeProjectScope({
        serverWelcome: {
          environment: { environmentId: localEnvironmentId },
          cwd: "/desktop",
        },
        serverConfig: {
          environment: { environmentId: localEnvironmentId },
          cwd: "/desktop",
        },
        vscodeWorkspaceBootstrap: {
          environmentId: localEnvironmentId,
          workspaceFolders: [
            {
              key: "file::/workspace",
              name: "workspace",
              cwd: "/workspace",
              uriScheme: "file",
              uriAuthority: "",
            },
          ],
          activeWorkspaceFolderKey: "file::/workspace",
          bootstrapProjects: [
            {
              workspaceFolderKey: "file::/workspace",
              workspaceFolderName: "workspace",
              cwd: "/workspace",
              projectId: ProjectId.make("project-workspace"),
              bootstrapThreadId: ThreadId.make("thread-workspace"),
              isActive: true,
            },
          ],
        },
      }),
    ).toEqual({
      environmentId: localEnvironmentId,
      projectId: ProjectId.make("project-workspace"),
      projectIds: [ProjectId.make("project-workspace")],
      activeProjectId: ProjectId.make("project-workspace"),
      cwd: "/desktop",
      cwds: ["/workspace"],
    });
  });
});

function makeSidebarThread(
  overrides: Partial<SidebarThreadSummary> & Pick<SidebarThreadSummary, "id" | "projectId">,
): SidebarThreadSummary {
  return {
    environmentId: localEnvironmentId,
    title: "Thread",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    latestUserMessageAt: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  } as SidebarThreadSummary;
}

describe("resolveVscodeInitialThreadRef", () => {
  it("selects the most recently visited thread within the current VS Code project", () => {
    const currentOlder = makeSidebarThread({
      id: ThreadId.make("thread-current-older"),
      projectId: ProjectId.make("project-current"),
      updatedAt: "2026-03-09T10:10:00.000Z",
    });
    const currentLastOpen = makeSidebarThread({
      id: ThreadId.make("thread-current-last-open"),
      projectId: ProjectId.make("project-current"),
      updatedAt: "2026-03-09T10:05:00.000Z",
    });
    const otherProjectRecent = makeSidebarThread({
      id: ThreadId.make("thread-other-recent"),
      projectId: ProjectId.make("project-other"),
      updatedAt: "2026-03-09T10:20:00.000Z",
    });

    expect(
      resolveVscodeInitialThreadRef({
        threads: [otherProjectRecent, currentOlder, currentLastOpen],
        threadLastVisitedAtById: {
          [`${localEnvironmentId}:${currentOlder.id}`]: "2026-03-09T10:11:00.000Z",
          [`${localEnvironmentId}:${currentLastOpen.id}`]: "2026-03-09T10:30:00.000Z",
          [`${localEnvironmentId}:${otherProjectRecent.id}`]: "2026-03-09T10:40:00.000Z",
        },
        scope: {
          environmentId: localEnvironmentId,
          projectId: ProjectId.make("project-current"),
        },
      }),
    ).toEqual({
      environmentId: localEnvironmentId,
      threadId: currentLastOpen.id,
    });
  });

  it("falls back to the newest current-project thread when no visit state exists", () => {
    const older = makeSidebarThread({
      id: ThreadId.make("thread-older"),
      projectId: ProjectId.make("project-current"),
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const newer = makeSidebarThread({
      id: ThreadId.make("thread-newer"),
      projectId: ProjectId.make("project-current"),
      updatedAt: "2026-03-09T11:00:00.000Z",
    });

    expect(
      resolveVscodeInitialThreadRef({
        threads: [older, newer],
        threadLastVisitedAtById: {},
        scope: {
          environmentId: localEnvironmentId,
          projectId: ProjectId.make("project-current"),
        },
      }),
    ).toEqual({
      environmentId: localEnvironmentId,
      threadId: newer.id,
    });
  });

  it("prefers the active VS Code project within visible multi-root candidates", () => {
    const activeOlder = makeSidebarThread({
      id: ThreadId.make("thread-active-older"),
      projectId: ProjectId.make("project-active"),
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const inactiveNewer = makeSidebarThread({
      id: ThreadId.make("thread-inactive-newer"),
      projectId: ProjectId.make("project-inactive"),
      updatedAt: "2026-03-09T12:00:00.000Z",
    });

    expect(
      resolveVscodeInitialThreadRef({
        threads: [inactiveNewer, activeOlder],
        threadLastVisitedAtById: {
          [`${localEnvironmentId}:${inactiveNewer.id}`]: "2026-03-09T13:00:00.000Z",
        },
        scope: {
          environmentId: localEnvironmentId,
          projectIds: [ProjectId.make("project-active"), ProjectId.make("project-inactive")],
          activeProjectId: ProjectId.make("project-active"),
        },
      }),
    ).toEqual({
      environmentId: localEnvironmentId,
      threadId: activeOlder.id,
    });
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

describe("isTrailingDoubleClick", () => {
  it("treats a single click as a normal activation", () => {
    expect(isTrailingDoubleClick(1)).toBe(false);
  });

  it("treats synthetic/keyboard activations (detail 0) as a normal activation", () => {
    expect(isTrailingDoubleClick(0)).toBe(false);
  });

  it("ignores the second click of a double-click so it does not navigate", () => {
    expect(isTrailingDoubleClick(2)).toBe(true);
  });

  it("ignores further clicks of a triple-click", () => {
    expect(isTrailingDoubleClick(3)).toBe(true);
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
          startFromOrigin: true,
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
          startFromOrigin: true,
        },
      }),
    ).toEqual({
      branch: "feature/new-draft",
      worktreePath: "/repo/worktree",
      envMode: "worktree",
      startFromOrigin: true,
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
        workspaceRoot: "/work/alpha",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-beta"),
        workspaceRoot: "/work/beta",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-gamma"),
        workspaceRoot: "/work/gamma",
      },
    ];
    const ordered = orderItemsByPreferredIds({
      items: projects,
      preferredIds: [getProjectOrderKey(projects[2]!), getProjectOrderKey(projects[0]!)],
      getId: getProjectOrderKey,
    });

    expect(ordered.map((project) => project.workspaceRoot)).toEqual([
      "/work/gamma",
      "/work/alpha",
      "/work/beta",
    ]);
  });

  it("resolves legacy preference aliases without materializing project state", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: "physical-a", cwd: "/work/a" },
        { id: "physical-b", cwd: "/work/b" },
        { id: "physical-c", cwd: "/work/c" },
      ],
      preferredIds: ["legacy:/work/c", "legacy:/work/a"],
      getId: (project) => project.id,
      getPreferenceIds: (project) => [project.id, `legacy:${project.cwd}`],
    });

    expect(ordered.map((project) => project.id)).toEqual([
      "physical-c",
      "physical-a",
      "physical-b",
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

describe("isRootSidebarThread", () => {
  it("keeps root threads and hides subagent child threads from root sidebar lists", () => {
    expect(isRootSidebarThread(makeThread())).toBe(true);
    expect(
      isRootSidebarThread(
        makeThread({
          id: ThreadId.make("thread-subagent"),
          parentRelation: {
            kind: "subagent",
            rootThreadId: ThreadId.make("thread-root"),
            parentThreadId: ThreadId.make("thread-root"),
            parentTurnId: TurnId.make("turn-root"),
            parentItemId: ProviderItemId.make("item-root"),
            parentActivitySequence: 0,
            providerThreadId: "provider-thread-subagent",
            titleSeed: "Inspect auth flow",
            depth: 1,
            startedAt: "2026-03-09T10:00:00.000Z",
            completedAt: null,
            status: "running",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("isContextualSubagentSidebarThread", () => {
  it("shows subagents only when they are active or running", () => {
    const child = makeThread({
      id: ThreadId.make("thread-subagent"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: ThreadId.make("thread-root"),
        parentThreadId: ThreadId.make("thread-root"),
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-root"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-subagent",
        titleSeed: "Inspect auth flow",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:02:00.000Z",
        status: "completed",
      },
    });

    expect(isContextualSubagentSidebarThread(child, null)).toBe(false);
    expect(isContextualSubagentSidebarThread(child, child.id)).toBe(true);
    expect(
      isContextualSubagentSidebarThread(
        {
          ...child,
          parentRelation: {
            ...child.parentRelation!,
            status: "running",
          },
        },
        null,
      ),
    ).toBe(true);
  });
});

describe("buildSidebarThreadRows", () => {
  it("nests active and running subagents under their parent without showing completed inactive ones", () => {
    const root = makeThread({ id: ThreadId.make("thread-root") });
    const activeChild = makeThread({
      id: ThreadId.make("thread-active-child"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-active"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-active-child",
        titleSeed: "Inspect auth flow",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:02:00.000Z",
        status: "completed",
      },
    });
    const runningChild = makeThread({
      id: ThreadId.make("thread-running-child"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-running"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-running-child",
        titleSeed: "Check tests",
        depth: 1,
        startedAt: "2026-03-09T10:01:00.000Z",
        completedAt: null,
        status: "running",
      },
    });
    const inactiveChild = makeThread({
      id: ThreadId.make("thread-inactive-child"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-inactive"),
        parentActivitySequence: 2,
        providerThreadId: "provider-thread-inactive-child",
        titleSeed: "Summarize docs",
        depth: 1,
        startedAt: "2026-03-09T10:02:00.000Z",
        completedAt: "2026-03-09T10:03:00.000Z",
        status: "completed",
      },
    });

    expect(
      buildSidebarThreadRows([root, activeChild, runningChild, inactiveChild], activeChild.id),
    ).toEqual([
      { thread: root, indentLevel: 0 },
      { thread: activeChild, indentLevel: 1 },
      { thread: runningChild, indentLevel: 1 },
    ]);
  });

  it("keeps terminal active subagent ancestors visible in nested order", () => {
    const root = makeThread({ id: ThreadId.make("thread-root") });
    const terminalParent = makeThread({
      id: ThreadId.make("thread-terminal-parent"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-parent"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-terminal-parent",
        titleSeed: "Inspect auth flow",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:02:00.000Z",
        status: "completed",
      },
    });
    const activeGrandchild = makeThread({
      id: ThreadId.make("thread-active-grandchild"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: terminalParent.id,
        parentTurnId: TurnId.make("turn-child"),
        parentItemId: ProviderItemId.make("item-grandchild"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-active-grandchild",
        titleSeed: "Check nested route",
        depth: 2,
        startedAt: "2026-03-09T10:03:00.000Z",
        completedAt: "2026-03-09T10:04:00.000Z",
        status: "completed",
      },
    });

    expect(
      buildSidebarThreadRows([root, terminalParent, activeGrandchild], activeGrandchild.id),
    ).toEqual([
      { thread: root, indentLevel: 0 },
      { thread: terminalParent, indentLevel: 1 },
      { thread: activeGrandchild, indentLevel: 2 },
    ]);
  });

  it("keeps running descendants under hidden terminal ancestors before unrelated roots", () => {
    const root = makeThread({ id: ThreadId.make("thread-root") });
    const unrelatedRoot = makeThread({ id: ThreadId.make("thread-unrelated-root") });
    const terminalParent = makeThread({
      id: ThreadId.make("thread-terminal-parent"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: root.id,
        parentTurnId: TurnId.make("turn-root"),
        parentItemId: ProviderItemId.make("item-parent"),
        parentActivitySequence: 0,
        providerThreadId: "provider-thread-terminal-parent",
        titleSeed: "Inspect auth flow",
        depth: 1,
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:02:00.000Z",
        status: "completed",
      },
    });
    const runningGrandchild = makeThread({
      id: ThreadId.make("thread-running-grandchild"),
      parentRelation: {
        kind: "subagent",
        rootThreadId: root.id,
        parentThreadId: terminalParent.id,
        parentTurnId: TurnId.make("turn-child"),
        parentItemId: ProviderItemId.make("item-grandchild"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-running-grandchild",
        titleSeed: "Check nested route",
        depth: 2,
        startedAt: "2026-03-09T10:03:00.000Z",
        completedAt: null,
        status: "running",
      },
    });

    expect(
      buildSidebarThreadRows([root, unrelatedRoot, terminalParent, runningGrandchild], null),
    ).toEqual([
      { thread: root, indentLevel: 0 },
      { thread: runningGrandchild, indentLevel: 2 },
      { thread: unrelatedRoot, indentLevel: 0 },
    ]);
  });
});

describe("resolveThreadRowIndentStyle", () => {
  it("increases row indentation for each visible subagent generation", () => {
    expect(resolveThreadRowIndentStyle({ indentLevel: 0, flattenHierarchyChrome: false })).toBe(
      undefined,
    );
    expect(resolveThreadRowIndentStyle({ indentLevel: 1, flattenHierarchyChrome: false })).toEqual({
      paddingLeft: "1.25rem",
    });
    expect(resolveThreadRowIndentStyle({ indentLevel: 2, flattenHierarchyChrome: false })).toEqual({
      paddingLeft: "2.125rem",
    });
  });

  it("suppresses hierarchy indentation when chrome is flattened", () => {
    expect(resolveThreadRowIndentStyle({ indentLevel: 2, flattenHierarchyChrome: true })).toBe(
      undefined,
    );
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
      threadId: ThreadId.make("thread-1"),
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeTurnId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
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
            activeTurnId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toBeNull();
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
            activeTurnId: null,
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

describe("resolveThreadListClassName", () => {
  it("keeps the project grouping rail for normal multi-project sidebars", () => {
    const className = resolveThreadListClassName({ hideThreadGroupRail: false });

    expect(className).not.toContain("border-l-0");
  });

  it("removes the project grouping rail for VS Code single-project sidebars", () => {
    const className = resolveThreadListClassName({ hideThreadGroupRail: true });

    expect(className).toContain("border-l-0");
    expect(className).toContain("mx-0");
    expect(className).toContain("px-0");
    expect(className).toContain("sm:mx-0");
    expect(className).toContain("sm:px-0");
  });
});

describe("resolveSidebarOptionsMenuVisibility", () => {
  it("keeps sidebar options visible when project chrome is shown", () => {
    expect(resolveSidebarOptionsMenuVisibility({ hideProjectChrome: false })).toEqual({
      showButton: true,
      showProjectOptions: true,
      showThreadOptions: true,
    });
  });

  it("keeps sidebar options visible with only thread options when project chrome is hidden", () => {
    expect(resolveSidebarOptionsMenuVisibility({ hideProjectChrome: true })).toEqual({
      showButton: true,
      showProjectOptions: false,
      showThreadOptions: true,
    });
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
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
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
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
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
      makeProject({ id: ProjectId.make("project-1"), title: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), title: "Newer project" }),
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
            turnId: null,
            createdAt: "2026-03-09T10:01:00.000Z",
            updatedAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
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
            turnId: null,
            createdAt: "2026-03-09T10:05:00.000Z",
            updatedAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
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
          title: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Newer project",
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
          title: "Beta",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Alpha",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
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
      makeProject({ id: ProjectId.make("project-2"), title: "Second" }),
      makeProject({ id: ProjectId.make("project-1"), title: "First" }),
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
          title: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Archived-only project",
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
