import { describe, expect, it } from "vite-plus/test";

import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { buildNewTaskEnvironmentItems, buildNewTaskProjectItems } from "./newTaskPicker";

function makeProject(
  input: Partial<EnvironmentProject> & Pick<EnvironmentProject, "environmentId" | "id" | "title">,
): EnvironmentProject {
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
  input: Partial<EnvironmentThreadShell> &
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "title">,
): EnvironmentThreadShell {
  return {
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    settledOverride: null,
    settledAt: null,
    ...input,
  };
}

describe("new task picker", () => {
  const localEnvironmentId = EnvironmentId.make("environment-local");
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
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
  };
  const localProject = makeProject({
    environmentId: localEnvironmentId,
    id: ProjectId.make("project-local"),
    title: "T3 Code local",
    repositoryIdentity,
  });
  const remoteProject = makeProject({
    environmentId: remoteEnvironmentId,
    id: ProjectId.make("project-remote"),
    title: "T3 Code remote",
    repositoryIdentity,
  });
  const localThread = makeThread({
    environmentId: localEnvironmentId,
    id: ThreadId.make("thread-local"),
    projectId: localProject.id,
    title: "Recent local work",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  it("keeps project choices scoped to the selected environment", () => {
    const items = buildNewTaskProjectItems({
      environmentId: remoteEnvironmentId,
      projects: [localProject, remoteProject],
      threads: [localThread],
    });

    expect(items).toEqual([
      {
        environmentId: remoteEnvironmentId,
        id: remoteProject.id,
        key: repositoryIdentity.canonicalKey,
        title: remoteProject.title,
        workspaceRoot: remoteProject.workspaceRoot,
      },
    ]);
  });

  it("lists only environments with projects and counts logical projects per environment", () => {
    const scratchProject = makeProject({
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-scratch"),
      title: "Scratch",
    });

    const items = buildNewTaskEnvironmentItems({
      environments: [
        { environmentId: localEnvironmentId, environmentLabel: "Laptop" },
        {
          environmentId: remoteEnvironmentId,
          environmentLabel: "Build server",
        },
        {
          environmentId: EnvironmentId.make("environment-empty"),
          environmentLabel: "Empty server",
        },
      ],
      projects: [localProject, remoteProject, scratchProject],
      threads: [localThread],
    });

    expect(items).toEqual([
      {
        environmentId: localEnvironmentId,
        environmentLabel: "Laptop",
        projectCount: 1,
      },
      {
        environmentId: remoteEnvironmentId,
        environmentLabel: "Build server",
        projectCount: 2,
      },
    ]);
  });
});
