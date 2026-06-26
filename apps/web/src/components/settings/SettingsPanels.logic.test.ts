import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";
import {
  archivedThreadSearchScore,
  buildArchivedThreadGroups,
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  runArchivedProjectThreadActions,
} from "./SettingsPanels.logic";

const environmentId = EnvironmentId.make("environment-1");

function scoreArchivedTitle(title: string, query: string): number | null {
  const normalizedQuery = normalizeSearchQuery(query);
  return archivedThreadSearchScore({
    normalizedTitle: normalizeSearchQuery(title),
    normalizedQuery,
    tokens: normalizedQuery.split(/\s+/u).filter((token) => token.length > 0),
  });
}

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
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: "2026-06-02T00:00:00.000Z",
    session: null,
    latestUserMessageAt: null,
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

describe("archivedThreadSearchScore", () => {
  it("ranks phrase matches ahead of all-token and partial-token matches", () => {
    const phraseMatch = scoreArchivedTitle("Alpha Beta cleanup", "alpha beta");
    const allTokenMatch = scoreArchivedTitle("Alpha cleanup Beta", "alpha beta");
    const partialTokenMatch = scoreArchivedTitle("Alpha cleanup", "alpha beta");

    expect(phraseMatch).not.toBeNull();
    expect(allTokenMatch).not.toBeNull();
    expect(partialTokenMatch).not.toBeNull();
    expect(phraseMatch!).toBeLessThan(allTokenMatch!);
    expect(allTokenMatch!).toBeLessThan(partialTokenMatch!);
  });

  it("matches titles case-insensitively and rejects unrelated titles", () => {
    expect(scoreArchivedTitle("Release Candidate Notes", "candidate")).not.toBeNull();
    expect(scoreArchivedTitle("Release Candidate Notes", "missing")).toBeNull();
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
    const search = parseArchivedThreadSearchInput("");

    const result = buildArchivedThreadGroups({
      snapshots: [makeSnapshot([firstProject, secondProject], [older, newer])],
      normalizedSearchQuery: search.normalizedQuery,
      searchTokens: search.tokens,
      isSearching: search.isSearching,
      sort: { field: "archivedAt", direction: "desc" },
    });

    expect(result.map((group) => group.project.id)).toEqual(["project-1"]);
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

  it("uses the latest duplicate project metadata and ignores threads without projects", () => {
    const sharedProjectId = ProjectId.make("project-shared");
    const remoteEnvironmentId = EnvironmentId.make("environment-2");
    const olderProject = makeProject({ id: sharedProjectId, title: "Older Local Project" });
    const latestProject = makeProject({
      id: sharedProjectId,
      title: "Latest Local Project",
      workspaceRoot: "/workspaces/latest-local",
    });
    const remoteProject = makeProject({
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
    expect(result.map((group) => `${group.project.environmentId}:${group.project.name}`)).toEqual([
      "environment-1:Latest Local Project",
      "environment-2:Remote Project",
    ]);
    expect(result.map((group) => group.project.cwd)).toEqual([
      "/workspaces/latest-local",
      "/workspaces/remote",
    ]);
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

describe("nextArchivedThreadSortState", () => {
  it("toggles the active sort field and defaults new fields to descending", () => {
    expect(
      nextArchivedThreadSortState({ field: "archivedAt", direction: "desc" }, "archivedAt"),
    ).toEqual({ field: "archivedAt", direction: "asc" });
    expect(
      nextArchivedThreadSortState({ field: "archivedAt", direction: "asc" }, "createdAt"),
    ).toEqual({ field: "createdAt", direction: "desc" });
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
          return successResult();
        } finally {
          activeCount -= 1;
        }
      });
    } catch (error) {
      caughtError = error;
    }

    expect(activeCount).toBe(0);
    expect(caughtError).toBeInstanceOf(AggregateError);
    expect((caughtError as AggregateError).errors).toHaveLength(2);
    expect(attemptedThreadIds).toHaveLength(4);
    expect(new Set(attemptedThreadIds)).toEqual(
      new Set(["thread-0", "thread-1", "thread-2", "thread-3"]),
    );
  });
});

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
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
