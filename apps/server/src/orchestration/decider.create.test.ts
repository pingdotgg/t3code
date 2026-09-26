import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
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

  it("records a batch wait in the same transaction that creates its first child", async () => {
    const childThreadId = ThreadId.make("child-thread");
    const assignmentId = MessageId.make("child-assignment");
    const parentWait = {
      mode: "all" as const,
      assignments: [{ childThreadId, assignmentId }],
    };
    const command = {
      ...createCommand({
        threadId: childThreadId,
        delegation: {
          assignmentId,
          followUp: "automatic",
          completedAt: null,
        },
      }),
      parentWait,
    };
    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command, readModel: createReadModel() }),
    );
    const events = Array.isArray(result) ? result : [result];

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.created",
          payload: expect.objectContaining({ threadId: childThreadId, parentThreadId }),
        }),
        expect.objectContaining({
          type: "thread.meta-updated",
          payload: expect.objectContaining({
            threadId: parentThreadId,
            nudging: expect.objectContaining({
              wait: { mode: "all", assignments: parentWait.assignments },
            }),
          }),
        }),
      ]),
    );
  });

  it("merges a new assignment into an unsatisfied wait of the same mode", async () => {
    const childThreadId = ThreadId.make("child-thread");
    const assignmentId = MessageId.make("child-assignment");
    const existingChildThreadId = ThreadId.make("existing-child");
    const existingAssignmentId = MessageId.make("existing-assignment");
    const outstandingChildThreadId = ThreadId.make("outstanding-child");
    const outstandingAssignmentId = MessageId.make("outstanding-assignment");
    const generationId = CommandId.make("existing-generation");
    const deadlineAt = "2025-01-01T00:10:00.000Z";
    const readModel = createReadModel();
    const parent = readModel.threads[0]!;
    const existingChild = {
      ...parent,
      id: existingChildThreadId,
      parentThreadId,
      title: "Existing child",
      nudging: {
        delegation: {
          assignmentId: existingAssignmentId,
          followUp: "automatic" as const,
          completedAt: now,
          outcome: "failed" as const,
        },
      },
    };
    const outstandingChild = {
      ...parent,
      id: outstandingChildThreadId,
      parentThreadId,
      title: "Outstanding child",
      nudging: {
        delegation: {
          assignmentId: outstandingAssignmentId,
          followUp: "automatic" as const,
          completedAt: null,
        },
      },
    };
    const state = {
      ...readModel,
      threads: [
        {
          ...parent,
          nudging: {
            wait: {
              mode: "all" as const,
              generationId,
              deadlineAt,
              assignments: [
                {
                  childThreadId: existingChildThreadId,
                  assignmentId: existingAssignmentId,
                  outcome: "failed" as const,
                },
                {
                  childThreadId: outstandingChildThreadId,
                  assignmentId: outstandingAssignmentId,
                },
              ],
            },
          },
        },
        existingChild,
        outstandingChild,
      ],
    };

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: createCommand({
          threadId: childThreadId,
          delegation: {
            assignmentId,
            followUp: "automatic",
            completedAt: null,
          },
          parentWait: {
            mode: "all",
            assignments: [{ childThreadId, assignmentId }],
          },
        }),
        readModel: state,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    const parentUpdate = events.find((event) => event.type === "thread.meta-updated");

    expect(parentUpdate).toMatchObject({
      payload: {
        nudging: {
          wait: {
            mode: "all",
            generationId,
            deadlineAt,
            assignments: [
              {
                childThreadId: existingChildThreadId,
                assignmentId: existingAssignmentId,
                outcome: "failed",
              },
              {
                childThreadId: outstandingChildThreadId,
                assignmentId: outstandingAssignmentId,
              },
              { childThreadId, assignmentId },
            ],
          },
        },
      },
    });
  });

  it.each(["all", "any"] as const)(
    "replaces a condition-met but unconsumed %s wait",
    async (mode) => {
      const childThreadId = ThreadId.make("child-thread");
      const assignmentId = MessageId.make("child-assignment");
      const completedChildThreadId = ThreadId.make("completed-child");
      const completedAssignmentId = MessageId.make("completed-assignment");
      const readModel = createReadModel();
      const parent = readModel.threads[0]!;

      const result = await Effect.runPromise(
        decideOrchestrationCommand({
          command: createCommand({
            threadId: childThreadId,
            delegation: {
              assignmentId,
              followUp: "automatic",
              completedAt: null,
            },
            parentWait: {
              mode,
              assignments: [{ childThreadId, assignmentId }],
            },
          }),
          readModel: {
            ...readModel,
            threads: [
              {
                ...parent,
                nudging: {
                  wait: {
                    mode,
                    assignments: [
                      {
                        childThreadId: completedChildThreadId,
                        assignmentId: completedAssignmentId,
                        outcome: "result-available",
                      },
                    ],
                  },
                },
              },
            ],
          },
        }),
      );
      const events = Array.isArray(result) ? result : [result];

      expect(events.find((event) => event.type === "thread.meta-updated")).toMatchObject({
        payload: {
          nudging: {
            wait: {
              mode,
              assignments: [{ childThreadId, assignmentId }],
            },
          },
        },
      });
    },
  );

  it("rejects a same-mode wait merge above the assignment cap", async () => {
    const readModel = createReadModel();
    const parent = readModel.threads[0]!;
    const assignments = Array.from({ length: 32 }, (_, index) => ({
      childThreadId: ThreadId.make(`existing-child-${index}`),
      assignmentId: MessageId.make(`existing-assignment-${index}`),
    }));
    const childThreadId = ThreadId.make("child-thread");
    const assignmentId = MessageId.make("child-assignment");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: createCommand({
            threadId: childThreadId,
            delegation: {
              assignmentId,
              followUp: "automatic",
              completedAt: null,
            },
            parentWait: {
              mode: "all",
              assignments: [{ childThreadId, assignmentId }],
            },
          }),
          readModel: {
            ...readModel,
            threads: [
              {
                ...parent,
                nudging: { wait: { mode: "all", assignments } },
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow("32");
  });

  it.each([
    {
      name: "the modes conflict",
      wait: {
        mode: "any" as const,
        assignments: [
          {
            childThreadId: ThreadId.make("previous-child"),
            assignmentId: MessageId.make("previous-assignment"),
          },
        ],
      },
    },
    {
      name: "the existing wait is already satisfied",
      wait: {
        mode: "all" as const,
        satisfiedAt: now,
        assignments: [
          {
            childThreadId: ThreadId.make("previous-child"),
            assignmentId: MessageId.make("previous-assignment"),
            outcome: "result-available" as const,
          },
        ],
      },
    },
  ])("replaces the existing wait when $name", async ({ wait }) => {
    const readModel = createReadModel();
    const parent = readModel.threads[0]!;
    const childThreadId = ThreadId.make("child-thread");
    const assignmentId = MessageId.make("child-assignment");
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: createCommand({
          threadId: childThreadId,
          delegation: {
            assignmentId,
            followUp: "automatic",
            completedAt: null,
          },
          parentWait: {
            mode: "all",
            assignments: [{ childThreadId, assignmentId }],
          },
        }),
        readModel: {
          ...readModel,
          threads: [{ ...parent, nudging: { wait } }],
        },
      }),
    );
    const events = Array.isArray(result) ? result : [result];

    expect(events.find((event) => event.type === "thread.meta-updated")).toMatchObject({
      payload: {
        nudging: {
          wait: {
            mode: "all",
            assignments: [{ childThreadId, assignmentId }],
          },
        },
      },
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
