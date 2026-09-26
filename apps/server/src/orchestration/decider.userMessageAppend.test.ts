import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

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

it.layer(NodeServices.layer)("thread.turn.start onlyIfUnchanged", (it) => {
  const serverTurn = {
    ...turnStartCommand,
    commandId: CommandId.make("command-server-turn"),
    message: { ...turnStartCommand.message, messageId: MessageId.make("message-server-turn") },
    createdAt: "2026-08-24T10:05:00.000Z",
  };

  it.effect("starts the turn while the thread is still as the server observed it", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const planned = yield* decideOrchestrationCommand({
        command: {
          ...serverTurn,
          onlyIfUnchanged: { latestTurnId: null, latestUserMessageAt: null },
        },
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toContain("thread.turn-start-requested");
    }),
  );

  it.effect("rejects the turn once a user message has landed first", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const appended = yield* decideOrchestrationCommand({ command: appendCommand, readModel });
      const appendedEvent = Array.isArray(appended) ? appended[0]! : appended;
      const withUserMessage = yield* projectEvent(readModel, { ...appendedEvent, sequence: 3 });
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...serverTurn,
            onlyIfUnchanged: { latestTurnId: null, latestUserMessageAt: null },
          },
          readModel: withUserMessage,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      // The same command is accepted when it names the state that now holds.
      const planned = yield* decideOrchestrationCommand({
        command: {
          ...serverTurn,
          onlyIfUnchanged: { latestTurnId: null, latestUserMessageAt: createdAt },
        },
        readModel: withUserMessage,
      });
      expect(Array.isArray(planned) ? planned.length : 1).toBeGreaterThan(0);
    }),
  );

  // Parking or removing the thread leaves both cursors untouched, so the guard
  // must reject on lifecycle state too: a retry must never un-park a thread.
  const parkedEvents: ReadonlyArray<{
    readonly name: string;
    // Distributes over the event union so each row keeps its payload type.
    readonly event: OrchestrationEvent extends infer E
      ? E extends OrchestrationEvent
        ? Pick<E, "type" | "payload">
        : never
      : never;
  }> = [
    {
      name: "settled",
      event: {
        type: "thread.settled",
        payload: { threadId, settledAt: createdAt, updatedAt: createdAt },
      },
    },
    {
      name: "snoozed",
      event: {
        type: "thread.snoozed",
        payload: {
          threadId,
          snoozedUntil: "2099-01-01T00:00:00.000Z",
          snoozedAt: createdAt,
          updatedAt: createdAt,
        },
      },
    },
    {
      name: "archived",
      event: {
        type: "thread.archived",
        payload: { threadId, archivedAt: createdAt, updatedAt: createdAt },
      },
    },
    {
      name: "deleted",
      event: {
        type: "thread.deleted",
        payload: { threadId, deletedAt: createdAt },
      },
    },
  ];

  it.effect.each(parkedEvents)(
    "rejects the turn after the thread was $name in the meantime",
    ({ event }) =>
      Effect.gen(function* () {
        const readModel = yield* readModelWithThread;
        const parked = yield* projectEvent(readModel, {
          sequence: 3,
          eventId: EventId.make(`event-${event.type}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make(`command-${event.type}`),
          causationEventId: null,
          correlationId: CommandId.make(`command-${event.type}`),
          metadata: {},
          ...event,
        });
        const error = yield* Effect.flip(
          decideOrchestrationCommand({
            command: {
              ...serverTurn,
              onlyIfUnchanged: { latestTurnId: null, latestUserMessageAt: null },
            },
            readModel: parked,
          }),
        );
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }),
  );

  it.effect("still starts the turn once the snooze has expired", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const expiredSnooze = yield* projectEvent(readModel, {
        sequence: 3,
        eventId: EventId.make("event-thread.snoozed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.snoozed",
        occurredAt: createdAt,
        commandId: CommandId.make("command-thread.snoozed"),
        causationEventId: null,
        correlationId: CommandId.make("command-thread.snoozed"),
        metadata: {},
        payload: {
          threadId,
          // The test clock sits at the epoch; this lapses one second in.
          snoozedUntil: "1970-01-01T00:00:01.000Z",
          snoozedAt: createdAt,
          updatedAt: createdAt,
        },
      });
      yield* TestClock.adjust(Duration.seconds(2));
      const planned = yield* decideOrchestrationCommand({
        command: {
          ...serverTurn,
          onlyIfUnchanged: { latestTurnId: null, latestUserMessageAt: null },
        },
        readModel: expiredSnooze,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toContain("thread.turn-start-requested");
    }),
  );
});
