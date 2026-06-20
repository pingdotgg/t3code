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
});
