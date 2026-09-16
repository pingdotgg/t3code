import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationProjectShell, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { buildArchivedThreadGroups } from "./archivedThreadList";
import { makeRawThreadShell } from "../../test-fixtures";

const environmentId = EnvironmentId.make("environment-1");

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
  input: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "title"> & {
    readonly branch?: string | null;
    readonly archivedAt?: string | null;
  },
): OrchestrationV2ThreadShell {
  const archivedAt = input.archivedAt === undefined ? "2026-06-02T00:00:00.000Z" : input.archivedAt;
  return makeRawThreadShell({
    ...input,
    archivedAt: archivedAt === null ? null : DateTime.makeUnsafe(archivedAt),
  });
}

function makeSnapshot(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  targetEnvironmentId = environmentId,
): ArchivedSnapshotEntry {
  return {
    environmentId: targetEnvironmentId,
    snapshot: {
      schemaVersion: 1,
      snapshotSequence: 1,
      projects,
      threads,
    },
  };
}

describe("buildArchivedThreadGroups", () => {
  it("groups archived threads by project and sorts newest first", () => {
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

    const result = buildArchivedThreadGroups({
      snapshots: [makeSnapshot([project], [older, newer])],
      environmentLabels: { [environmentId]: "Julius's MacBook Pro" },
      environmentId: null,
      searchQuery: "",
      sortOrder: "newest",
    });

    expect(result[0]?.threads.map((thread) => thread.id)).toEqual(["thread-newer", "thread-older"]);
  });

  it("filters by environment and matches project, thread, and branch text", () => {
    const secondEnvironmentId = EnvironmentId.make("environment-2");
    const firstProject = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const secondProject = makeProject({ id: ProjectId.make("project-2"), title: "Website" });
    const firstThread = makeThread({
      branch: "fix/archive-screen",
      id: ThreadId.make("thread-1"),
      projectId: firstProject.id,
      title: "Build settings route",
    });
    const secondThread = makeThread({
      id: ThreadId.make("thread-2"),
      projectId: secondProject.id,
      title: "Unrelated",
    });
    const snapshots = [
      makeSnapshot([firstProject], [firstThread]),
      makeSnapshot([secondProject], [secondThread], secondEnvironmentId),
    ];

    const result = buildArchivedThreadGroups({
      snapshots,
      environmentLabels: {
        [environmentId]: "Local",
        [secondEnvironmentId]: "Remote",
      },
      environmentId,
      searchQuery: "archive-screen",
      sortOrder: "oldest",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.project.environmentId).toBe(environmentId);
    expect(result[0]?.threads.map((thread) => thread.id)).toEqual(["thread-1"]);
  });

  it("ignores non-archived entries returned in a snapshot", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const active = makeThread({
      archivedAt: null,
      id: ThreadId.make("thread-active"),
      projectId: project.id,
      title: "Active",
    });

    const result = buildArchivedThreadGroups({
      snapshots: [makeSnapshot([project], [active])],
      environmentLabels: {},
      environmentId: null,
      searchQuery: "",
      sortOrder: "newest",
    });

    expect(result).toEqual([]);
  });
});
