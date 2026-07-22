import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archivedThreadActionExceptionDescription,
  archivedThreadActionSummaryDescription,
  archivedThreadTimestampValue,
  buildArchivedThreadGroups,
  formatArchivedThreadRelativeTime,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  runArchivedThreadActions,
  type ArchivedThreadSortState,
} from "./archivedThreadList";

const environmentId = EnvironmentId.make("environment-1");
const defaultSort: ArchivedThreadSortState = { field: "archivedAt", direction: "desc" };

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
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
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

function buildGroups(input: {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly query?: string;
  readonly environmentId?: EnvironmentId | null;
  readonly sort?: ArchivedThreadSortState;
}) {
  return buildArchivedThreadGroups({
    snapshots: input.snapshots,
    environmentId: input.environmentId ?? null,
    search: parseArchivedThreadSearchInput(input.query ?? ""),
    sort: input.sort ?? defaultSort,
  });
}

describe("buildArchivedThreadGroups", () => {
  it("groups archived threads by project and sorts archived newest first", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const older = makeThread({
      id: ThreadId.make("thread-older"),
      projectId: project.id,
      title: "Older",
    });
    const newer = makeThread({
      archivedAt: "2026-06-03T00:00:00.000Z",
      id: ThreadId.make("thread-newer"),
      projectId: project.id,
      title: "Newer",
    });

    const result = buildGroups({ snapshots: [makeSnapshot([project], [older, newer])] });

    expect(result[0]?.threads.map((thread) => thread.id)).toEqual(["thread-newer", "thread-older"]);
  });

  it("sorts by created date independently of archived date", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const olderCreated = makeThread({
      archivedAt: "2026-06-04T00:00:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z",
      id: ThreadId.make("thread-older-created"),
      projectId: project.id,
      title: "Older created",
    });
    const newerCreated = makeThread({
      archivedAt: "2026-06-02T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
      id: ThreadId.make("thread-newer-created"),
      projectId: project.id,
      title: "Newer created",
    });

    const result = buildGroups({
      snapshots: [makeSnapshot([project], [olderCreated, newerCreated])],
      sort: { field: "createdAt", direction: "asc" },
    });

    expect(result[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-older-created",
      "thread-newer-created",
    ]);
  });

  it("orders project sections by the selected field and direction", () => {
    const olderProject = makeProject({ id: ProjectId.make("project-older"), title: "Older" });
    const newerProject = makeProject({ id: ProjectId.make("project-newer"), title: "Newer" });
    const olderCreated = makeThread({
      archivedAt: "2026-06-02T00:00:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z",
      id: ThreadId.make("thread-older-created"),
      projectId: olderProject.id,
      title: "Older created",
    });
    const newerCreated = makeThread({
      archivedAt: "2026-06-04T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
      id: ThreadId.make("thread-newer-created"),
      projectId: newerProject.id,
      title: "Newer created",
    });

    const result = buildGroups({
      snapshots: [makeSnapshot([newerProject, olderProject], [newerCreated, olderCreated])],
      sort: { field: "createdAt", direction: "asc" },
    });

    expect(result.map((group) => group.project.id)).toEqual(["project-older", "project-newer"]);
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

    const result = buildGroups({
      snapshots: [makeSnapshot([project], [validArchivedAt, invalidArchivedAt])],
    });

    expect(result[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-invalid-archive",
      "thread-valid-archive",
    ]);
    expect(archivedThreadTimestampValue(invalidArchivedAt, "archivedAt")).toBe(
      invalidArchivedAt.createdAt,
    );
  });

  it("ranks phrase and all-token title matches ahead of partial token matches", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const partial = makeThread({
      id: ThreadId.make("thread-partial"),
      projectId: project.id,
      title: "Archive cleanup",
    });
    const allTokens = makeThread({
      id: ThreadId.make("thread-all"),
      projectId: project.id,
      title: "Settings for the archive",
    });
    const phrase = makeThread({
      id: ThreadId.make("thread-phrase"),
      projectId: project.id,
      title: "Archive settings screen",
    });

    const result = buildGroups({
      snapshots: [makeSnapshot([project], [partial, allTokens, phrase])],
      query: "archive settings",
    });

    expect(result[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-phrase",
      "thread-all",
      "thread-partial",
    ]);
  });

  it("preserves search ranking tiers for matches late in long titles", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const latePhrase = makeThread({
      id: ThreadId.make("thread-late-phrase"),
      projectId: project.id,
      title: `${"x".repeat(600)} archive settings`,
    });
    const earlyAllTokens = makeThread({
      id: ThreadId.make("thread-early-all"),
      projectId: project.id,
      title: "Archive tools Settings",
    });
    const lateAllTokens = makeThread({
      id: ThreadId.make("thread-late-all"),
      projectId: project.id,
      title: `Archive ${"x".repeat(3_000)} Settings`,
    });
    const earlyPartial = makeThread({
      id: ThreadId.make("thread-early-partial"),
      projectId: project.id,
      title: "Archive only",
    });

    const result = buildGroups({
      snapshots: [
        makeSnapshot([project], [earlyPartial, lateAllTokens, earlyAllTokens, latePhrase]),
      ],
      query: "archive settings",
    });

    expect(result[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-late-phrase",
      "thread-early-all",
      "thread-late-all",
      "thread-early-partial",
    ]);
  });

  it("filters archived title matches by environment", () => {
    const secondEnvironmentId = EnvironmentId.make("environment-2");
    const firstProject = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const secondProject = makeProject({ id: ProjectId.make("project-2"), title: "Website" });
    const firstThread = makeThread({
      id: ThreadId.make("thread-1"),
      projectId: firstProject.id,
      title: "Build archive settings route",
    });
    const secondThread = makeThread({
      id: ThreadId.make("thread-2"),
      projectId: secondProject.id,
      title: "Build archive settings route remotely",
    });

    const result = buildGroups({
      snapshots: [
        makeSnapshot([firstProject], [firstThread]),
        makeSnapshot([secondProject], [secondThread], secondEnvironmentId),
      ],
      environmentId,
      query: "archive settings",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.project.environmentId).toBe(environmentId);
  });

  it("ignores non-archived entries returned in a snapshot", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const active = makeThread({
      archivedAt: null,
      id: ThreadId.make("thread-active"),
      projectId: project.id,
      title: "Active",
    });

    expect(buildGroups({ snapshots: [makeSnapshot([project], [active])] })).toEqual([]);
  });

  it("keeps archive group keys distinct when scoped ids contain colons", () => {
    const firstEnvironmentId = EnvironmentId.make("environment:one");
    const secondEnvironmentId = EnvironmentId.make("environment");
    const firstProject = makeProject({ id: ProjectId.make("project"), title: "First" });
    const secondProject = makeProject({ id: ProjectId.make("one:project"), title: "Second" });
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

    const result = buildGroups({
      snapshots: [
        makeSnapshot([firstProject], [firstThread], firstEnvironmentId),
        makeSnapshot([secondProject], [secondThread], secondEnvironmentId),
      ],
    });

    expect(result.map((group) => group.key)).toEqual([
      '["environment:one","project"]',
      '["environment","one:project"]',
    ]);
  });
});

describe("archive list controls", () => {
  it("toggles a selected sort field and defaults a new field to descending", () => {
    expect(nextArchivedThreadSortState(defaultSort, "archivedAt")).toEqual({
      field: "archivedAt",
      direction: "asc",
    });
    expect(nextArchivedThreadSortState(defaultSort, "createdAt")).toEqual({
      field: "createdAt",
      direction: "desc",
    });
  });

  it("runs bulk actions with bounded concurrency and reports partial failures", async () => {
    let active = 0;
    let maximumActive = 0;
    const summary = await runArchivedThreadActions(
      [1, 2, 3, 4, 5],
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        if (value === 3) return "failed";
        if (value === 4) return "skipped";
        return "succeeded";
      },
      { concurrency: 2 },
    );

    expect(maximumActive).toBe(2);
    expect(summary).toEqual({ succeeded: 3, failed: 1, skipped: 1 });
    expect(archivedThreadActionSummaryDescription(summary)).toBe(
      "3 succeeded, 1 failed, and 1 skipped because already in progress.",
    );
  });

  it("surfaces distinct underlying bulk action exceptions", () => {
    const error = new AggregateError([
      new Error("Connection failed"),
      new Error("Connection failed"),
      "unknown failure",
      new Error("Permission denied"),
      new Error("Session expired"),
    ]);

    expect(archivedThreadActionExceptionDescription(error)).toBe(
      "One or more archived thread actions failed unexpectedly. Failures: Connection failed; An error occurred.; Permission denied; 1 more",
    );
  });
});

describe("formatArchivedThreadRelativeTime", () => {
  it("omits invalid archive timestamps instead of presenting them as recent", () => {
    expect(formatArchivedThreadRelativeTime("not-a-timestamp")).toBeNull();
  });
});
