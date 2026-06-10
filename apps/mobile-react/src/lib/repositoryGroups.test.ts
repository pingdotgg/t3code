import { describe, expect, it } from "vitest";

import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { groupProjectsByRepository } from "./repositoryGroups";
import {
  EnvironmentScopedProjectShell,
  EnvironmentScopedThreadShell,
} from "@t3tools/client-runtime";

function makeProject(
  input: Partial<EnvironmentScopedProjectShell> &
    Pick<EnvironmentScopedProjectShell, "environmentId" | "id" | "title">,
): EnvironmentScopedProjectShell {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(
  input: Partial<EnvironmentScopedThreadShell> &
    Pick<
      EnvironmentScopedThreadShell,
      "environmentId" | "id" | "projectId" | "title" | "modelSelection"
    >,
): EnvironmentScopedThreadShell {
  return {
    runtimeMode: "full-access",
    interactionMode: "default",
    pendingRuntimeMode: null,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("groupProjectsByRepository", () => {
  it("groups projects across environments by repository identity", () => {
    const repoIdentity = {
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
    };

    const projects = [
      makeProject({
        environmentId: EnvironmentId.make("env-local"),
        id: ProjectId.make("project-local"),
        title: "T3 Code",
        repositoryIdentity: repoIdentity,
      }),
      makeProject({
        environmentId: EnvironmentId.make("env-staging"),
        id: ProjectId.make("project-staging"),
        title: "T3 Code",
        repositoryIdentity: repoIdentity,
      }),
    ];

    const threads = [
      makeThread({
        environmentId: EnvironmentId.make("env-staging"),
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-staging"),
        title: "Fix reconnect flow",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        updatedAt: "2026-04-02T12:00:00.000Z",
      }),
      makeThread({
        environmentId: EnvironmentId.make("env-local"),
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-local"),
        title: "Polish mobile shell",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        updatedAt: "2026-04-03T12:00:00.000Z",
      }),
    ];

    const groups = groupProjectsByRepository({ projects, threads });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "github.com/t3tools/t3code",
      title: "T3 Code",
      subtitle: "t3tools/t3code",
      projectCount: 2,
      threadCount: 2,
    });
    expect(
      groups[0]?.projects.map((entry) => ({
        environmentId: entry.project.environmentId,
        latestActivityAt: entry.latestActivityAt,
        threads: entry.threads.map((thread) => thread.id),
      })),
    ).toEqual([
      {
        environmentId: "env-local",
        latestActivityAt: "2026-04-03T12:00:00.000Z",
        threads: ["thread-1"],
      },
      {
        environmentId: "env-staging",
        latestActivityAt: "2026-04-02T12:00:00.000Z",
        threads: ["thread-2"],
      },
    ]);
    expect(groups[0]?.latestActivityAt).toBe("2026-04-03T12:00:00.000Z");
  });

  it("orders threads, projects, and repository groups by latest activity", () => {
    const projects = [
      makeProject({
        environmentId: EnvironmentId.make("env-local"),
        id: ProjectId.make("older-project"),
        title: "Older",
      }),
      makeProject({
        environmentId: EnvironmentId.make("env-local"),
        id: ProjectId.make("newer-project"),
        title: "Newer",
      }),
    ];

    const threads = [
      makeThread({
        environmentId: EnvironmentId.make("env-local"),
        id: ThreadId.make("older-thread"),
        projectId: ProjectId.make("older-project"),
        title: "Older thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        updatedAt: "2026-04-02T12:00:00.000Z",
      }),
      makeThread({
        environmentId: EnvironmentId.make("env-local"),
        id: ThreadId.make("newer-thread"),
        projectId: ProjectId.make("older-project"),
        title: "Newer thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        updatedAt: "2026-04-04T12:00:00.000Z",
      }),
      makeThread({
        environmentId: EnvironmentId.make("env-local"),
        id: ThreadId.make("newest-thread"),
        projectId: ProjectId.make("newer-project"),
        title: "Newest thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        updatedAt: "2026-04-05T12:00:00.000Z",
      }),
    ];

    const groups = groupProjectsByRepository({ projects, threads });

    expect(groups.map((group) => group.title)).toEqual(["Newer", "Older"]);
    expect(groups[1]?.projects[0]?.threads.map((thread) => thread.id)).toEqual([
      "newer-thread",
      "older-thread",
    ]);
  });

  it("falls back to a scoped project key when repository identity is unavailable", () => {
    const projects = [
      makeProject({
        environmentId: EnvironmentId.make("env-local"),
        id: ProjectId.make("project-local"),
        title: "Scratchpad",
      }),
    ];

    const groups = groupProjectsByRepository({ projects, threads: [] });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("env-local:project-local");
    expect(groups[0]?.title).toBe("Scratchpad");
    expect(groups[0]?.subtitle).toBeNull();
  });
});
