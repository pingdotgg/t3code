import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveArchivedThreadDeletionContext } from "./archivedThreadsState";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

function makeThread(id: string, worktreePath: string): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: `t3/${id}`,
    worktreePath,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    archivedAt: "2026-08-03T00:00:00.000Z",
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const target = makeThread("target", "/repo/.t3/worktrees/shared");
const sibling = makeThread("sibling", "/repo/.t3/worktrees/shared");
const snapshot = {
  snapshotSequence: 1,
  projects: [
    {
      id: projectId,
      title: "Project",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    },
  ],
  threads: [target, sibling],
  updatedAt: "2026-08-03T00:00:00.000Z",
} satisfies OrchestrationShellSnapshot;

describe("resolveArchivedThreadDeletionContext", () => {
  it("restores the archived thread, project cwd, and worktree-sharing siblings", () => {
    const context = resolveArchivedThreadDeletionContext(snapshot, {
      environmentId,
      threadId: target.id,
    });

    expect(context).toMatchObject({
      thread: { id: target.id, environmentId },
      projectCwd: "/repo",
    });
    expect(context?.threads.map((thread) => thread.id)).toEqual([target.id, sibling.id]);
  });

  it("returns null when the archived snapshot does not contain the thread", () => {
    expect(
      resolveArchivedThreadDeletionContext(snapshot, {
        environmentId,
        threadId: ThreadId.make("missing"),
      }),
    ).toBeNull();
  });
});
