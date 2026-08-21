import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import {
  buildSessionGridProjectContextMenuItems,
  buildSessionGridProjectPanelEntries,
  buildSessionGridSections,
  isSessionGridMissingChangeRequestError,
  parseSessionGridSearch,
  resolveSessionGridChangeRequestState,
  resolveSessionGridArrowTargetIndex,
  resolveSessionGridDimensions,
  resolveSessionGridLifecycle,
  resolveSessionGridProject,
  sessionGridChangeRequestKey,
  sessionGridCompletionNeedsAttention,
  sessionGridThreadNeedsAttention,
  stabilizeSessionGridProjectKeys,
  stabilizeSessionGridThreadKeys,
} from "./sessionGrid.logic";

const NOW = "2026-08-05T12:00:00.000Z";
const STALE = "2026-07-01T12:00:00.000Z";
const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");
const PROJECT_A = ProjectId.make("project-a");

function makeThread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  const id = overrides.id ?? ThreadId.make("thread-1");
  return {
    environmentId: ENVIRONMENT_A,
    id,
    projectId: PROJECT_A,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: "completed",
      requestedAt: STALE,
      startedAt: STALE,
      completedAt: STALE,
      assistantMessageId: null,
    },
    createdAt: STALE,
    updatedAt: STALE,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    titleRegeneration: null,
    session: null,
    latestUserMessageAt: STALE,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function classify(
  thread: EnvironmentThreadShell,
  overrides: Partial<Parameters<typeof resolveSessionGridLifecycle>[1]> = {},
) {
  return resolveSessionGridLifecycle(thread, {
    preciseNow: NOW,
    settledNow: NOW,
    autoSettleAfterDays: 3,
    autoSettleOnMerge: true,
    supportsSettlement: true,
    supportsSnooze: true,
    changeRequestState: null,
    ...overrides,
  });
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    environmentId: ENVIRONMENT_A,
    id: PROJECT_A,
    title: "Project A",
    workspaceRoot: "/projects/a",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseSessionGridSearch", () => {
  it("accepts one non-empty project key and drops malformed values", () => {
    expect(parseSessionGridSearch({ project: "repository:acme/app", ignored: true })).toEqual({
      project: "repository:acme/app",
    });
    expect(parseSessionGridSearch({ project: "" })).toEqual({});
    expect(parseSessionGridSearch({ project: ["a", "b"] })).toEqual({});
  });
});

describe("resolveSessionGridLifecycle", () => {
  it("excludes archived threads before every other lifecycle state", () => {
    expect(
      classify(
        makeThread({
          archivedAt: NOW,
          pinnedAt: NOW,
          hasPendingApprovals: true,
        }),
      ),
    ).toBe("archived");
  });

  it("lets an effective snooze temporarily outrank a pin", () => {
    expect(
      classify(
        makeThread({
          pinnedAt: STALE,
          snoozedAt: "2026-08-05T10:00:00.000Z",
          snoozedUntil: "2026-08-06T12:00:00.000Z",
        }),
      ),
    ).toBe("snoozed");
  });

  it("keeps a pinned thread active ahead of explicit or automatic settlement", () => {
    expect(
      classify(makeThread({ pinnedAt: NOW, settledOverride: "settled", settledAt: NOW }), {
        changeRequestState: "merged",
      }),
    ).toBe("active");
  });

  it("fails active on servers that do not support settlement", () => {
    expect(
      classify(makeThread({ settledOverride: "settled", settledAt: NOW }), {
        supportsSettlement: false,
      }),
    ).toBe("active");
  });

  it("honors explicit settlement while PR metadata is loading", () => {
    expect(
      classify(makeThread({ settledOverride: "settled", settledAt: NOW }), {
        changeRequestState: "unknown",
      }),
    ).toBe("settled");
  });

  it("keeps inactivity visible until PR metadata resolves", () => {
    const stale = makeThread();
    expect(classify(stale, { changeRequestState: "unknown" })).toBe("active");
    expect(classify(stale, { changeRequestState: null })).toBe("settled");
  });

  it("keeps open PRs active and settles merged or closed PRs", () => {
    const recentAt = "2026-08-05T11:59:00.000Z";
    const recent = makeThread({
      latestUserMessageAt: recentAt,
      latestTurn: {
        turnId: TurnId.make("turn-recent"),
        state: "completed",
        requestedAt: recentAt,
        startedAt: recentAt,
        completedAt: recentAt,
        assistantMessageId: null,
      },
    });
    expect(classify(recent, { changeRequestState: "open" })).toBe("active");
    expect(classify(recent, { changeRequestState: "merged" })).toBe("settled");
    expect(classify(recent, { changeRequestState: "closed" })).toBe("settled");
  });

  it("never hides live or blocked work, even behind a settle signal", () => {
    const baseSession = {
      threadId: ThreadId.make("thread-1"),
      status: "running" as const,
      providerName: "Codex",
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    };
    expect(
      classify(makeThread({ session: baseSession, settledOverride: "settled", settledAt: NOW })),
    ).toBe("active");
    expect(
      classify(
        makeThread({ hasPendingUserInput: true, settledOverride: "settled", settledAt: NOW }),
        { changeRequestState: "merged" },
      ),
    ).toBe("active");
  });

  it("scopes cached PR state to the current branch", () => {
    const threadKey = "environment-a:thread-1";
    expect(sessionGridChangeRequestKey({ threadKey, branch: "feature/a" })).not.toBe(
      sessionGridChangeRequestKey({ threadKey, branch: "feature/b" }),
    );
  });

  it("distinguishes a resolved no-PR result from a missing branch result", () => {
    const key = sessionGridChangeRequestKey({
      threadKey: "environment-a:thread-1",
      branch: "feature/a",
    });
    const resolved = new Map([[key, null]]);

    expect(resolveSessionGridChangeRequestState(resolved, key, "feature/a")).toBeNull();
    expect(resolveSessionGridChangeRequestState(new Map(), key, "feature/a")).toBe("unknown");
    expect(resolveSessionGridChangeRequestState(new Map(), key, null)).toBeNull();
  });
});

describe("isSessionGridMissingChangeRequestError", () => {
  it("recognizes transported GitHub/Azure and GitLab not-found failures", () => {
    expect(
      isSessionGridMissingChangeRequestError(
        "Source control provider github failed: Pull request not found. Check the PR number.",
      ),
    ).toBe(true);
    expect(
      isSessionGridMissingChangeRequestError(
        "Source control provider gitlab failed: Merge request feature/grid was not found.",
      ),
    ).toBe(true);
    expect(
      isSessionGridMissingChangeRequestError("Source control provider is not authenticated."),
    ).toBe(false);
  });
});

describe("stabilizeSessionGridProjectKeys", () => {
  it("retains existing positions, drops removed projects, and appends new ones", () => {
    expect(stabilizeSessionGridProjectKeys(["a", "b", "c"], ["c", "a", "d"])).toEqual([
      "a",
      "c",
      "d",
    ]);
  });
});

describe("sessionGridCompletionNeedsAttention", () => {
  it("keeps an unvisited completed pane in the attention state", () => {
    expect(
      sessionGridCompletionNeedsAttention({
        completedAt: "2026-08-05T12:00:00.000Z",
        lastVisitedAt: undefined,
      }),
    ).toBe(true);
  });

  it("clears attention once that completion has been viewed", () => {
    expect(
      sessionGridCompletionNeedsAttention({
        completedAt: "2026-08-05T12:00:00.000Z",
        lastVisitedAt: "2026-08-05T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("returns attention again for a newer completion", () => {
    expect(
      sessionGridCompletionNeedsAttention({
        completedAt: "2026-08-05T12:00:01.000Z",
        lastVisitedAt: "2026-08-05T12:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("ignores absent or invalid completion timestamps", () => {
    expect(
      sessionGridCompletionNeedsAttention({ completedAt: null, lastVisitedAt: undefined }),
    ).toBe(false);
    expect(
      sessionGridCompletionNeedsAttention({
        completedAt: "not-a-date",
        lastVisitedAt: undefined,
      }),
    ).toBe(false);
  });
});

describe("sessionGridThreadNeedsAttention", () => {
  it("counts blocked, failed, and unvisited completed work but not running work", () => {
    expect(
      sessionGridThreadNeedsAttention({
        thread: makeThread({ hasPendingUserInput: true }),
        lastVisitedAt: NOW,
      }),
    ).toBe(true);
    expect(
      sessionGridThreadNeedsAttention({
        thread: makeThread({ latestTurn: { ...makeThread().latestTurn!, state: "error" } }),
        lastVisitedAt: NOW,
      }),
    ).toBe(true);
    expect(
      sessionGridThreadNeedsAttention({
        thread: makeThread(),
        lastVisitedAt: undefined,
      }),
    ).toBe(true);
    expect(
      sessionGridThreadNeedsAttention({
        thread: makeThread({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
        lastVisitedAt: undefined,
      }),
    ).toBe(false);
  });
});

describe("buildSessionGridProjectPanelEntries", () => {
  it("rolls open, attention, snoozed, and settled sessions into their project", () => {
    const project = makeProject();
    const groups = buildSidebarProjectSnapshots({
      projects: [project],
      settings: {
        sidebarProjectGroupingMode: "repository",
        sidebarProjectGroupingOverrides: {},
      },
      primaryEnvironmentId: ENVIRONMENT_A,
      resolveEnvironmentLabel: () => "Local",
    });
    const attention = makeThread({
      id: ThreadId.make("attention"),
      hasPendingApprovals: true,
    });
    const snoozed = makeThread({ id: ThreadId.make("snoozed"), createdAt: NOW });
    const settled = makeThread({
      id: ThreadId.make("settled"),
      settledAt: NOW,
      settledOverride: "settled",
    });
    const key = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;

    const [entry] = buildSessionGridProjectPanelEntries({
      projects: groups,
      threads: [settled, snoozed, attention],
      lifecycleByThreadKey: new Map([
        [key(attention), "active"],
        [key(snoozed), "snoozed"],
        [key(settled), "settled"],
      ]),
      lastVisitedAtByThreadKey: {},
    });

    expect(entry?.openThreads.map((thread) => thread.id)).toEqual([snoozed.id, attention.id]);
    expect(entry?.attentionCount).toBe(1);
    expect(entry?.settledThreads.map((thread) => thread.id)).toEqual([settled.id]);
  });
});

describe("buildSessionGridProjectContextMenuItems", () => {
  it("keeps the common project actions direct for a single project entry", () => {
    const [project] = buildSidebarProjectSnapshots({
      projects: [makeProject()],
      settings: {
        sidebarProjectGroupingMode: "repository",
        sidebarProjectGroupingOverrides: {},
      },
      primaryEnvironmentId: ENVIRONMENT_A,
      resolveEnvironmentLabel: () => "Local",
    });

    const items = buildSessionGridProjectContextMenuItems({
      project: project!,
      settledCount: 2,
      settledExpanded: false,
    });

    expect(items.map((item) => [item.id, item.label])).toEqual([
      ["open-project", "Show project grid"],
      ["new-session", "New session"],
      ["toggle-settled", "Show settled sessions"],
      [`copy-path:${project!.memberProjects[0]!.physicalProjectKey}`, "Copy project path"],
      [`remove:${project!.memberProjects[0]!.physicalProjectKey}`, "Remove project"],
    ]);
    expect(items.at(-1)?.destructive).toBe(true);
  });

  it("targets individual environments or all entries for a grouped project", () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/acme/shared",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:acme/shared.git",
      },
      displayName: "Shared",
    };
    const [project] = buildSidebarProjectSnapshots({
      projects: [
        makeProject({ repositoryIdentity }),
        makeProject({
          environmentId: ENVIRONMENT_B,
          id: ProjectId.make("project-b"),
          workspaceRoot: "/remote/shared",
          repositoryIdentity,
        }),
      ],
      settings: {
        sidebarProjectGroupingMode: "repository",
        sidebarProjectGroupingOverrides: {},
      },
      primaryEnvironmentId: ENVIRONMENT_A,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === ENVIRONMENT_A ? "Local" : "Remote",
    });

    const items = buildSessionGridProjectContextMenuItems({
      project: project!,
      settledCount: 0,
      settledExpanded: false,
    });
    const copyPath = items.find((item) => item.id === "copy-path:menu");
    const remove = items.find((item) => item.id === "remove:menu");

    expect(items.some((item) => item.id === "toggle-settled")).toBe(false);
    expect(copyPath?.children).toHaveLength(2);
    expect(remove?.children?.map((item) => item.id)).toEqual([
      `remove:${project!.memberProjects[0]!.physicalProjectKey}`,
      `remove:${project!.memberProjects[1]!.physicalProjectKey}`,
      "remove-all",
    ]);
  });
});

describe("session grid pane layout", () => {
  it("uses the same near-square dimensions as 2code", () => {
    expect(resolveSessionGridDimensions(0)).toEqual({ columns: 1, rows: 1 });
    expect(resolveSessionGridDimensions(1)).toEqual({ columns: 1, rows: 1 });
    expect(resolveSessionGridDimensions(2)).toEqual({ columns: 2, rows: 1 });
    expect(resolveSessionGridDimensions(3)).toEqual({ columns: 2, rows: 2 });
    expect(resolveSessionGridDimensions(5)).toEqual({ columns: 3, rows: 2 });
    expect(resolveSessionGridDimensions(9)).toEqual({ columns: 3, rows: 3 });
  });

  it("preserves preferred pane positions and appends newly opened sessions", () => {
    expect(stabilizeSessionGridThreadKeys(["b", "a", "gone"], ["a", "b", "new"])).toEqual([
      "b",
      "a",
      "new",
    ]);
  });
});

describe("resolveSessionGridArrowTargetIndex", () => {
  it("moves spatially without wrapping across grid rows", () => {
    expect(
      resolveSessionGridArrowTargetIndex({
        key: "ArrowDown",
        currentIndex: 1,
        columnCount: 3,
        itemCount: 6,
      }),
    ).toBe(4);
    expect(
      resolveSessionGridArrowTargetIndex({
        key: "ArrowRight",
        currentIndex: 2,
        columnCount: 3,
        itemCount: 6,
      }),
    ).toBeNull();
    expect(
      resolveSessionGridArrowTargetIndex({
        key: "ArrowLeft",
        currentIndex: 3,
        columnCount: 3,
        itemCount: 6,
      }),
    ).toBeNull();
    expect(
      resolveSessionGridArrowTargetIndex({
        key: "ArrowDown",
        currentIndex: 4,
        columnCount: 3,
        itemCount: 5,
      }),
    ).toBeNull();
  });
});

describe("buildSessionGridSections", () => {
  const repositoryIdentity = {
    canonicalKey: "github.com/acme/shared",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/shared.git",
    },
  };
  const primary = makeProject({ repositoryIdentity });
  const remote = makeProject({
    environmentId: ENVIRONMENT_B,
    id: ProjectId.make("project-a-remote"),
    workspaceRoot: "/remote/projects/a",
    repositoryIdentity,
  });
  const other = makeProject({
    id: ProjectId.make("project-b"),
    title: "Project B",
    workspaceRoot: "/projects/b",
  });
  const groups = buildSidebarProjectSnapshots({
    projects: [primary, remote, other],
    settings: {
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    },
    primaryEnvironmentId: ENVIRONMENT_A,
    resolveEnvironmentLabel: (environmentId) =>
      environmentId === ENVIRONMENT_A ? "Local" : "Remote",
  });
  const sharedGroup = groups.find((group) => group.groupedProjectCount === 2)!;
  const otherGroup = groups.find((group) => group.id === other.id)!;
  const pinnedOld = makeThread({
    id: ThreadId.make("pinned-old"),
    pinnedAt: NOW,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const localNew = makeThread({
    id: ThreadId.make("local-new"),
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  const remoteNew = makeThread({
    environmentId: ENVIRONMENT_B,
    id: ThreadId.make("remote-new"),
    projectId: remote.id,
    createdAt: "2026-08-05T00:00:00.000Z",
  });

  it("groups physical environment copies under one logical project", () => {
    const model = buildSessionGridSections({
      projects: groups,
      activeThreads: [localNew, remoteNew, pinnedOld],
      snoozedThreads: [],
      requestedProjectKey: null,
    });

    expect(model.sections).toHaveLength(1);
    expect(model.sections[0]?.project.projectKey).toBe(sharedGroup.projectKey);
    expect(model.sections[0]?.threads.map((thread) => thread.id)).toEqual([
      pinnedOld.id,
      remoteNew.id,
      localNew.id,
    ]);
    expect(model.countsByProjectKey.get(sharedGroup.projectKey)).toBe(3);
    expect(model.countsByProjectKey.get(otherGroup.projectKey)).toBe(0);
  });

  it("keeps a selected empty project so the UI can render its empty state", () => {
    const model = buildSessionGridSections({
      projects: groups,
      activeThreads: [localNew],
      snoozedThreads: [],
      requestedProjectKey: otherGroup.projectKey,
    });

    expect(model.selectedProjectKey).toBe(otherGroup.projectKey);
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0]?.project.projectKey).toBe(otherGroup.projectKey);
    expect(model.sections[0]?.threads).toEqual([]);
  });

  it("falls back to the first project with unsettled work for a stale URL scope", () => {
    const model = buildSessionGridSections({
      projects: groups,
      activeThreads: [localNew],
      snoozedThreads: [],
      requestedProjectKey: "missing-project",
    });

    expect(model.selectedProjectKey).toBe(sharedGroup.projectKey);
    expect(model.sections.map((section) => section.project.projectKey)).toEqual([
      sharedGroup.projectKey,
    ]);
    expect(resolveSessionGridProject(groups, "missing-project")).toBeNull();
    expect(resolveSessionGridProject(groups, sharedGroup.projectKey)).toBe(sharedGroup);
  });

  it("keeps snoozed threads in the unsettled project count after active panes", () => {
    const snoozedLater = makeThread({
      id: ThreadId.make("snoozed-later"),
      snoozedAt: NOW,
      snoozedUntil: "2026-08-07T12:00:00.000Z",
    });
    const snoozedSooner = makeThread({
      id: ThreadId.make("snoozed-sooner"),
      snoozedAt: NOW,
      snoozedUntil: "2026-08-06T12:00:00.000Z",
    });
    const model = buildSessionGridSections({
      projects: groups,
      activeThreads: [localNew],
      snoozedThreads: [snoozedLater, snoozedSooner],
      requestedProjectKey: sharedGroup.projectKey,
    });

    expect(model.sections[0]?.activeThreads.map((thread) => thread.id)).toEqual([localNew.id]);
    expect(model.sections[0]?.snoozedThreads.map((thread) => thread.id)).toEqual([
      snoozedSooner.id,
      snoozedLater.id,
    ]);
    expect(model.sections[0]?.threads.map((thread) => thread.id)).toEqual([
      localNew.id,
      snoozedSooner.id,
      snoozedLater.id,
    ]);
    expect(model.countsByProjectKey.get(sharedGroup.projectKey)).toBe(3);
  });
});
