import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
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
        return value !== 3;
      },
      { concurrency: 2 },
    );

    expect(maximumActive).toBe(2);
    expect(summary).toEqual({ succeeded: 4, failed: 1 });
  });
});

describe("formatArchivedThreadRelativeTime", () => {
  it("omits invalid archive timestamps instead of presenting them as recent", () => {
    expect(formatArchivedThreadRelativeTime("not-a-timestamp")).toBeNull();
  });
});
