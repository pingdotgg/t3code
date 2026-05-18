import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2025-01-01T00:00:00.000Z";
const sourceThreadId = ThreadId.make("source-thread");
const forkThreadId = ThreadId.make("fork-thread");
const projectId = ProjectId.make("project-1");

function createReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: sourceThreadId,
        projectId,
        title: "Original title",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        pendingRuntimeMode: null,
        branch: "main",
        worktreePath: "/tmp/project",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [
          {
            id: MessageId.make("user-1"),
            role: "user",
            text: "one",
            attachments: [],
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2025-01-01T00:00:01.000Z",
            updatedAt: "2025-01-01T00:00:01.000Z",
          },
          {
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "two",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2025-01-01T00:00:02.000Z",
            updatedAt: "2025-01-01T00:00:02.000Z",
          },
          {
            id: MessageId.make("user-2"),
            role: "user",
            text: "three",
            attachments: [],
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2025-01-01T00:00:03.000Z",
            updatedAt: "2025-01-01T00:00:03.000Z",
          },
          {
            id: MessageId.make("assistant-2"),
            role: "assistant",
            text: "four",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2025-01-01T00:00:04.000Z",
            updatedAt: "2025-01-01T00:00:04.000Z",
          },
        ],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

describe("decider thread.fork", () => {
  it("clones history only through the selected assistant response", async () => {
    const readModel = createReadModel();
    const command: Extract<OrchestrationCommand, { type: "thread.fork" }> = {
      type: "thread.fork",
      commandId: CommandId.make("fork-command"),
      sourceThreadId,
      threadId: forkThreadId,
      targetMessageId: MessageId.make("assistant-1"),
      createdAt: "2025-01-01T00:01:00.000Z",
    };

    const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
    const events = Array.isArray(result) ? result : [result];

    expect(events.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.message-sent",
      "thread.message-sent",
    ]);
    expect(events[0]?.payload).toMatchObject({
      threadId: forkThreadId,
      title: "Forked: Original title",
      branch: "main",
      worktreePath: "/tmp/project",
    });

    let projected = readModel;
    let sequence = 0;
    for (const event of events) {
      sequence += 1;
      projected = await Effect.runPromise(projectEvent(projected, { ...event, sequence }));
    }

    const sourceThread = projected.threads.find((thread) => thread.id === sourceThreadId);
    const forkThread = projected.threads.find((thread) => thread.id === forkThreadId);
    expect(sourceThread?.messages.map((message) => message.text)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    expect(forkThread?.messages.map((message) => message.text)).toEqual(["one", "two"]);
    expect(forkThread?.messages.map((message) => message.id)).not.toEqual([
      MessageId.make("user-1"),
      MessageId.make("assistant-1"),
    ]);
    expect(forkThread?.messages[0]?.turnId).toBe(forkThread?.messages[1]?.turnId);
  });

  it("rejects forking from a streaming assistant response", async () => {
    const baseReadModel = createReadModel();
    const sourceThread = baseReadModel.threads[0];
    if (!sourceThread) throw new Error("missing source thread");
    const readModel: OrchestrationReadModel = {
      ...baseReadModel,
      threads: [
        {
          ...sourceThread,
          messages: sourceThread.messages.map((message) =>
            message.id === MessageId.make("assistant-1")
              ? { ...message, streaming: true }
              : message,
          ),
        },
      ],
    };

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.fork",
            commandId: CommandId.make("fork-command"),
            sourceThreadId,
            threadId: forkThreadId,
            targetMessageId: MessageId.make("assistant-1"),
            createdAt: "2025-01-01T00:01:00.000Z",
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("still streaming");
  });
});
