import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import { GENERAL_CHATS_PROJECT_ID } from "@t3tools/client-runtime/general-chats";
import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildArchivedThreadGroups } from "./archivedThreadList";

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

describe("buildArchivedThreadGroups", () => {
  it("keeps archived standalone chats out of the mobile archive", () => {
    const chatsProject = makeProject({ id: GENERAL_CHATS_PROJECT_ID, title: "Chats" });
    const chatsThread = makeThread({
      id: ThreadId.make("chat-thread"),
      projectId: GENERAL_CHATS_PROJECT_ID,
      title: "Archived chat",
    });

    expect(
      buildArchivedThreadGroups({
        snapshots: [makeSnapshot([chatsProject], [chatsThread])],
        environmentLabels: {},
        environmentId: null,
        searchQuery: "",
        sortOrder: "newest",
      }),
    ).toEqual([]);
  });

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
