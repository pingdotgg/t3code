import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
  canPinWorkInboxThread,
  createThreadJumpHintVisibilityController,
  filterSidebarV2VisibleThreads,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarThreadIds,
  resolveAdjacentThreadId,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  getSidebarForkParentThreadId,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  isSidebarLifecycleThread,
  isSidebarSubagentThread,
  isThreadVisibleInSidebarWorkspace,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveProjectStatusIndicator,
  resolveSidebarStageBadgeLabel,
  resolveThreadRowClassName,
  resolveSidebarV2Status,
  resolveThreadStatusPill,
  resolveWorkingStartedAt,
  resolveWorkspaceSwitchNavigation,
  sidebarProjectKey,
  sidebarProviderInstanceKey,
  formatWorkingDurationLabel,
  shouldNavigateAfterProjectRemoval,
  shouldClearThreadSelectionOnMouseDown,
  sortLogicalProjectsForSidebar,
  sortSidebarV2ProjectGroups,
  sortSettledThreadsForSidebarV2,
  sortThreadsForSidebarV2,
  workInboxActiveSection,
  sortScopedProjectsForSidebar,
  sortProjectsForSidebar,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("Hermes Work inbox semantics", () => {
  const hermesEnvironmentId = EnvironmentId.make("environment-hermes");
  const hermesInstanceId = ProviderInstanceId.make("hermes-primary");
  const driverKinds = new Map([
    [`${hermesEnvironmentId}\u0000${hermesInstanceId}`, ProviderDriverKind.make("hermes")] as const,
  ]);

  it("projects durable main and needs-you roles into structured sections", () => {
    expect(workInboxActiveSection(makeThreadFixture({ workInboxRole: "main" }))).toBe("main");
    expect(workInboxActiveSection(makeThreadFixture({ hasPendingApprovals: true }))).toBe(
      "needs-you",
    );
    expect(workInboxActiveSection(makeThreadFixture({ hasPendingUserInput: true }))).toBe(
      "needs-you",
    );
    expect(workInboxActiveSection(makeThreadFixture())).toBe("active");
  });

  it("only permits unsettled ordinary Hermes sidebar threads to be pinned", () => {
    const ordinaryHermes = makeThreadFixture({
      environmentId: hermesEnvironmentId,
      providerInstanceId: hermesInstanceId,
    });
    const canPin = (overrides: Partial<Parameters<typeof canPinWorkInboxThread>[0]>) =>
      canPinWorkInboxThread({
        thread: ordinaryHermes,
        providerDriverKindByInstance: driverKinds,
        isSnoozed: false,
        isSettled: false,
        ...overrides,
      });

    expect(canPin({})).toBe(true);
    expect(canPin({ isSettled: true })).toBe(false);
    expect(canPin({ isSnoozed: true })).toBe(false);
    expect(canPin({ thread: { ...ordinaryHermes, workInboxRole: "main" } })).toBe(false);
    expect(
      canPin({
        thread: {
          ...ordinaryHermes,
          lineage: {
            ...ordinaryHermes.lineage,
            relationshipToParent: "subagent",
          },
        },
      }),
    ).toBe(false);
    expect(
      canPin({
        thread: {
          ...ordinaryHermes,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      }),
    ).toBe(false);
  });
});

describe("shouldNavigateAfterProjectRemoval", () => {
  const projectThreads = [{ environmentId: "environment-local", id: "thread-1" }];

  it("navigates away from a draft route owned by the removed project", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: { kind: "draft", draftId: "draft-1" as never },
        projectThreads,
        projectDraftId: "draft-1",
      }),
    ).toBe(true);
  });

  it("does not navigate away from a different draft route", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: { kind: "draft", draftId: "draft-2" as never },
        projectThreads,
        projectDraftId: "draft-1",
      }),
    ).toBe(false);
  });

  it("navigates away from a server thread owned by the removed project", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: {
          kind: "server",
          threadRef: {
            environmentId: EnvironmentId.make("environment-local"),
            threadId: ThreadId.make("thread-1"),
          },
        },
        projectThreads,
        projectDraftId: null,
      }),
    ).toBe(true);
  });

  it("does not navigate from an unrelated route", () => {
    expect(
      shouldNavigateAfterProjectRemoval({
        routeTarget: null,
        projectThreads,
        projectDraftId: null,
      }),
    ).toBe(false);
  });
});

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("records every entry after full success", async () => {
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive: async (_entry, onArchived) => {
        onArchived();
        return success;
      },
    });

    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [],
    });
  });

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });
});

describe("buildMultiSelectThreadContextMenuItems", () => {
  it("offers bulk archive with the selected count", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 3, hasRunningThread: false }),
    ).toContainEqual({ id: "archive", label: "Archive (3)", disabled: false });
  });

  it("disables bulk archive when a selected thread is running", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 2, hasRunningThread: true }),
    ).toContainEqual({ id: "archive", label: "Archive (2)", disabled: true });
  });
});

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

describe("sidebar thread lineage helpers", () => {
  it("keeps only top-level, unarchived threads in the Sidebar V2 project scope", () => {
    const parentId = ThreadId.make("thread-parent");
    const projectId = ProjectId.make("project-visible");
    const environmentId = EnvironmentId.make("environment-visible");
    const root = makeThreadFixture({
      id: parentId,
      environmentId,
      projectId,
    });
    const subagent = makeThreadFixture({
      id: ThreadId.make("thread-subagent"),
      environmentId,
      projectId,
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "subagent",
      },
    });
    const fork = makeThreadFixture({
      id: ThreadId.make("thread-fork"),
      environmentId,
      projectId,
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "fork",
      },
    });
    const archived = makeThreadFixture({
      id: ThreadId.make("thread-archived"),
      environmentId,
      projectId,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const otherProject = makeThreadFixture({
      id: ThreadId.make("thread-other-project"),
      environmentId,
      projectId: ProjectId.make("project-other"),
    });

    expect(
      filterSidebarV2VisibleThreads(
        [root, subagent, fork, archived, otherProject],
        new Set([`${environmentId}:${projectId}`]),
      ).map((thread) => thread.id),
    ).toEqual([parentId, fork.id]);
  });

  it("identifies subagent threads so the sidebar can hide them", () => {
    const parentId = ThreadId.make("thread-parent");
    const subagent = makeThreadFixture({
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "subagent",
      },
    });

    expect(isSidebarSubagentThread(subagent)).toBe(true);
    expect(isSidebarSubagentThread(makeThreadFixture())).toBe(false);
  });

  it("keeps subagent threads out of every sidebar lifecycle bucket", () => {
    const parentId = ThreadId.make("thread-parent");
    const subagentLineage = {
      rootThreadId: parentId,
      parentThreadId: parentId,
      relationshipToParent: "subagent" as const,
    };

    const activeSubagent = makeThreadFixture({ lineage: subagentLineage });
    const snoozedSubagent = makeThreadFixture({
      lineage: subagentLineage,
      snoozedUntil: "2026-03-10T12:00:00.000Z",
    });
    const settledSubagent = makeThreadFixture({
      lineage: subagentLineage,
      settledOverride: "settled",
      settledAt: "2026-03-09T12:00:00.000Z",
    });

    expect(
      [activeSubagent, snoozedSubagent, settledSubagent].map(isSidebarLifecycleThread),
    ).toEqual([false, false, false]);
    expect(isSidebarLifecycleThread(makeThreadFixture())).toBe(true);
    expect(
      isSidebarLifecycleThread(makeThreadFixture({ archivedAt: "2026-03-09T12:00:00.000Z" })),
    ).toBe(false);
  });

  it("filters lifecycle threads by workspace using provider driver metadata", () => {
    const environmentId = EnvironmentId.make("environment-workspaces");
    const codexInstanceId = ProviderInstanceId.make("codex_personal");
    const defaultHermesInstanceId = ProviderInstanceId.make("hermes");
    const customHermesInstanceId = ProviderInstanceId.make("research_assistant");
    const parentId = ThreadId.make("thread-parent");
    const providerDriverKindByInstance = new Map([
      [
        sidebarProviderInstanceKey(environmentId, codexInstanceId),
        ProviderDriverKind.make("codex"),
      ],
      [
        sidebarProviderInstanceKey(environmentId, defaultHermesInstanceId),
        ProviderDriverKind.make("hermes"),
      ],
      [
        sidebarProviderInstanceKey(environmentId, customHermesInstanceId),
        ProviderDriverKind.make("hermes"),
      ],
    ]);
    const ordinaryThread = makeThreadFixture({
      environmentId,
      id: ThreadId.make("thread-code"),
      providerInstanceId: codexInstanceId,
    });
    const hermesThread = makeThreadFixture({
      environmentId,
      id: ThreadId.make("thread-hermes"),
      providerInstanceId: defaultHermesInstanceId,
    });
    const customHermesThread = makeThreadFixture({
      environmentId,
      id: ThreadId.make("thread-custom-hermes"),
      providerInstanceId: customHermesInstanceId,
    });
    const subagentThread = makeThreadFixture({
      environmentId,
      id: ThreadId.make("thread-hermes-subagent"),
      providerInstanceId: customHermesInstanceId,
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "subagent",
      },
    });
    const threads = [ordinaryThread, hermesThread, customHermesThread, subagentThread];

    expect(
      threads.filter((thread) =>
        isThreadVisibleInSidebarWorkspace(thread, "code", providerDriverKindByInstance),
      ),
    ).toEqual([ordinaryThread]);
    expect(
      threads.filter((thread) =>
        isThreadVisibleInSidebarWorkspace(thread, "work", providerDriverKindByInstance),
      ),
    ).toEqual([hermesThread, customHermesThread]);
  });

  it("keeps Hermes threads on known Code projects in the code workspace", () => {
    const environmentId = EnvironmentId.make("environment-partition");
    const hermesInstanceId = ProviderInstanceId.make("hermes-main");
    const providerDriverKindByInstance = new Map([
      [
        sidebarProviderInstanceKey(environmentId, hermesInstanceId),
        ProviderDriverKind.make("hermes"),
      ],
    ]);
    const workProjectId = ProjectId.make("project:t3-work");
    const codeProjectId = ProjectId.make("project-code");
    const hermesWorkThread = makeThreadFixture({
      environmentId,
      id: ThreadId.make("thread-hermes-work"),
      providerInstanceId: hermesInstanceId,
      projectId: workProjectId,
    });
    const hermesCodeThread = makeThreadFixture({
      environmentId,
      id: ThreadId.make("thread-hermes-code"),
      providerInstanceId: hermesInstanceId,
      projectId: codeProjectId,
    });
    const codeProjectKeys = new Set([sidebarProjectKey(environmentId, codeProjectId)]);

    expect(
      isThreadVisibleInSidebarWorkspace(
        hermesWorkThread,
        "work",
        providerDriverKindByInstance,
        codeProjectKeys,
      ),
    ).toBe(true);
    expect(
      isThreadVisibleInSidebarWorkspace(
        hermesCodeThread,
        "code",
        providerDriverKindByInstance,
        codeProjectKeys,
      ),
    ).toBe(true);
    expect(
      isThreadVisibleInSidebarWorkspace(
        hermesCodeThread,
        "work",
        providerDriverKindByInstance,
        codeProjectKeys,
      ),
    ).toBe(false);
    // While projects/configs are still loading the set is absent, so Hermes
    // threads conservatively stay in the work workspace.
    expect(
      isThreadVisibleInSidebarWorkspace(hermesCodeThread, "work", providerDriverKindByInstance),
    ).toBe(true);
  });

  it("uses the literal Hermes instance only as a missing-metadata fallback", () => {
    const environmentId = EnvironmentId.make("environment-history");
    const historicalHermesThread = makeThreadFixture({
      environmentId,
      providerInstanceId: ProviderInstanceId.make("hermes"),
    });
    const misleadingCustomThread = makeThreadFixture({
      environmentId,
      providerInstanceId: ProviderInstanceId.make("hermes_personal"),
    });

    expect(isThreadVisibleInSidebarWorkspace(historicalHermesThread, "work", new Map())).toBe(true);
    expect(isThreadVisibleInSidebarWorkspace(misleadingCustomThread, "work", new Map())).toBe(
      false,
    );
    expect(isThreadVisibleInSidebarWorkspace(historicalHermesThread, "code", new Map())).toBe(
      false,
    );
    expect(isThreadVisibleInSidebarWorkspace(misleadingCustomThread, "code", new Map())).toBe(true);
  });

  it("scopes Hermes membership to the thread's own environment", () => {
    const homeEnvironmentId = EnvironmentId.make("environment-home");
    const otherEnvironmentId = EnvironmentId.make("environment-other");
    const sharedInstanceId = ProviderInstanceId.make("assistant");
    const providerDriverKindByInstance = new Map([
      [
        sidebarProviderInstanceKey(homeEnvironmentId, sharedInstanceId),
        ProviderDriverKind.make("hermes"),
      ],
      [
        sidebarProviderInstanceKey(otherEnvironmentId, sharedInstanceId),
        ProviderDriverKind.make("codex"),
      ],
    ]);
    const homeThread = makeThreadFixture({
      environmentId: homeEnvironmentId,
      providerInstanceId: sharedInstanceId,
    });
    const otherThread = makeThreadFixture({
      environmentId: otherEnvironmentId,
      providerInstanceId: sharedInstanceId,
    });

    expect(
      isThreadVisibleInSidebarWorkspace(homeThread, "work", providerDriverKindByInstance),
    ).toBe(true);
    expect(
      isThreadVisibleInSidebarWorkspace(homeThread, "code", providerDriverKindByInstance),
    ).toBe(false);
    expect(
      isThreadVisibleInSidebarWorkspace(otherThread, "work", providerDriverKindByInstance),
    ).toBe(false);
    expect(
      isThreadVisibleInSidebarWorkspace(otherThread, "code", providerDriverKindByInstance),
    ).toBe(true);
  });

  it("resolves the parent thread for fork sidebar affordances", () => {
    const parentId = ThreadId.make("thread-parent");
    const fallbackParentId = ThreadId.make("thread-fallback-parent");
    const runFork = makeThreadFixture({
      forkedFrom: { type: "run", threadId: parentId, runId: "run-1" as never },
      lineage: {
        rootThreadId: parentId,
        parentThreadId: fallbackParentId,
        relationshipToParent: "fork",
      },
    });
    const lineageFork = makeThreadFixture({
      lineage: {
        rootThreadId: parentId,
        parentThreadId: fallbackParentId,
        relationshipToParent: "fork",
      },
    });

    expect(getSidebarForkParentThreadId(runFork)).toBe(parentId);
    expect(getSidebarForkParentThreadId(lineageFork)).toBe(fallbackParentId);
    expect(getSidebarForkParentThreadId(makeThreadFixture())).toBeNull();
  });
});

describe("resolveWorkspaceSwitchNavigation", () => {
  const environmentId = EnvironmentId.make("environment-switch");
  const hermesInstanceId = ProviderInstanceId.make("hermes-main");
  const codexInstanceId = ProviderInstanceId.make("codex-main");
  const providerDriverKindByInstance = new Map([
    [
      sidebarProviderInstanceKey(environmentId, hermesInstanceId),
      ProviderDriverKind.make("hermes"),
    ],
    [sidebarProviderInstanceKey(environmentId, codexInstanceId), ProviderDriverKind.make("codex")],
  ]);
  const codeThread = {
    ...makeThreadFixture({ environmentId, providerInstanceId: codexInstanceId }),
    threadKey: "code-thread",
  };
  const workThread = {
    ...makeThreadFixture({ environmentId, providerInstanceId: hermesInstanceId }),
    threadKey: "work-thread",
  };
  const threads = [codeThread, workThread];

  it("navigates to the remembered thread when it is still visible in the target workspace", () => {
    expect(
      resolveWorkspaceSwitchNavigation({
        nextWorkspace: "work",
        rememberedThreadKey: "work-thread",
        routeThreadKey: "code-thread",
        threads,
        providerDriverKindByInstance,
      }),
    ).toEqual({ kind: "remembered-thread", threadKey: "work-thread" });
  });

  it("opens the target-mode composer when the open thread belongs to the other workspace", () => {
    expect(
      resolveWorkspaceSwitchNavigation({
        nextWorkspace: "work",
        rememberedThreadKey: undefined,
        routeThreadKey: "code-thread",
        threads,
        providerDriverKindByInstance,
      }),
    ).toEqual({ kind: "new-chat" });
    expect(
      resolveWorkspaceSwitchNavigation({
        nextWorkspace: "code",
        rememberedThreadKey: undefined,
        routeThreadKey: "work-thread",
        threads,
        providerDriverKindByInstance,
      }),
    ).toEqual({ kind: "new-chat" });
  });

  it("falls back to the composer when the remembered thread is no longer visible", () => {
    expect(
      resolveWorkspaceSwitchNavigation({
        nextWorkspace: "work",
        rememberedThreadKey: "archived-work-thread",
        routeThreadKey: "code-thread",
        threads,
        providerDriverKindByInstance,
      }),
    ).toEqual({ kind: "new-chat" });
  });

  it("stays put on workspace-neutral routes and threads already valid in the target workspace", () => {
    expect(
      resolveWorkspaceSwitchNavigation({
        nextWorkspace: "work",
        rememberedThreadKey: undefined,
        routeThreadKey: null,
        threads,
        providerDriverKindByInstance,
      }),
    ).toEqual({ kind: "stay" });
    expect(
      resolveWorkspaceSwitchNavigation({
        nextWorkspace: "work",
        rememberedThreadKey: undefined,
        routeThreadKey: "work-thread",
        threads,
        providerDriverKindByInstance,
      }),
    ).toEqual({ kind: "stay" });
  });

  it("routes to the target composer when the open draft belongs to the other workspace", () => {
    expect(
      resolveWorkspaceSwitchNavigation({
        nextWorkspace: "code",
        rememberedThreadKey: undefined,
        routeThreadKey: null,
        routeDraftWorkspace: "work",
        threads,
        providerDriverKindByInstance,
      }),
    ).toEqual({ kind: "new-chat" });
    expect(
      resolveWorkspaceSwitchNavigation({
        nextWorkspace: "work",
        rememberedThreadKey: undefined,
        routeThreadKey: null,
        routeDraftWorkspace: "code",
        threads,
        providerDriverKindByInstance,
      }),
    ).toEqual({ kind: "new-chat" });
    expect(
      resolveWorkspaceSwitchNavigation({
        nextWorkspace: "code",
        rememberedThreadKey: undefined,
        routeThreadKey: null,
        routeDraftWorkspace: "code",
        threads,
        providerDriverKindByInstance,
      }),
    ).toEqual({ kind: "stay" });
  });
});

function makeLatestRun(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): NonNullable<Thread["latestRun"]> {
  return {
    runId: "turn-1" as never,
    status: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt !== undefined ? overrides.startedAt : "2026-03-09T10:00:00.000Z",
    completedAt:
      overrides?.completedAt !== undefined ? overrides.completedAt : "2026-03-09T10:05:00.000Z",
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
        latestRun: makeLatestRun(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        runtime: null,
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
        latestRun: makeLatestRun(),
        lastVisitedAt: undefined,
        runtime: null,
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

describe("resolveSidebarV2Status", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

  it("prioritizes approval over a running runtime", () => {
    expect(resolveSidebarV2Status({ ...idle, hasPendingApprovals: true, runtime })).toBe(
      "approval",
    );
  });

  it("prioritizes awaiting input over a running runtime, below approval", () => {
    expect(resolveSidebarV2Status({ ...idle, hasPendingUserInput: true, runtime })).toBe("input");
    expect(
      resolveSidebarV2Status({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        runtime,
      }),
    ).toBe("approval");
  });

  it("reports working for running and starting runtimes", () => {
    expect(resolveSidebarV2Status({ ...idle, runtime })).toBe("working");
    expect(
      resolveSidebarV2Status({
        ...idle,
        runtime: { ...runtime, status: "starting" as const },
      }),
    ).toBe("working");
  });

  it("reports failed only while the latest run failed", () => {
    expect(
      resolveSidebarV2Status({
        ...idle,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveSidebarV2Status({
        ...idle,
        runtime: { ...runtime, status: "completed" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarV2Status({
        ...idle,
        runtime: { ...runtime, status: "idle" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
  });

  it("defaults to ready with no runtime", () => {
    expect(resolveSidebarV2Status(idle)).toBe("ready");
  });
});

describe("sortThreadsForSidebarV2", () => {
  const sortable = (input: { id: string; createdAt: string }) => ({
    id: input.id,
    createdAt: input.createdAt,
  });

  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForSidebarV2([
      sortable({ id: "oldest", createdAt: "2026-03-09T08:00:00.000Z" }),
      sortable({ id: "newest", createdAt: "2026-03-09T12:00:00.000Z" }),
      sortable({ id: "middle", createdAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks creation-time ties by id so the order is stable", () => {
    const sorted = sortThreadsForSidebarV2([
      sortable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z" }),
      sortable({ id: "a", createdAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("keeps pinned unsettled threads first while preserving creation order within each group", () => {
    const pinnedIds = new Set(["pinned-old", "pinned-new"]);
    const sorted = sortThreadsForSidebarV2(
      [
        sortable({ id: "regular-new", createdAt: "2026-03-09T13:00:00.000Z" }),
        sortable({ id: "pinned-old", createdAt: "2026-03-09T08:00:00.000Z" }),
        sortable({ id: "regular-old", createdAt: "2026-03-09T09:00:00.000Z" }),
        sortable({ id: "pinned-new", createdAt: "2026-03-09T12:00:00.000Z" }),
      ],
      (thread) => pinnedIds.has(thread.id),
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      "pinned-new",
      "pinned-old",
      "regular-new",
      "regular-old",
    ]);
  });
});

describe("sortSettledThreadsForSidebarV2", () => {
  const settled = (input: {
    id: string;
    settledAt?: string | null;
    latestUserMessageAt?: string | null;
    latestRun?: Thread["latestRun"];
    updatedAt?: string;
  }) => ({
    id: input.id,
    settledAt: input.settledAt ?? null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    latestRun: input.latestRun ?? null,
    updatedAt: input.updatedAt ?? "2026-03-09T09:00:00.000Z",
  });

  it("orders by settle time, most recently settled first", () => {
    const sorted = sortSettledThreadsForSidebarV2([
      settled({
        id: "settled-first",
        settledAt: "2026-03-09T10:00:00.000Z",
        // Created/active later than the other thread: settle time must win.
        latestUserMessageAt: "2026-03-09T09:59:00.000Z",
      }),
      settled({
        id: "settled-last",
        settledAt: "2026-03-09T12:00:00.000Z",
        latestUserMessageAt: "2026-03-09T08:00:00.000Z",
      }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["settled-last", "settled-first"]);
  });

  it("falls back to last activity for auto-settled threads without a settledAt stamp", () => {
    const sorted = sortSettledThreadsForSidebarV2([
      settled({ id: "auto-old", latestUserMessageAt: "2026-03-09T08:00:00.000Z" }),
      settled({ id: "explicit", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "auto-recent", latestUserMessageAt: "2026-03-09T11:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["auto-recent", "explicit", "auto-old"]);
  });

  it("counts a turn completion as activity for auto-settled threads", () => {
    // The message came in before the other thread's, but its turn finished
    // after: completion time is the real "work ended" moment.
    const sorted = sortSettledThreadsForSidebarV2([
      settled({ id: "message-only", latestUserMessageAt: "2026-03-09T10:04:00.000Z" }),
      settled({
        id: "completed-later",
        latestUserMessageAt: "2026-03-09T10:00:00.000Z",
        latestRun: makeLatestRun({ completedAt: "2026-03-09T10:30:00.000Z" }),
      }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["completed-later", "message-only"]);
  });

  it("breaks timestamp ties by id so the order is stable", () => {
    const sorted = sortSettledThreadsForSidebarV2([
      settled({ id: "b", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "a", settledAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("resolveWorkingStartedAt", () => {
  const runtime = {
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    activeRunId: RunId.make("run-1"),
    lastError: null,
    updatedAt: "2026-03-09T10:02:00.000Z",
  };

  it("uses the running run's start time", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun({ completedAt: null }),
        runtime,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("uses the request time while a run awaits adoption", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun({ startedAt: null, completedAt: null }),
        runtime,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("falls back to the runtime transition when the latest run already completed", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun(),
        runtime,
      }),
    ).toBe("2026-03-09T10:02:00.000Z");
  });

  it("skips a malformed startedAt instead of returning it", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun({ startedAt: "not-a-date", completedAt: null }),
        runtime,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("returns null with neither a running run nor a runtime", () => {
    expect(resolveWorkingStartedAt({ latestRun: null, runtime: null })).toBeNull();
  });
});

describe("formatWorkingDurationLabel", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatWorkingDurationLabel(0)).toBe("0s");
    expect(formatWorkingDurationLabel(42_000)).toBe("42s");
    expect(formatWorkingDurationLabel(5 * 60_000)).toBe("5m");
    expect(formatWorkingDurationLabel(90 * 60_000)).toBe("1h 30m");
  });

  it("clamps negative and non-finite elapsed values to zero", () => {
    expect(formatWorkingDurationLabel(-5_000)).toBe("0s");
    expect(formatWorkingDurationLabel(Number.NaN)).toBe("0s");
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestRun: null,
    lastVisitedAt: undefined,
    runtime: {
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeRunId: "turn-1" as never,
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
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
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
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
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
          latestRun: makeLatestRun(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the active sidebar surface when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-sidebar-row-active");
    expect(className).toContain("text-sidebar-foreground");
    expect(className).not.toContain("bg-primary");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-sidebar-row-selected");
    expect(className).toContain("hover:bg-sidebar-row-active");
    expect(className).not.toContain("bg-primary");
  });

  it("uses the active sidebar surface for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-sidebar-row-active");
    expect(className).toContain("hover:bg-sidebar-row-active");
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

function makeThread(overrides: ThreadFixtureOverrides = {}): Thread {
  return makeThreadFixture({
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
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
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
            runId: null,
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
            runId: null,
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

describe("sortScopedProjectsForSidebar", () => {
  it("keeps identical project ids in different environments separate", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const sharedProjectId = ProjectId.make("shared-project");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: sharedProjectId,
        title: "Local project",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: sharedProjectId,
        title: "Remote project",
      }),
    ];
    const threads = [
      makeThread({
        environmentId: localEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        environmentId: remoteEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual(["Remote project", "Local project"]);
  });

  it("does not use archived threads as project activity", () => {
    const projects = [
      makeProject({
        id: ProjectId.make("project-visible"),
        title: "Visible project",
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeProject({
        id: ProjectId.make("project-archived"),
        title: "Archived-only project",
        updatedAt: "2026-03-09T10:00:00.000Z",
      }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.make("thread-visible"),
        projectId: ProjectId.make("project-visible"),
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-archived"),
        projectId: ProjectId.make("project-archived"),
        updatedAt: "2026-03-09T10:10:00.000Z",
        archivedAt: "2026-03-09T10:11:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual([
      "Visible project",
      "Archived-only project",
    ]);
  });
});

describe("sortLogicalProjectsForSidebar", () => {
  it("uses saved order only in manual mode and activity order otherwise", () => {
    const olderProjectId = ProjectId.make("project-older");
    const newerProjectId = ProjectId.make("project-newer");
    const projects = [
      {
        ...makeProject({ id: olderProjectId, title: "Older project" }),
        projectKey: "logical-older",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: olderProjectId }],
      },
      {
        ...makeProject({ id: newerProjectId, title: "Newer project" }),
        projectKey: "logical-newer",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: newerProjectId }],
      },
    ];
    const threads = [
      makeThread({
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-newer"),
        projectId: newerProjectId,
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
    ];

    expect(sortLogicalProjectsForSidebar(projects, threads, "manual")).toEqual(projects);
    expect(
      sortLogicalProjectsForSidebar(projects, threads, "updated_at").map(
        (project) => project.projectKey,
      ),
    ).toEqual(["logical-newer", "logical-older"]);
  });
});

describe("sortSidebarV2ProjectGroups", () => {
  it("does not let a hidden subagent thread reorder projects", () => {
    const olderProjectId = ProjectId.make("project-older");
    const newerProjectId = ProjectId.make("project-newer");
    const olderRootThreadId = ThreadId.make("thread-older-root");
    const projects = [
      {
        ...makeProject({ id: olderProjectId, title: "A older project" }),
        projectKey: "logical-older",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: olderProjectId }],
      },
      {
        ...makeProject({ id: newerProjectId, title: "Z newer project" }),
        projectKey: "logical-newer",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: newerProjectId }],
      },
    ];
    const threads = [
      makeThread({
        id: olderRootThreadId,
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-newer-root"),
        projectId: newerProjectId,
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-hidden-subagent"),
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
        lineage: {
          rootThreadId: olderRootThreadId,
          parentThreadId: olderRootThreadId,
          relationshipToParent: "subagent",
        },
      }),
    ];

    expect(
      sortSidebarV2ProjectGroups(projects, threads, "updated_at").map(
        (project) => project.projectKey,
      ),
    ).toEqual(["logical-newer", "logical-older"]);
  });
});
