import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationQueuedTurn,
  type OrchestrationReadModel,
} from "@forma/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-03-01T00:00:00.000Z";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

function makeProject(projectId: ProjectId) {
  return {
    id: projectId,
    title: `Project ${projectId}`,
    workspaceRoot: `/tmp/${projectId}`,
    defaultModelSelection: {
      provider: "codex" as const,
      model: "gpt-5-codex",
    },
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function makeQueuedTurn(
  messageId: string,
  overrides: Partial<OrchestrationQueuedTurn> = {},
): OrchestrationQueuedTurn {
  return {
    messageId: asMessageId(messageId),
    text: `queued:${messageId}`,
    attachmentIds: [],
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    titleSeed: null,
    sourceProposedPlan: null,
    queuedAt: NOW,
    ...overrides,
  };
}

function makeThread(
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: threadId,
    projectId,
    title: `Thread ${threadId}`,
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    turnQueue: {
      items: [],
      status: "idle",
      pauseReason: null,
    },
    session: null,
    ...overrides,
  };
}

function makeReadModel(input?: {
  threads?: ReadonlyArray<OrchestrationReadModel["threads"][number]>;
  projects?: ReadonlyArray<OrchestrationReadModel["projects"][number]>;
}): OrchestrationReadModel {
  const defaultProject = makeProject(asProjectId("project-1"));
  const defaultThread = makeThread(asThreadId("thread-1"), defaultProject.id);
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: Array.from(input?.projects ?? [defaultProject]),
    threads: Array.from(input?.threads ?? [defaultThread]),
  };
}

describe("decider queue commands", () => {
  it("starts immediately when the thread is idle and enqueues when the session is busy", async () => {
    const immediateResult = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: makeReadModel(),
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-immediate"),
          threadId: asThreadId("thread-1"),
          message: {
            messageId: asMessageId("message-immediate"),
            role: "user",
            text: "Ship it",
            attachments: [],
          },
          interactionMode: "plan",
          runtimeMode: "approval-required",
          createdAt: NOW,
        },
      }),
    );

    expect(Array.isArray(immediateResult)).toBe(true);
    expect(immediateResult).toHaveLength(2);
    if (!Array.isArray(immediateResult)) {
      return;
    }
    expect(immediateResult[0]?.type).toBe("thread.message-sent");
    expect(immediateResult[1]?.type).toBe("thread.turn-start-requested");
    expect(immediateResult[1]).toMatchObject({
      payload: {
        threadId: asThreadId("thread-1"),
        messageId: asMessageId("message-immediate"),
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
      },
    });

    const busyReadModel = makeReadModel({
      threads: [
        makeThread(asThreadId("thread-1"), asProjectId("project-1"), {
          session: {
            threadId: asThreadId("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: asTurnId("turn-active"),
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ],
    });

    const queuedResult = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: busyReadModel,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-queued"),
          threadId: asThreadId("thread-1"),
          message: {
            messageId: asMessageId("message-queued"),
            role: "user",
            text: "Queue me",
            attachments: [],
          },
          interactionMode: "plan",
          runtimeMode: "approval-required",
          titleSeed: "Queued title",
          createdAt: NOW,
        },
      }),
    );

    expect(Array.isArray(queuedResult)).toBe(false);
    if (Array.isArray(queuedResult)) {
      return;
    }
    const queuedEvent = queuedResult as Exclude<typeof queuedResult, ReadonlyArray<unknown>>;
    expect(queuedEvent.type).toBe("thread.turn-enqueued");
    expect(queuedEvent.payload).toMatchObject({
      threadId: asThreadId("thread-1"),
      queuedTurn: {
        messageId: asMessageId("message-queued"),
        text: "Queue me",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        titleSeed: "Queued title",
        queuedAt: NOW,
      },
    });
  });

  it("promotes only the queue head and preserves the queued turn snapshot", async () => {
    const readModel = makeReadModel({
      threads: [
        makeThread(asThreadId("thread-1"), asProjectId("project-1"), {
          turnQueue: {
            items: [
              makeQueuedTurn("queued-1", {
                text: "Promote first",
                modelSelection: {
                  provider: "codex",
                  model: "gpt-5.4-codex",
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                titleSeed: "First queued title",
              }),
              makeQueuedTurn("queued-2", {
                text: "Promote second",
              }),
            ],
            status: "queued",
            pauseReason: null,
          },
        }),
      ],
    });

    const promoteResult = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.queue.promote",
          commandId: CommandId.make("cmd-promote-head"),
          threadId: asThreadId("thread-1"),
          messageId: asMessageId("queued-1"),
          promotedAt: "2026-03-01T00:00:05.000Z",
          createdAt: "2026-03-01T00:00:05.000Z",
        },
      }),
    );

    expect(Array.isArray(promoteResult)).toBe(true);
    expect(promoteResult).toHaveLength(3);
    if (!Array.isArray(promoteResult)) {
      return;
    }

    expect(promoteResult.map((event) => event.type)).toEqual([
      "thread.turn-queue-item-removed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(promoteResult[2]).toMatchObject({
      payload: {
        threadId: asThreadId("thread-1"),
        messageId: asMessageId("queued-1"),
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        titleSeed: "First queued title",
        createdAt: "2026-03-01T00:00:05.000Z",
      },
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.turn.queue.promote",
            commandId: CommandId.make("cmd-promote-non-head"),
            threadId: asThreadId("thread-1"),
            messageId: asMessageId("queued-2"),
            promotedAt: "2026-03-01T00:00:05.000Z",
            createdAt: "2026-03-01T00:00:05.000Z",
          },
        }),
      ),
    ).rejects.toThrow("not the queue head");
  });

  it("rejects missing, cross-project, and already-implemented source plans", async () => {
    const projectOne = makeProject(asProjectId("project-1"));
    const projectTwo = makeProject(asProjectId("project-2"));
    const targetThread = makeThread(asThreadId("thread-target"), projectOne.id);
    const sourceThread = makeThread(asThreadId("thread-source"), projectOne.id, {
      proposedPlans: [
        {
          id: "plan-implemented",
          turnId: null,
          planMarkdown: "# already done",
          implementedAt: "2026-03-01T00:00:02.000Z",
          implementationThreadId: asThreadId("thread-impl"),
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    const otherProjectSourceThread = makeThread(asThreadId("thread-other-project"), projectTwo.id, {
      proposedPlans: [
        {
          id: "plan-other",
          turnId: null,
          planMarkdown: "# other project",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });

    const readModel = makeReadModel({
      projects: [projectOne, projectTwo],
      threads: [
        targetThread,
        sourceThread,
        otherProjectSourceThread,
        makeThread(asThreadId("thread-queued"), projectOne.id, {
          turnQueue: {
            items: [
              makeQueuedTurn("queued-invalid", {
                sourceProposedPlan: {
                  threadId: asThreadId("thread-source"),
                  planId: "plan-implemented",
                },
              }),
            ],
            status: "queued",
            pauseReason: null,
          },
        }),
      ],
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-start-missing-plan"),
            threadId: targetThread.id,
            message: {
              messageId: asMessageId("message-missing-plan"),
              role: "user",
              text: "Missing plan",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            sourceProposedPlan: {
              threadId: sourceThread.id,
              planId: "plan-missing",
            },
            createdAt: NOW,
          },
        }),
      ),
    ).rejects.toThrow("does not exist");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-start-cross-project-plan"),
            threadId: targetThread.id,
            message: {
              messageId: asMessageId("message-cross-project-plan"),
              role: "user",
              text: "Cross project plan",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            sourceProposedPlan: {
              threadId: otherProjectSourceThread.id,
              planId: "plan-other",
            },
            createdAt: NOW,
          },
        }),
      ),
    ).rejects.toThrow("different project");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.turn.queue.promote",
            commandId: CommandId.make("cmd-promote-implemented-plan"),
            threadId: asThreadId("thread-queued"),
            messageId: asMessageId("queued-invalid"),
            promotedAt: "2026-03-01T00:00:05.000Z",
            createdAt: "2026-03-01T00:00:05.000Z",
          },
        }),
      ),
    ).rejects.toThrow("already been implemented");
  });

  it("removes queued items and resumes paused queues", async () => {
    const readModel = makeReadModel({
      threads: [
        makeThread(asThreadId("thread-1"), asProjectId("project-1"), {
          turnQueue: {
            items: [makeQueuedTurn("queued-1")],
            status: "paused",
            pauseReason: "error",
          },
        }),
      ],
    });

    const removeResult = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.queue.remove",
          commandId: CommandId.make("cmd-remove-queued"),
          threadId: asThreadId("thread-1"),
          messageId: asMessageId("queued-1"),
        },
      }),
    );
    expect(Array.isArray(removeResult)).toBe(false);
    if (Array.isArray(removeResult)) {
      return;
    }
    expect(removeResult).toMatchObject({
      type: "thread.turn-queue-item-removed",
      payload: {
        threadId: asThreadId("thread-1"),
        messageId: asMessageId("queued-1"),
        reason: "removed",
      },
    });

    const resumeResult = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.queue.resume",
          commandId: CommandId.make("cmd-resume-queue"),
          threadId: asThreadId("thread-1"),
        },
      }),
    );
    expect(Array.isArray(resumeResult)).toBe(false);
    if (Array.isArray(resumeResult)) {
      return;
    }
    expect(resumeResult).toMatchObject({
      type: "thread.turn-queue-resumed",
      payload: {
        threadId: asThreadId("thread-1"),
      },
    });
  });

  it("blocks archive and checkpoint revert while queued turns exist", async () => {
    const readModel = makeReadModel({
      threads: [
        makeThread(asThreadId("thread-1"), asProjectId("project-1"), {
          turnQueue: {
            items: [makeQueuedTurn("queued-1")],
            status: "queued",
            pauseReason: null,
          },
        }),
      ],
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.archive",
            commandId: CommandId.make("cmd-archive-blocked"),
            threadId: asThreadId("thread-1"),
          },
        }),
      ),
    ).rejects.toThrow("queued turns");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.checkpoint.revert",
            commandId: CommandId.make("cmd-revert-blocked"),
            threadId: asThreadId("thread-1"),
            turnCount: 1,
            createdAt: NOW,
          },
        }),
      ),
    ).rejects.toThrow("queued turns");
  });
});
