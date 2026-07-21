import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2025-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const parentThreadId = ThreadId.make("parent-thread");

function createReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [projectId, otherProjectId].map((id) => ({
      id,
      title: id,
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })),
    threads: [
      {
        id: parentThreadId,
        projectId,
        parentThreadId: null,
        title: "Parent",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        pendingRuntimeMode: null,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

function createCommand(
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.create" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.create" }> {
  return {
    type: "thread.create",
    commandId: CommandId.make("create-child"),
    threadId: ThreadId.make("child-thread"),
    projectId,
    parentThreadId,
    title: "Child",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
    ...overrides,
  };
}

describe("decider thread.create hierarchy", () => {
  it("creates a child under an active parent in the same project", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command: createCommand(), readModel: createReadModel() }),
    );
    const events = Array.isArray(result) ? result : [result];

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "thread.created",
      payload: { parentThreadId },
    });
  });

  it("rejects a parent from another project", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: createCommand({ projectId: otherProjectId }),
          readModel: createReadModel(),
        }),
      ),
    ).rejects.toThrow("belongs to a different project");
  });

  it("rejects a deleted parent", async () => {
    const readModel = createReadModel();
    const parent = readModel.threads[0];
    if (!parent) throw new Error("missing parent thread");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: createCommand(),
          readModel: {
            ...readModel,
            threads: [{ ...parent, deletedAt: now }],
          },
        }),
      ),
    ).rejects.toThrow("is deleted");
  });
});
