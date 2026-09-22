import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";
import {
  archivedProjectBulkActionExceptionDescription,
  ArchivedProjectBulkActionError,
  archivedProjectBulkFailureDescription,
  archivedThreadTimestampValue,
  buildArchivedProjectContextMenuItems,
  buildArchivedThreadContextMenuItems,
  buildArchivedThreadGroups,
  hasArchivedThreads,
  parseArchivedThreadSearchInput,
  resolveArchivedProjectEnvironmentLabel,
  runArchivedProjectThreadActions,
  scopeArchivedThreadSnapshots,
} from "./ArchiveSettings.logic";

const environmentId = EnvironmentId.make("environment-1");

describe("archive context menus", () => {
  it("uses the upstream icon and destructive section conventions for thread actions", () => {
    expect(buildArchivedThreadContextMenuItems()).toEqual([
      { id: "unarchive", label: "Unarchive", icon: "archive-restore" },
      {
        id: "delete",
        label: "Delete",
        icon: "trash",
        destructive: true,
        separatorBefore: true,
      },
    ]);
  });

  it("keeps project action labels scoped while sharing the same menu treatment", () => {
    expect(buildArchivedProjectContextMenuItems("matching")).toEqual([
      { id: "unarchive-all", label: "Unarchive matching", icon: "archive-restore" },
      {
        id: "delete-all",
        label: "Delete matching",
        icon: "trash",
        destructive: true,
        separatorBefore: true,
      },
    ]);
    expect(buildArchivedProjectContextMenuItems("all").map((item) => item.label)).toEqual([
      "Unarchive all",
      "Delete all",
    ]);
  });
});

function makeProject(
  input: Partial<OrchestrationProjectShell> & Pick<OrchestrationProjectShell, "id" | "title">,
): OrchestrationProjectShell {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(
  input: Partial<OrchestrationThreadShell> &
    Pick<OrchestrationThreadShell, "id" | "projectId" | "title">,
): OrchestrationThreadShell {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: "2026-06-02T00:00:00.000Z",
    session: null,
    latestUserMessageAt: null,
    settledOverride: null,
    settledAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

function makeSnapshot(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationThreadShell>,
  targetEnvironmentId = environmentId,
): ArchivedSnapshotEntry {
  return {
    environmentId: targetEnvironmentId,
    snapshot: {
      snapshotSequence: 1,
      projects,
      threads,
      updatedAt: "2026-06-04T00:00:00.000Z",
    },
  };
}

function successResult(value: unknown = null): AtomCommandResult<unknown, unknown> {
  return AsyncResult.success(value);
}

function failureResult(cause: unknown): AtomCommandResult<unknown, unknown> {
  return AsyncResult.failure(Cause.fail(cause));
}

function waitForMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("resolveArchivedProjectEnvironmentLabel", () => {
  const primaryEnvironment = {
    environmentId,
    label: "Local environment",
    isPrimary: true,
  } as const;
  const remoteEnvironment = {
    environmentId: EnvironmentId.make("environment-remote"),
    label: "Build box",
    isPrimary: false,
  } as const;

  it("shows a sole remote environment label", () => {
    expect(
      resolveArchivedProjectEnvironmentLabel({
        environment: remoteEnvironment,
        hasMultipleEnvironments: false,
      }),
    ).toBe("Build box");
  });

  it("shows a remote environment label when multiple environments exist", () => {
    expect(
      resolveArchivedProjectEnvironmentLabel({
        environment: remoteEnvironment,
        hasMultipleEnvironments: true,
      }),
    ).toBe("Build box");
  });

  it("hides a sole primary environment label", () => {
    expect(
      resolveArchivedProjectEnvironmentLabel({
        environment: primaryEnvironment,
        hasMultipleEnvironments: false,
      }),
    ).toBeNull();
  });

  it("shows and normalizes the primary label when multiple environments exist", () => {
    expect(
      resolveArchivedProjectEnvironmentLabel({
        environment: primaryEnvironment,
        hasMultipleEnvironments: true,
      }),
    ).toBe("This device");
  });

  it("hides the label when the environment is unknown", () => {
    expect(
      resolveArchivedProjectEnvironmentLabel({
        environment: null,
        hasMultipleEnvironments: true,
      }),
    ).toBeNull();
  });
});

describe("scopeArchivedThreadSnapshots", () => {
  const remoteEnvironmentId = EnvironmentId.make("remote");
  const project = makeProject({ id: ProjectId.make("same-project"), title: "Project" });
  const other = makeProject({ id: ProjectId.make("other"), title: "Other" });
  const thread = makeThread({
    id: ThreadId.make("same-thread"),
    projectId: project.id,
    title: "Match",
  });
  const otherThread = makeThread({
    id: ThreadId.make("other-thread"),
    projectId: other.id,
    title: "Other",
  });
  const snapshots = [
    makeSnapshot([project, other], [thread, otherThread]),
    makeSnapshot([project], [thread], remoteEnvironmentId),
  ];

  it("keeps archived-only projects across all configured environments in global scope", () => {
    expect(
      scopeArchivedThreadSnapshots(snapshots, {
        kind: "all",
        environmentIds: [environmentId, remoteEnvironmentId],
        members: [],
      }),
    ).toEqual(snapshots);
  });

  it("excludes stale snapshots from environments outside the selected scope", () => {
    expect(
      scopeArchivedThreadSnapshots(snapshots, {
        kind: "environment",
        environmentIds: [remoteEnvironmentId],
        members: [],
      }),
    ).toEqual([snapshots[1]]);
  });

  it.each(["project", "checkout"] as const)(
    "restricts %s scope threads and project shells by environment identity",
    (kind) => {
      const selected = scopeArchivedThreadSnapshots(snapshots, {
        kind,
        environmentIds: [environmentId, remoteEnvironmentId],
        members: [{ id: project.id, environmentId: remoteEnvironmentId }],
      });
      expect(selected.map(({ snapshot }) => snapshot.projects)).toEqual([[], [project]]);
      expect(selected.map(({ snapshot }) => snapshot.threads)).toEqual([[], [thread]]);
      expect(hasArchivedThreads(selected.slice(0, 1))).toBe(false);
    },
  );

  it("does not expose archive content for an unavailable scope", () => {
    expect(
      scopeArchivedThreadSnapshots(snapshots, {
        kind: "unavailable",
        environmentIds: [],
        members: [],
      }),
    ).toEqual([]);
  });
});

describe("buildArchivedThreadGroups", () => {
  it("keeps project order when not searching and sorts threads by archive timestamp", () => {
    const firstProject = makeProject({ id: ProjectId.make("project-1"), title: "First" });
    const secondProject = makeProject({ id: ProjectId.make("project-2"), title: "Second" });
    const older = makeThread({
      id: ThreadId.make("thread-older"),
      projectId: firstProject.id,
      title: "Older",
    });
    const newer = makeThread({
      archivedAt: "2026-06-03T00:00:00.000Z",
      id: ThreadId.make("thread-newer"),
      projectId: firstProject.id,
      title: "Newer",
    });
    const newest = makeThread({
      archivedAt: "2026-06-04T00:00:00.000Z",
      id: ThreadId.make("thread-newest"),
      projectId: secondProject.id,
      title: "Newest",
    });
    const search = parseArchivedThreadSearchInput("");

    const result = buildArchivedThreadGroups({
      snapshots: [makeSnapshot([firstProject, secondProject], [older, newer, newest])],
      normalizedSearchQuery: search.normalizedQuery,
      searchTokens: search.tokens,
      isSearching: search.isSearching,
      sort: { field: "archivedAt", direction: "desc" },
    });

    expect(result.map((group) => group.project.id)).toEqual(["project-1", "project-2"]);
    expect(result[0]?.threads.map((thread) => thread.id)).toEqual(["thread-newer", "thread-older"]);
  });

  it("filters ranked title matches and sorts matching projects by best score", () => {
    const partialProject = makeProject({ id: ProjectId.make("project-partial"), title: "Partial" });
    const phraseProject = makeProject({ id: ProjectId.make("project-phrase"), title: "Phrase" });
    const partialThread = makeThread({
      id: ThreadId.make("thread-partial"),
      projectId: partialProject.id,
      title: "Alpha cleanup",
    });
    const phraseThread = makeThread({
      id: ThreadId.make("thread-phrase"),
      projectId: phraseProject.id,
      title: "Alpha Beta cleanup",
    });
    const missingThread = makeThread({
      id: ThreadId.make("thread-missing"),
      projectId: partialProject.id,
      title: "Gamma cleanup",
    });
    const search = parseArchivedThreadSearchInput("alpha beta");

    const result = buildArchivedThreadGroups({
      snapshots: [
        makeSnapshot([partialProject, phraseProject], [partialThread, phraseThread, missingThread]),
      ],
      normalizedSearchQuery: search.normalizedQuery,
      searchTokens: search.tokens,
      isSearching: search.isSearching,
      sort: { field: "archivedAt", direction: "desc" },
    });

    expect(result.map((group) => group.project.id)).toEqual(["project-phrase", "project-partial"]);
    expect(result.flatMap((group) => group.threads.map((thread) => thread.id))).toEqual([
      "thread-phrase",
      "thread-partial",
    ]);
  });

  it("ignores active and snoozed-active threads returned in archive snapshots", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const activeThread = makeThread({
      archivedAt: null,
      id: ThreadId.make("thread-active"),
      projectId: project.id,
      title: "Active thread",
    });
    const snoozedActiveThread = makeThread({
      archivedAt: null,
      id: ThreadId.make("thread-snoozed-active"),
      projectId: project.id,
      snoozedAt: "2026-06-03T00:00:00.000Z",
      snoozedUntil: "2026-06-05T00:00:00.000Z",
      title: "Snoozed active thread",
    });
    const search = parseArchivedThreadSearchInput("");

    const result = buildArchivedThreadGroups({
      snapshots: [makeSnapshot([project], [activeThread, snoozedActiveThread])],
      normalizedSearchQuery: search.normalizedQuery,
      searchTokens: search.tokens,
      isSearching: search.isSearching,
      sort: { field: "archivedAt", direction: "desc" },
    });

    expect(result).toEqual([]);
  });

  it("falls back to created time when an archived timestamp is invalid", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const invalidArchivedAt = makeThread({
      archivedAt: "not-a-timestamp",
      createdAt: "2026-06-05T00:00:00.000Z",
      id: ThreadId.make("thread-invalid-archive"),
      projectId: project.id,
      title: "Invalid archived time",
    });
    const validArchivedAt = makeThread({
      archivedAt: "2026-06-03T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
      id: ThreadId.make("thread-valid-archive"),
      projectId: project.id,
      title: "Valid archived time",
    });
    const search = parseArchivedThreadSearchInput("");

    const result = buildArchivedThreadGroups({
      snapshots: [makeSnapshot([project], [validArchivedAt, invalidArchivedAt])],
      normalizedSearchQuery: search.normalizedQuery,
      searchTokens: search.tokens,
      isSearching: search.isSearching,
      sort: { field: "archivedAt", direction: "desc" },
    });

    expect(result[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-invalid-archive",
      "thread-valid-archive",
    ]);
    expect(archivedThreadTimestampValue(invalidArchivedAt, "archivedAt")).toBe(
      invalidArchivedAt.createdAt,
    );
  });

  it("uses the latest duplicate project metadata and ignores threads without projects", () => {
    const sharedProjectId = ProjectId.make("project-shared");
    const remoteEnvironmentId = EnvironmentId.make("environment-2");
    const olderProject = makeProject({ id: sharedProjectId, title: "Older Local Project" });
    const latestProject = makeProject({
      id: sharedProjectId,
      title: "Latest Local Project",
      workspaceRoot: "/workspaces/latest-local",
      faviconPath: "icons/latest-local.png",
    });
    const remoteProject = makeProject({
      defaultThreadEnvMode: "worktree",
      faviconPath: "icons/remote.png",
      id: sharedProjectId,
      title: "Remote Project",
      workspaceRoot: "/workspaces/remote",
    });
    const localThread = makeThread({
      id: ThreadId.make("thread-local"),
      projectId: sharedProjectId,
      title: "Local thread",
    });
    const remoteThread = makeThread({
      id: ThreadId.make("thread-remote"),
      projectId: sharedProjectId,
      title: "Remote thread",
    });
    const orphanThread = makeThread({
      id: ThreadId.make("thread-orphan"),
      projectId: ProjectId.make("project-missing"),
      title: "Missing project thread",
    });
    const search = parseArchivedThreadSearchInput("");

    const result = buildArchivedThreadGroups({
      snapshots: [
        makeSnapshot([olderProject], [orphanThread]),
        makeSnapshot([latestProject], [localThread]),
        makeSnapshot([remoteProject], [remoteThread], remoteEnvironmentId),
      ],
      normalizedSearchQuery: search.normalizedQuery,
      searchTokens: search.tokens,
      isSearching: search.isSearching,
      sort: { field: "archivedAt", direction: "desc" },
    });

    expect(result).toHaveLength(2);
    expect(result.map((group) => `${group.project.environmentId}:${group.project.title}`)).toEqual([
      "environment-1:Latest Local Project",
      "environment-2:Remote Project",
    ]);
    expect(result.map((group) => group.project.workspaceRoot)).toEqual([
      "/workspaces/latest-local",
      "/workspaces/remote",
    ]);
    expect(result[0]?.project).toStrictEqual({ ...latestProject, environmentId });
    expect(result[1]?.project).toStrictEqual({
      ...remoteProject,
      environmentId: remoteEnvironmentId,
    });
    expect(result.flatMap((group) => group.threads.map((thread) => thread.id))).toEqual([
      "thread-local",
      "thread-remote",
    ]);
  });

  it("keeps projects separate when environment and project ids contain colons", () => {
    const firstEnvironmentId = EnvironmentId.make("environment:one");
    const secondEnvironmentId = EnvironmentId.make("environment");
    const firstProject = makeProject({
      id: ProjectId.make("project"),
      title: "First Project",
    });
    const secondProject = makeProject({
      id: ProjectId.make("one:project"),
      title: "Second Project",
    });
    const firstThread = makeThread({
      id: ThreadId.make("thread-first"),
      projectId: firstProject.id,
      title: "First thread",
    });
    const secondThread = makeThread({
      id: ThreadId.make("thread-second"),
      projectId: secondProject.id,
      title: "Second thread",
    });
    const search = parseArchivedThreadSearchInput("");

    const result = buildArchivedThreadGroups({
      snapshots: [
        makeSnapshot([firstProject], [firstThread], firstEnvironmentId),
        makeSnapshot([secondProject], [secondThread], secondEnvironmentId),
      ],
      normalizedSearchQuery: search.normalizedQuery,
      searchTokens: search.tokens,
      isSearching: search.isSearching,
      sort: { field: "archivedAt", direction: "desc" },
    });

    expect(
      result.map((group) => ({
        key: group.key,
        environmentId: group.project.environmentId,
        projectId: group.project.id,
        threadIds: group.threads.map((thread) => thread.id),
      })),
    ).toEqual([
      {
        key: '["environment:one","project"]',
        environmentId: "environment:one",
        projectId: "project",
        threadIds: ["thread-first"],
      },
      {
        key: '["environment","one:project"]',
        environmentId: "environment",
        projectId: "one:project",
        threadIds: ["thread-second"],
      },
    ]);
  });
});

describe("hasArchivedThreads", () => {
  it("ignores active and snoozed-active threads when determining archive content", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const activeThread = makeThread({
      archivedAt: null,
      id: ThreadId.make("thread-active"),
      projectId: project.id,
      title: "Active thread",
    });
    const snoozedActiveThread = makeThread({
      archivedAt: null,
      id: ThreadId.make("thread-snoozed-active"),
      projectId: project.id,
      snoozedAt: "2026-06-03T00:00:00.000Z",
      snoozedUntil: "2026-06-05T00:00:00.000Z",
      title: "Snoozed active thread",
    });
    const archivedThread = makeThread({
      id: ThreadId.make("thread-archived"),
      projectId: project.id,
      title: "Archived thread",
    });

    expect(hasArchivedThreads([makeSnapshot([project], [activeThread, snoozedActiveThread])])).toBe(
      false,
    );
    expect(
      hasArchivedThreads([
        makeSnapshot([project], [activeThread, snoozedActiveThread, archivedThread]),
      ]),
    ).toBe(true);
  });
});

describe("runArchivedProjectThreadActions", () => {
  it("runs all archived project thread actions and returns failures", async () => {
    const threads = Array.from({ length: 6 }, (_, index) => ({
      id: ThreadId.make(`thread-${index}`),
      environmentId,
    }));
    let activeCount = 0;
    let maxActiveCount = 0;
    const attemptedThreadIds: string[] = [];

    const failures = await runArchivedProjectThreadActions(threads, async (thread) => {
      attemptedThreadIds.push(thread.id);
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await waitForMacrotask();
      activeCount -= 1;
      return thread.id === "thread-2" ? failureResult(new Error("failed")) : successResult();
    });

    expect(failures).toHaveLength(1);
    expect(attemptedThreadIds).toHaveLength(threads.length);
    expect(new Set(attemptedThreadIds)).toEqual(new Set(threads.map((thread) => thread.id)));
    expect(maxActiveCount).toBe(4);
  });

  it("waits for active archived project thread actions before rethrowing aggregate errors", async () => {
    const threads = Array.from({ length: 6 }, (_, index) => ({
      id: ThreadId.make(`thread-${index}`),
      environmentId,
    }));
    let activeCount = 0;
    const attemptedThreadIds: string[] = [];
    let caughtError: unknown;

    try {
      await runArchivedProjectThreadActions(threads, async (thread) => {
        attemptedThreadIds.push(thread.id);
        activeCount += 1;
        try {
          await waitForMacrotask();
          if (thread.id === "thread-0" || thread.id === "thread-1") {
            throw new Error("failed");
          }
          if (thread.id === "thread-2") {
            return failureResult(new Error("command failed"));
          }
          return successResult();
        } finally {
          activeCount -= 1;
        }
      });
    } catch (error) {
      caughtError = error;
    }

    expect(activeCount).toBe(0);
    expect(caughtError).toBeInstanceOf(ArchivedProjectBulkActionError);
    expect((caughtError as ArchivedProjectBulkActionError).errors).toHaveLength(2);
    expect((caughtError as ArchivedProjectBulkActionError).summary).toEqual({
      succeeded: 1,
      failures: [failureResult(new Error("command failed"))],
    });
    expect(archivedProjectBulkActionExceptionDescription(caughtError)).toBe(
      "Partial outcome: 1 succeeded, 1 failed, 2 failed unexpectedly, 2 not attempted. Failures: failed; command failed",
    );
    expect(attemptedThreadIds).toHaveLength(4);
    expect(new Set(attemptedThreadIds)).toEqual(
      new Set(["thread-0", "thread-1", "thread-2", "thread-3"]),
    );
  });
});

describe("archivedProjectBulkFailureDescription", () => {
  it("reports interrupted-only partial outcomes", () => {
    expect(
      archivedProjectBulkFailureDescription([AsyncResult.failure(Cause.interrupt(1))], 2),
    ).toBe("1 succeeded, 0 failed, 1 interrupted.");
  });
});
