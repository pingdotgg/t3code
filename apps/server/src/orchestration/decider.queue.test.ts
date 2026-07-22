import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const THREAD_ID = asThreadId("thread-queue");

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(NOW);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-queue"),
    type: "project.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-queue"),
      title: "Project Queue",
      workspaceRoot: "/tmp/project-queue",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-thread-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      projectId: asProjectId("project-queue"),
      title: "Thread Queue",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

const withSessionStatus = (
  readModel: OrchestrationReadModel,
  status: OrchestrationSessionStatus,
  sequence: number,
) =>
  projectEvent(readModel, {
    sequence,
    eventId: asEventId(`evt-session-${status}-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.session-set",
    occurredAt: NOW,
    commandId: asCommandId(`cmd-session-${status}-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: status === "running" ? TurnId.make("turn-active") : null,
        lastError: null,
        updatedAt: NOW,
      },
    },
  });

const turnStartCommand = (suffix: string) =>
  ({
    type: "thread.turn.start",
    commandId: asCommandId(`cmd-turn-start-${suffix}`),
    threadId: THREAD_ID,
    message: {
      messageId: asMessageId(`message-${suffix}`),
      role: "user",
      text: `Follow up ${suffix}`,
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: NOW,
  }) as const;

const applyPlanned = (
  readModel: OrchestrationReadModel,
  planned:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) =>
  Effect.gen(function* () {
    let nextReadModel = readModel;
    let nextSequence = readModel.snapshotSequence;
    for (const event of Array.isArray(planned) ? planned : [planned]) {
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, { ...event, sequence: nextSequence });
    }
    return nextReadModel;
  });

it.layer(NodeServices.layer)("decider queue flows", (it) => {
  it.effect("starts a turn immediately when the thread is idle", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const planned = yield* decideOrchestrationCommand({
        command: turnStartCommand("idle"),
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("queues a follow-up while a turn is running", () =>
    Effect.gen(function* () {
      const readModel = yield* withSessionStatus(yield* seedReadModel, "running", 3);
      const planned = yield* decideOrchestrationCommand({
        command: turnStartCommand("busy"),
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual(["thread.message-queued"]);

      const projected = yield* applyPlanned(readModel, planned);
      const thread = projected.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.queuedMessages.map((entry) => entry.messageId)).toEqual([
        asMessageId("message-busy"),
      ]);
    }),
  );

  it.effect("steer dispatches a queued message even while running", () =>
    Effect.gen(function* () {
      let readModel = yield* withSessionStatus(yield* seedReadModel, "running", 3);
      readModel = yield* applyPlanned(
        readModel,
        yield* decideOrchestrationCommand({ command: turnStartCommand("steer"), readModel }),
      );

      const planned = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queue.steer",
          commandId: asCommandId("cmd-steer"),
          threadId: THREAD_ID,
          messageId: asMessageId("message-steer"),
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual([
        "thread.queued-message-removed",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);

      const projected = yield* applyPlanned(readModel, planned);
      const thread = projected.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.queuedMessages).toEqual([]);
      expect(thread?.messages.map((entry) => entry.id)).toContain(asMessageId("message-steer"));
    }),
  );

  it.effect("remove deletes a queued message without dispatching", () =>
    Effect.gen(function* () {
      let readModel = yield* withSessionStatus(yield* seedReadModel, "running", 3);
      readModel = yield* applyPlanned(
        readModel,
        yield* decideOrchestrationCommand({ command: turnStartCommand("remove"), readModel }),
      );

      const planned = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queue.remove",
          commandId: asCommandId("cmd-remove"),
          threadId: THREAD_ID,
          messageId: asMessageId("message-remove"),
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual(["thread.queued-message-removed"]);

      const projected = yield* applyPlanned(readModel, planned);
      const thread = projected.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.queuedMessages).toEqual([]);
      expect(thread?.messages.map((entry) => entry.id)).not.toContain(
        asMessageId("message-remove"),
      );
    }),
  );

  it.effect("steer and remove reject unknown queued messages", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      for (const type of ["thread.queue.steer", "thread.queue.remove"] as const) {
        const error = yield* Effect.flip(
          decideOrchestrationCommand({
            command: {
              type,
              commandId: asCommandId(`cmd-${type}-missing`),
              threadId: THREAD_ID,
              messageId: asMessageId("message-missing"),
              createdAt: NOW,
            },
            readModel,
          }),
        );
        expect(error.message).toContain("does not exist");
      }
    }),
  );

  it.effect("drain dispatches the queue head once the thread is idle", () =>
    Effect.gen(function* () {
      let readModel = yield* withSessionStatus(yield* seedReadModel, "running", 3);
      readModel = yield* applyPlanned(
        readModel,
        yield* decideOrchestrationCommand({ command: turnStartCommand("drain-1"), readModel }),
      );
      readModel = yield* applyPlanned(
        readModel,
        yield* decideOrchestrationCommand({ command: turnStartCommand("drain-2"), readModel }),
      );
      readModel = yield* withSessionStatus(readModel, "ready", readModel.snapshotSequence + 1);

      const planned = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queue.drain",
          commandId: asCommandId("cmd-drain"),
          threadId: THREAD_ID,
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual([
        "thread.queued-message-removed",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);

      const projected = yield* applyPlanned(readModel, planned);
      const thread = projected.threads.find((entry) => entry.id === THREAD_ID);
      // FIFO: the first queued message dispatches, the second stays queued.
      expect(thread?.messages.map((entry) => entry.id)).toContain(asMessageId("message-drain-1"));
      expect(thread?.queuedMessages.map((entry) => entry.messageId)).toEqual([
        asMessageId("message-drain-2"),
      ]);
    }),
  );

  it.effect("drain rejects while the thread is busy and keeps the queue intact", () =>
    Effect.gen(function* () {
      let readModel = yield* withSessionStatus(yield* seedReadModel, "running", 3);
      readModel = yield* applyPlanned(
        readModel,
        yield* decideOrchestrationCommand({ command: turnStartCommand("drain-busy"), readModel }),
      );

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.queue.drain",
            commandId: asCommandId("cmd-drain-busy"),
            threadId: THREAD_ID,
            createdAt: NOW,
          },
          readModel,
        }),
      );
      expect(error.message).toContain("busy");
    }),
  );

  it.effect("drain rejects when the queue is empty", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.queue.drain",
            commandId: asCommandId("cmd-drain-empty"),
            threadId: THREAD_ID,
            createdAt: NOW,
          },
          readModel,
        }),
      );
      expect(error.message).toContain("no queued messages");
    }),
  );
});
