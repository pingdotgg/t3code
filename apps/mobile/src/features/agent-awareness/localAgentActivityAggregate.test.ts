import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildLocalAgentActivityAggregate } from "./localAgentActivityAggregate";

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

describe("buildLocalAgentActivityAggregate", () => {
  it("returns null when no threads are actively working", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const aggregate = buildLocalAgentActivityAggregate({
      projects: [project],
      threads: [
        makeThread({
          environmentId,
          id: ThreadId.make("thread-1"),
          projectId: project.id,
          title: "Idle thread",
        }),
      ],
    });
    expect(aggregate).toBeNull();
  });

  it("aggregates running and approval threads with newest activity first", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const project = makeProject({
      environmentId,
      id: ProjectId.make("project-1"),
      title: "T3 Code",
    });
    const aggregate = buildLocalAgentActivityAggregate({
      projects: [project],
      threads: [
        makeThread({
          environmentId,
          id: ThreadId.make("thread-running"),
          projectId: project.id,
          title: "Running thread",
          updatedAt: "2026-06-29T10:00:00.000Z",
          session: {
            threadId: ThreadId.make("thread-running"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-06-29T10:00:00.000Z",
          },
        }),
        makeThread({
          environmentId,
          id: ThreadId.make("thread-approval"),
          projectId: project.id,
          title: "Approval thread",
          updatedAt: "2026-06-29T11:00:00.000Z",
          hasPendingApprovals: true,
        }),
      ],
    });

    expect(aggregate).toEqual({
      title: "T3 Code",
      subtitle: "Agent work in progress",
      activeCount: 2,
      updatedAt: "2026-06-29T11:00:00.000Z",
      activities: [
        expect.objectContaining({
          threadId: ThreadId.make("thread-approval"),
          phase: "waiting_for_approval",
          status: "Approval",
        }),
        expect.objectContaining({
          threadId: ThreadId.make("thread-running"),
          phase: "running",
          status: "Working",
        }),
      ],
    });
  });
});
