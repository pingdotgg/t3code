import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadContextId,
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
  it("preserves reference records in fork events and the forked read model", async () => {
    const readModel = createReadModel();
    const source = readModel.threads[0]!;
    const context = {
      version: 1 as const,
      records: [
        {
          version: 1 as const,
          kind: "thread" as const,
          contextId: ThreadContextId.make("ctx-fork"),
          label: "Reference",
          environmentId: EnvironmentId.make("env-fork"),
          threadId: ThreadId.make("reference-thread"),
          title: "Reference",
        },
      ],
    };
    const input = {
      ...readModel,
      threads: [
        {
          ...source,
          messages: source.messages.map((message) =>
            message.id === "user-1"
              ? { ...message, text: "see [Reference](t3-context://v1/thread/ctx-fork)", context }
              : message,
          ),
        },
      ],
    };
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: input,
        command: {
          type: "thread.fork",
          commandId: CommandId.make("fork-context"),
          sourceThreadId,
          threadId: forkThreadId,
          targetMessageId: MessageId.make("assistant-1"),
          createdAt: "2025-01-01T00:01:00.000Z",
        },
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    const sent = events.filter((event) => event.type === "thread.message-sent");
    expect(sent[0]?.payload).toMatchObject({ context });
    let projected: OrchestrationReadModel = input;
    for (const [index, event] of events.entries()) {
      projected = await Effect.runPromise(
        projectEvent(projected, { ...event, sequence: index + 1 }),
      );
    }
    expect(
      projected.threads.find((thread) => thread.id === forkThreadId)?.messages[0]?.context,
    ).toEqual(context);
  });
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
      "thread.provider-fork-requested",
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

  it("rejects a fork while the source provider run is still in progress", async () => {
    const baseReadModel = createReadModel();
    const sourceThread = baseReadModel.threads[0];
    if (!sourceThread) throw new Error("missing source thread");
    const runningTurnId = TurnId.make("turn-running");
    const readModel: OrchestrationReadModel = {
      ...baseReadModel,
      threads: [
        {
          ...sourceThread,
          latestTurn: {
            turnId: runningTurnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            threadId: sourceThreadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: runningTurnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ],
    };

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.fork",
            commandId: CommandId.make("fork-command-running"),
            sourceThreadId,
            threadId: forkThreadId,
            targetMessageId: MessageId.make("assistant-1"),
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("running");
  });
});
