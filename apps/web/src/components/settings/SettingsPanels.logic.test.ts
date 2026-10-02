import {
  type CollaborativeAcceptancePolicy,
  DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { Project, ThreadShell } from "../../types";
import {
  buildArchivedThreadGroups,
  buildArchivedThreadGroupsFromSnapshots,
  buildProviderInstanceUpdatePatch,
  filterArchivedThreadGroups,
  mergeCollaborativeAcceptancePolicy,
  parseAutoArchiveSettledAfterDays,
  resolveAutoArchiveSettledAfterDays,
  runSequentiallySettled,
} from "./SettingsPanels.logic";

describe("mergeCollaborativeAcceptancePolicy", () => {
  const policy: CollaborativeAcceptancePolicy = {
    automation: "bounded",
    reviewTrigger: "first-candidate",
    reviewWorkflow: { identity: "review-changes", version: "1" },
    commentPolicy: "blocking-only",
    budgets: {
      exchanges: 3,
      modelSpendCents: 0,
      retries: 1,
      disputeRounds: 1,
      executionDurationSeconds: 0,
      waitingDeadlineSeconds: 0,
    },
  };

  it("preserves earlier nested edits across consecutive patches", () => {
    const withModelSpend = mergeCollaborativeAcceptancePolicy(policy, {
      budgets: { modelSpendCents: 500 },
    });
    const withRetries = mergeCollaborativeAcceptancePolicy(withModelSpend, {
      budgets: { retries: 2 },
    });
    const withWorkflowVersion = mergeCollaborativeAcceptancePolicy(withRetries, {
      reviewWorkflow: { version: "2" },
    });

    expect(withWorkflowVersion).toEqual({
      ...policy,
      reviewWorkflow: { identity: "review-changes", version: "2" },
      budgets: {
        ...policy.budgets,
        modelSpendCents: 500,
        retries: 2,
      },
    });
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("runSequentiallySettled", () => {
  it("continues after an item fails", async () => {
    const visited: number[] = [];
    const results = await runSequentiallySettled([1, 2, 3], async (item) => {
      visited.push(item);
      if (item === 2) {
        throw new Error("failed");
      }
    });

    expect(visited).toEqual([1, 2, 3]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("parseAutoArchiveSettledAfterDays", () => {
  it("accepts whole days within 1-90 and trims surrounding whitespace", () => {
    expect(parseAutoArchiveSettledAfterDays("1")).toBe(1);
    expect(parseAutoArchiveSettledAfterDays("90")).toBe(90);
    expect(parseAutoArchiveSettledAfterDays(" 7 ")).toBe(7);
  });

  it("rejects decimals, trailing text, and empty input instead of truncating", () => {
    expect(parseAutoArchiveSettledAfterDays("3.5")).toBeNull();
    expect(parseAutoArchiveSettledAfterDays("3days")).toBeNull();
    expect(parseAutoArchiveSettledAfterDays("")).toBeNull();
    expect(parseAutoArchiveSettledAfterDays("   ")).toBeNull();
    expect(parseAutoArchiveSettledAfterDays("-3")).toBeNull();
  });

  it("rejects values outside 1-90", () => {
    expect(parseAutoArchiveSettledAfterDays("0")).toBeNull();
    expect(parseAutoArchiveSettledAfterDays("91")).toBeNull();
  });
});

describe("resolveAutoArchiveSettledAfterDays", () => {
  it("falls back to the default while the contracts schema has no value", () => {
    expect(resolveAutoArchiveSettledAfterDays(undefined)).toBe(
      DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
    );
  });

  it("preserves an explicit never-archive choice", () => {
    expect(resolveAutoArchiveSettledAfterDays(null)).toBeNull();
  });

  it("passes stored values through", () => {
    expect(resolveAutoArchiveSettledAfterDays(5)).toBe(5);
  });
});

describe("buildArchivedThreadGroups", () => {
  const makeProject = (environmentId: string, id: string, name: string): Project => ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    name,
    cwd: `/tmp/${environmentId}/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
  });

  const makeThread = (
    environmentId: string,
    projectId: string,
    id: string,
    archivedAt: string | null,
  ): ThreadShell => ({
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    codexThreadId: null,
    projectId: ProjectId.make(projectId),
    parentThreadId: null,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
      options: [],
    },
    runtimeMode: "full-access",
    pendingRuntimeMode: null,
    interactionMode: "default",
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
    branch: null,
    worktreePath: null,
  });

  it("builds groups from archived snapshots when the active shell is empty", () => {
    const environmentId = EnvironmentId.make("env-a");
    const project = makeProject("env-a", "project-1", "Archived Project");
    const thread = makeThread("env-a", "project-1", "thread-archived", "2026-01-03T00:00:00.000Z");
    const snapshot = {
      snapshotSequence: 2,
      projects: [
        {
          id: project.id,
          title: project.name,
          workspaceRoot: project.cwd,
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      ],
      threads: [
        {
          id: thread.id,
          projectId: thread.projectId,
          parentThreadId: null,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: null,
          worktreePath: "/tmp/worktrees/thread-archived",
          latestTurn: null,
          createdAt: thread.createdAt,
          updatedAt: "2026-01-03T00:00:00.000Z",
          archivedAt: thread.archivedAt,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          hasPendingQueuedTurn: false,
        },
      ],
      updatedAt: "2026-01-03T00:00:00.000Z",
    } satisfies OrchestrationShellSnapshot;

    const groups = buildArchivedThreadGroupsFromSnapshots({
      snapshots: [{ environmentId, snapshot }],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.project).toMatchObject({
      environmentId,
      id: project.id,
      name: project.name,
    });
    expect(groups[0]?.threads.map((archivedThread) => archivedThread.id)).toEqual([thread.id]);
    expect(groups[0]?.threads[0]?.worktreePath).toBe("/tmp/worktrees/thread-archived");
  });

  it("scopes archived threads by environment and project", () => {
    const envAProject = makeProject("env-a", "project-1", "Env A Project");
    const envBProject = makeProject("env-b", "project-1", "Env B Project");
    const envAArchived = makeThread(
      "env-a",
      "project-1",
      "thread-archived-a",
      "2026-01-03T00:00:00.000Z",
    );
    const envBArchived = makeThread(
      "env-b",
      "project-1",
      "thread-archived-b",
      "2026-01-02T00:00:00.000Z",
    );

    const groups = buildArchivedThreadGroups({
      projects: [envAProject, envBProject],
      threads: [
        envAArchived,
        envBArchived,
        makeThread("env-a", "project-1", "thread-active-a", null),
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups[0]?.project.environmentId).toBe(envAProject.environmentId);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual([envAArchived.id]);
    expect(groups[1]?.project.environmentId).toBe(envBProject.environmentId);
    expect(groups[1]?.threads.map((thread) => thread.id)).toEqual([envBArchived.id]);
  });

  it("filters archived threads by title or project name", () => {
    const alphaProject = makeProject("env-a", "project-a", "Alpha");
    const betaProject = makeProject("env-b", "project-b", "Beta");
    const alphaThread = makeThread(
      "env-a",
      "project-a",
      "refactor-auth",
      "2026-01-03T00:00:00.000Z",
    );
    const betaThread = makeThread(
      "env-b",
      "project-b",
      "release-notes",
      "2026-01-02T00:00:00.000Z",
    );
    const groups = buildArchivedThreadGroups({
      projects: [alphaProject, betaProject],
      threads: [alphaThread, betaThread],
    });

    expect(filterArchivedThreadGroups(groups, "refactor")).toEqual([
      { project: alphaProject, threads: [alphaThread] },
    ]);
    expect(filterArchivedThreadGroups(groups, "alpha")).toEqual([
      { project: alphaProject, threads: [alphaThread] },
    ]);
  });
});
