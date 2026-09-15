import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-08-24T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-bootstrap");
const messageId = MessageId.make("message-bootstrap");

const readModelWithThread = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(createdAt), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-created"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Bootstrap thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
});

const appendCommand = {
  type: "thread.message.user.append" as const,
  commandId: CommandId.make("command-append"),
  threadId,
  message: { messageId, text: "Build it", attachments: [] },
  createdAt,
};

const turnStartCommand = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("command-turn-start"),
  threadId,
  message: { messageId, role: "user" as const, text: "Build it", attachments: [] },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt,
};

it.layer(NodeServices.layer)("thread.message.user.append", (it) => {
  it.effect("persists a user message without a turn, tagged as deferred", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const planned = yield* decideOrchestrationCommand({ command: appendCommand, readModel });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual(["thread.message-sent"]);
      expect(events[0]?.metadata.deferredTurn).toBe(true);
      expect(events[0]?.payload).toMatchObject({ messageId, role: "user", turnId: null });
    }),
  );

  it.effect("rejects a message id that already exists on the thread", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const first = yield* decideOrchestrationCommand({ command: appendCommand, readModel });
      const firstEvent = Array.isArray(first) ? first[0]! : first;
      const withMessage = yield* projectEvent(readModel, { ...firstEvent, sequence: 3 });
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: appendCommand, readModel: withMessage }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("already exists");
    }),
  );

  it.effect("lets the following turn start reference the message instead of re-sending it", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const appended = yield* decideOrchestrationCommand({ command: appendCommand, readModel });
      const appendedEvent = Array.isArray(appended) ? appended[0]! : appended;
      const withMessage = yield* projectEvent(readModel, { ...appendedEvent, sequence: 3 });

      const planned = yield* decideOrchestrationCommand({
        command: turnStartCommand,
        readModel: withMessage,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual(["thread.turn-start-requested"]);
      expect(events[0]?.payload).toMatchObject({ messageId });

      // Without the append the turn start still carries the message itself.
      const direct = yield* decideOrchestrationCommand({ command: turnStartCommand, readModel });
      const directEvents = Array.isArray(direct) ? direct : [direct];
      expect(directEvents.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );
});
