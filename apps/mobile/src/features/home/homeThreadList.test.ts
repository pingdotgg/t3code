import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeProjectScopes,
  buildHomeThreadGroups,
  sortHomeProjectScopes,
} from "./homeThreadList";

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
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
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

const NOW = Date.parse("2026-06-29T00:00:00.000Z");

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
    now: NOW,
    ...overrides,
  });
}

describe("buildHomeThreadGroups", () => {
  it("builds one v2 scope for the same repository across environments", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "t3code",
        repositoryIdentity,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote"),
        title: "t3code",
        repositoryIdentity,
      }),
    ];

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.projects).toEqual(projects);
    expect(scopes[0]?.projectRefs).toEqual(
      projects.map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
      })),
    );
  });

  it("routes stale duplicate project refs through the canonical repository group", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const local = makeProject({
      id: ProjectId.make("project-local"),
      environmentId: localEnvironmentId,
      title: "t3code",
      workspaceRoot: "/workspaces/t3code",
      repositoryIdentity,
    });
    const stale = makeProject({
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-stale"),
      title: "t3code",
      workspaceRoot: "/remote/t3code",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const canonicalRemote = makeProject({
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-canonical-remote"),
      title: "t3code",
      workspaceRoot: "/remote/t3code/",
      repositoryIdentity,
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    const projects = [local, stale, canonicalRemote];
    const staleThread = makeThread({
      environmentId: remoteEnvironmentId,
      id: ThreadId.make("thread-stale-project-ref"),
      projectId: stale.id,
      title: "Still visible",
      updatedAt: "2026-06-03T00:00:00.000Z",
    });

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });
    const groups = buildGroups(projects, [staleThread]);

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.projects.map((project) => project.id)).toEqual([
      local.id,
      canonicalRemote.id,
    ]);
    expect(scopes[0]?.projectRefs.map((projectRef) => projectRef.projectId)).toEqual([
      local.id,
      stale.id,
      canonicalRemote.id,
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual([staleThread.id]);
    expect(groups[0]?.newThreadTarget?.id).toBe(canonicalRemote.id);
  });

  it("keeps repository identity from an older duplicate when the freshness winner lacks it", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "t3code",
        repositoryIdentity,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-with-identity"),
        title: "t3code",
        workspaceRoot: "/remote/t3code",
        repositoryIdentity,
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-fresh"),
        title: "t3code",
        workspaceRoot: "/remote/t3code/",
        updatedAt: "2026-06-02T00:00:00.000Z",
      }),
    ];

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.representative.id).toBe(ProjectId.make("project-local"));
    expect(scopes[0]?.projects.map((project) => project.id)).toContain(
      ProjectId.make("project-remote-fresh"),
    );
    expect(scopes[0]?.projectRefs).toHaveLength(3);
  });

  it("sorts v2 project scopes by their grouped thread activity", () => {
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
    const scopes = buildHomeProjectScopes({
      projects: [newerProject, olderProject],
      environmentId: null,
      projectGroupingMode: "separate",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [
          makeThread({
            environmentId,
            id: ThreadId.make("thread-older-project"),
            projectId: olderProject.id,
            title: "Most recently active",
            updatedAt: "2026-06-03T00:00:00.000Z",
          }),
          makeThread({
            environmentId,
            id: ThreadId.make("thread-newer-project"),
            projectId: newerProject.id,
            title: "Less recently active",
            updatedAt: "2026-06-02T00:00:00.000Z",
          }),
        ],
        pendingTasks: [],
        projectSortOrder: "updated_at",
      }).map((scope) => scope.representative.id),
    ).toEqual([olderProject.id, newerProject.id]);
  });

  it("sorts invalid project creation timestamps after valid ones", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const invalidProject = makeProject({
      environmentId,
      id: ProjectId.make("project-invalid"),
      title: "A invalid timestamp",
      createdAt: "invalid",
    });
    const validProject = makeProject({
      environmentId,
      id: ProjectId.make("project-valid"),
      title: "Z valid timestamp",
      createdAt: "2026-06-02T00:00:00.000Z",
    });
    const scopes = buildHomeProjectScopes({
      projects: [invalidProject, validProject],
      environmentId: null,
      projectGroupingMode: "separate",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [],
        pendingTasks: [],
        projectSortOrder: "created_at",
      }).map((scope) => scope.representative.id),
    ).toEqual([validProject.id, invalidProject.id]);
  });

  it("uses the freshest member when a grouped scope has no activity", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const olderMember = makeProject({
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-older-member"),
      title: "t3code",
      updatedAt: "2026-06-01T00:00:00.000Z",
      repositoryIdentity,
    });
    const newerMember = makeProject({
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-newer-member"),
      title: "t3code",
      updatedAt: "2026-06-03T00:00:00.000Z",
      repositoryIdentity,
    });
    const otherProject = makeProject({
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-other"),
      title: "other",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    const scopes = buildHomeProjectScopes({
      projects: [olderMember, newerMember, otherProject],
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [],
        pendingTasks: [],
        projectSortOrder: "updated_at",
      })[0]?.key,
    ).toBe(scopes.find((scope) => scope.projects.length === 2)?.key);
  });

  it("does not merge unrelated repositories that share a title", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projects = ["one", "two"].map((name) =>
      makeProject({
        environmentId,
        id: ProjectId.make(`project-${name}`),
        title: "app",
        repositoryIdentity: {
          canonicalKey: `github.com/example/${name}`,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: `git@github.com:example/${name}.git`,
          },
        },
      }),
    );

    expect(
      buildHomeProjectScopes({
        projects,
        environmentId: null,
        projectGroupingMode: "repository",
      }),
    ).toHaveLength(2);
  });

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

  it("matches web repository, repository-path, and separate grouping modes", () => {
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
        id: ProjectId.make("project-web"),
        title: "Web",
        workspaceRoot: "/workspaces/t3code/apps/web",
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

  it("default view shows only threads from the last 5 days", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = [
      makeThread({
        environmentId,
        id: ThreadId.make("recent-1"),
        projectId: project.id,
        title: "Today",
        updatedAt: "2026-06-28T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("recent-2"),
        projectId: project.id,
        title: "Within window",
        updatedAt: "2026-06-25T00:00:00.000Z",
      }),
      makeThread({
        environmentId,
        id: ThreadId.make("old"),
        projectId: project.id,
        title: "Two weeks ago",
        updatedAt: "2026-06-14T00:00:00.000Z",
      }),
    ];

    const group = buildGroups([project], threads)[0];
    // Default view trims to recent threads...
    expect(group?.recentThreads.map((thread) => thread.id)).toEqual(["recent-1", "recent-2"]);
    // ...while full history stays available for the expanded view.
    expect(group?.threads.map((thread) => thread.id)).toEqual(["recent-1", "recent-2", "old"]);
  });

  it("falls back to the most recent 3 threads when none are within 5 days", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"].map(
      (day, index) =>
        makeThread({
          environmentId,
          id: ThreadId.make(`thread-${index}`),
          projectId: project.id,
          title: `Thread ${index}`,
          updatedAt: `${day}T00:00:00.000Z`,
        }),
    );

    const group = buildGroups([project], threads)[0];
    expect(group?.recentThreads.map((thread) => thread.id)).toEqual([
      "thread-4",
      "thread-3",
      "thread-2",
    ]);
    expect(group?.threads).toHaveLength(5);
  });

  it("does not apply the recency window while searching", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const threads = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"].map(
      (day, index) =>
        makeThread({
          environmentId,
          id: ThreadId.make(`thread-${index}`),
          projectId: project.id,
          title: `Thread ${index}`,
          updatedAt: `${day}T00:00:00.000Z`,
        }),
    );

    const group = buildGroups([project], threads, { searchQuery: "T3 Code" })[0];
    // Search reaches the full history rather than the 3-thread fallback.
    expect(group?.recentThreads).toHaveLength(5);
    expect(group?.recentThreads.map((thread) => thread.id)).toEqual(
      group?.threads.map((thread) => thread.id),
    );
  });

  it("targets quick new threads at the group member with the newest thread", () => {
    const laptopEnv = EnvironmentId.make("environment-laptop");
    const desktopEnv = EnvironmentId.make("environment-desktop");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const laptopProject = makeProject({
      environmentId: laptopEnv,
      id: ProjectId.make("project-laptop"),
      title: "t3code",
      repositoryIdentity,
    });
    const desktopProject = makeProject({
      environmentId: desktopEnv,
      id: ProjectId.make("project-desktop"),
      title: "t3code",
      repositoryIdentity,
    });
    const threads = [
      makeThread({
        environmentId: laptopEnv,
        id: ThreadId.make("thread-laptop"),
        projectId: laptopProject.id,
        title: "Older laptop thread",
        updatedAt: "2026-06-27T00:00:00.000Z",
      }),
      makeThread({
        environmentId: desktopEnv,
        id: ThreadId.make("thread-desktop"),
        projectId: desktopProject.id,
        title: "Newest desktop thread",
        updatedAt: "2026-06-28T00:00:00.000Z",
      }),
    ];

    // Aggregated into one group by repository; the quick new-thread target
    // must follow the newest thread (desktop), not the arbitrary first member.
    const groups = buildGroups([laptopProject, desktopProject], threads);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.projects).toHaveLength(2);
    expect(groups[0]?.newThreadTarget?.environmentId).toBe(desktopEnv);
    expect(groups[0]?.newThreadTarget?.id).toBe(desktopProject.id);
  });
});
