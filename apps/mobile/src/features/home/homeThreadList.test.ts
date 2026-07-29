import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHomeThreadGroups } from "./homeThreadList";

function makeProject(
  input: Partial<EnvironmentProject> & Pick<EnvironmentProject, "environmentId" | "id" | "title">,
): EnvironmentProject {
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
  input: Partial<EnvironmentThreadShell> &
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "title">,
): EnvironmentThreadShell {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    executorModelSelection: null,
    executorMaxSubAgents: 3,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    autoReviewPhase: null,
    ...input,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedAt ?? null,
  };
}

function buildGroups(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  overrides: Partial<Parameters<typeof buildHomeThreadGroups>[0]> = {},
) {
  return buildHomeThreadGroups({
    projects,
    threads,
    environmentId: null,
    searchQuery: "",
    projectSortOrder: "updated_at",
    threadSortOrder: "updated_at",
    projectGroupingMode: "repository",
    ...overrides,
  });
}

describe("buildHomeThreadGroups", () => {
  it("sorts the newest thread first regardless of snapshot order", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = [
      makeThread({
        environmentId,
        id: ThreadId.make("thread-old"),
        projectId: project.id,
        title: "Older thread",
        updatedAt: "2026-06-02T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("thread-new"),
        projectId: project.id,
        title: "Newer thread",
        updatedAt: "2026-06-03T00:00:00.000Z",
      }),
    ];

    expect(buildGroups([project], threads)[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-new",
      "thread-old",
    ]);
  });

  it("supports independent project and thread creation-time sorting", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const olderProject = makeProject({
      environmentId,
      id: ProjectId.make("project-older"),
      title: "Older project",
    });
    const newerProject = makeProject({
      environmentId,
      id: ProjectId.make("project-newer"),
      title: "Newer project",
    });
    const threads = [
      makeThread({
        environmentId,
        id: ThreadId.make("old-created"),
        projectId: olderProject.id,
        title: "Updated recently",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("new-created"),
        projectId: olderProject.id,
        title: "Created recently",
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("newest-project-thread"),
        projectId: newerProject.id,
        title: "Newest project",
        createdAt: "2026-06-06T00:00:00.000Z",
      }),
    ];

    const groups = buildGroups([olderProject, newerProject], threads, {
      projectSortOrder: "created_at",
      threadSortOrder: "created_at",
      projectGroupingMode: "separate",
    });

    expect(groups.map((group) => group.representative.id)).toEqual([
      "project-newer",
      "project-older",
    ]);
    expect(groups[1]?.threads.map((thread) => thread.id)).toEqual(["new-created", "old-created"]);
  });

  it("filters both projects and threads to one environment", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "Local",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote"),
        title: "Remote",
      }),
    ];
    const threads = projects.map((project) =>
      makeThread({
        environmentId: project.environmentId,
        id: ThreadId.make(`thread-${project.id}`),
        projectId: project.id,
        title: project.title,
      }),
    );

    const groups = buildGroups(projects, threads, { environmentId: remoteEnvironmentId });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.representative.environmentId).toBe(remoteEnvironmentId);
    expect(groups[0]?.threads.map((thread) => thread.environmentId)).toEqual([remoteEnvironmentId]);
  });

  it("supports repository, repository-path, and separate grouping modes", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const repositoryIdentity = {
      canonicalKey: "github.com/t3tools/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:t3tools/t3code.git",
      },
      provider: "github",
      owner: "t3tools",
      name: "t3code",
      displayName: "T3 Code",
      rootPath: "/workspaces/t3code",
    };
    const projects = [
      makeProject({
        environmentId,
        id: ProjectId.make("project-mac"),
        title: "Mac",
        workspaceRoot: "/workspaces/t3code/apps/mac",
        repositoryIdentity,
      }),
      makeProject({
        environmentId,
        id: ProjectId.make("project-mobile"),
        title: "Mobile",
        workspaceRoot: "/workspaces/t3code/apps/mobile",
        repositoryIdentity,
      }),
    ];
    const threads = projects.map((project) =>
      makeThread({
        environmentId,
        id: ThreadId.make(`thread-${project.id}`),
        projectId: project.id,
        title: project.title,
      }),
    );

    expect(buildGroups(projects, threads, { projectGroupingMode: "repository" })).toHaveLength(1);
    expect(buildGroups(projects, threads, { projectGroupingMode: "repository_path" })).toHaveLength(
      2,
    );
    expect(buildGroups(projects, threads, { projectGroupingMode: "separate" })).toHaveLength(2);
  });

  it("moves settled threads out of the inbox list into settledThreads", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = [
      makeThread({
        environmentId,
        id: ThreadId.make("thread-active"),
        projectId: project.id,
        title: "Active thread",
        updatedAt: "2026-06-09T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("thread-settled-old"),
        projectId: project.id,
        title: "Settled earlier",
        settledOverride: "settled",
        settledAt: "2026-06-07T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("thread-settled-new"),
        projectId: project.id,
        title: "Settled later",
        settledOverride: "settled",
        settledAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z",
      }),
    ];

    const groups = buildGroups([project], threads, { now: "2026-06-10T00:00:00.000Z" });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["thread-active"]);
    // Most recently settled first (mac sortSettled).
    expect(groups[0]?.settledThreads.map((thread) => thread.id)).toEqual([
      "thread-settled-new",
      "thread-settled-old",
    ]);
  });

  it("auto-settles threads past the inactivity window", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const stale = makeThread({
      environmentId,
      id: ThreadId.make("thread-stale"),
      projectId: project.id,
      title: "Stale thread",
      latestUserMessageAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });

    const groups = buildGroups([project], [stale], { now: "2026-06-10T00:00:00.000Z" });

    expect(groups[0]?.threads).toEqual([]);
    expect(groups[0]?.settledThreads.map((thread) => thread.id)).toEqual(["thread-stale"]);
  });

  it("keeps a group reachable when every thread is settled", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const settled = makeThread({
      environmentId,
      id: ThreadId.make("thread-settled"),
      projectId: project.id,
      title: "Settled thread",
      settledOverride: "settled",
      settledAt: "2026-06-08T00:00:00.000Z",
    });

    const groups = buildGroups([project], [settled], { now: "2026-06-10T00:00:00.000Z" });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads).toEqual([]);
    expect(groups[0]?.settledThreads).toHaveLength(1);
  });

  it("moves a snoozed thread out of the inbox while its wake time is in the future", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = [
      makeThread({
        environmentId,
        id: ThreadId.make("thread-active"),
        projectId: project.id,
        title: "Active thread",
        updatedAt: "2026-06-09T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("thread-snoozed"),
        projectId: project.id,
        title: "Snoozed thread",
        updatedAt: "2026-06-09T00:00:00.000Z",
        snoozedUntil: "2026-06-11T09:00:00.000Z",
        snoozedAt: "2026-06-09T00:00:00.000Z",
      }),
    ];

    const groups = buildGroups([project], threads, { now: "2026-06-10T00:00:00.000Z" });

    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["thread-active"]);
    expect(groups[0]?.settledThreads.map((thread) => thread.id)).toEqual(["thread-snoozed"]);
  });

  it("reappears in the active list once the snooze wake time has passed", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const woken = makeThread({
      environmentId,
      id: ThreadId.make("thread-woken"),
      projectId: project.id,
      title: "Woken thread",
      updatedAt: "2026-06-09T00:00:00.000Z",
      snoozedUntil: "2026-06-09T09:00:00.000Z",
      snoozedAt: "2026-06-08T00:00:00.000Z",
    });

    // `now` is past the wake time — no unsnooze event required, the stale
    // snoozedUntil simply stops classifying the thread as snoozed.
    const groups = buildGroups([project], [woken], { now: "2026-06-10T00:00:00.000Z" });

    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["thread-woken"]);
    expect(groups[0]?.settledThreads).toEqual([]);
  });

  it("keeps a raised-hand snoozed thread (pending approval) in the active list", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const blocked = makeThread({
      environmentId,
      id: ThreadId.make("thread-blocked"),
      projectId: project.id,
      title: "Blocked thread",
      updatedAt: "2026-06-09T00:00:00.000Z",
      hasPendingApprovals: true,
      snoozedUntil: "2026-06-11T09:00:00.000Z",
      snoozedAt: "2026-06-09T00:00:00.000Z",
    });

    const groups = buildGroups([project], [blocked], { now: "2026-06-10T00:00:00.000Z" });

    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["thread-blocked"]);
    expect(groups[0]?.settledThreads).toEqual([]);
  });

  it("applies the search query to settled threads as well", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = [
      makeThread({
        environmentId,
        id: ThreadId.make("thread-active"),
        projectId: project.id,
        title: "Active thread",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("thread-settled"),
        projectId: project.id,
        title: "Settled needle",
        settledOverride: "settled",
        settledAt: "2026-06-08T00:00:00.000Z",
      }),
    ];

    const groups = buildGroups([project], threads, {
      now: "2026-06-10T00:00:00.000Z",
      searchQuery: "needle",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads).toEqual([]);
    expect(groups[0]?.settledThreads.map((thread) => thread.id)).toEqual(["thread-settled"]);
  });
});
