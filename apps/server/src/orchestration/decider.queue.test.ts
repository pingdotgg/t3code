import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-08-24T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-bootstrap");

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

const apply = Effect.fn("apply")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const planned = yield* decideOrchestrationCommand({ readModel, command });
  const events = Array.isArray(planned) ? planned : [planned];
  for (const event of events)
    readModel = yield* projectEvent(readModel, {
      ...event,
      sequence: readModel.snapshotSequence + 1,
    });
  return { readModel, events };
});
const enqueue = (id: string): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make(`enqueue:${id}`),
  threadId,
  message: { messageId: MessageId.make(id), role: "user", text: id, attachments: [] },
  deliveryMode: "queue",
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt,
});
const running = Effect.gen(function* () {
  const initial = yield* readModelWithThread;
  return (yield* apply(initial, {
    type: "thread.session.set",
    commandId: CommandId.make("running"),
    threadId,
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn"),
      lastError: null,
      updatedAt: createdAt,
    },
    createdAt,
  })).readModel;
});
const advance = {
  type: "thread.queue.advance" as const,
  commandId: CommandId.make("advance"),
  threadId,
};

it.layer(NodeServices.layer)("server message queue", (it) => {
  it.effect("persists a follow-up without publishing a sent message or starting a turn", () =>
    Effect.gen(function* () {
      const { readModel, events } = yield* apply(yield* running, enqueue("first"));
      expect(events.map((event) => event.type)).toEqual(["thread.queue-updated"]);
      expect(readModel.threads[0]?.messages).toEqual([]);
      expect(readModel.threads[0]?.queuedMessages?.[0]).toMatchObject({
        text: "first",
        status: "queued",
      });
      expect((yield* apply(readModel, advance)).events).toEqual([]);
    }),
  );
  it.effect("sends one message per tool boundary and serializes competing clients", () =>
    Effect.gen(function* () {
      let state = (yield* apply(yield* running, enqueue("first"))).readModel;
      state = (yield* apply(state, enqueue("second"))).readModel;
      state = (yield* apply(state, {
        type: "thread.activity.append",
        commandId: CommandId.make("tool"),
        threadId,
        createdAt,
        activity: {
          id: EventId.make("tool"),
          kind: "tool.completed",
          payload: {},
          summary: "Done",
          tone: "info",
          turnId: TurnId.make("turn"),
          createdAt,
        },
      })).readModel;
      const dispatched = yield* apply(state, advance);
      expect(dispatched.events.map((event) => event.type)).toEqual([
        "thread.queue-updated",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      expect(
        (yield* apply(dispatched.readModel, {
          type: "thread.queue.send",
          commandId: CommandId.make("other-client"),
          threadId,
          messageId: MessageId.make("first"),
        })).events,
      ).toEqual([]);
      state = (yield* apply(dispatched.readModel, {
        type: "thread.queue.complete",
        commandId: CommandId.make("complete"),
        threadId,
        messageId: MessageId.make("first"),
        failed: false,
      })).readModel;
      expect((yield* apply(state, advance)).events).toEqual([]);
      expect(state.threads[0]?.queuedMessages?.map((message) => message.text)).toEqual(["second"]);
    }),
  );
  it.effect("Stop holds pending messages and Send now resumes explicitly", () =>
    Effect.gen(function* () {
      let state = (yield* apply(yield* running, enqueue("first"))).readModel;
      state = (yield* apply(state, {
        type: "thread.turn.interrupt",
        commandId: CommandId.make("stop"),
        threadId,
        createdAt,
      })).readModel;
      expect(state.threads[0]?.queuedMessages?.[0]?.status).toBe("held");
      expect((yield* apply(state, advance)).events).toEqual([]);
      const sent = yield* apply(state, {
        type: "thread.queue.send",
        commandId: CommandId.make("send-now"),
        threadId,
        messageId: MessageId.make("first"),
      });
      expect(sent.events.some((event) => event.type === "thread.turn-start-requested")).toBe(true);
    }),
  );
  it.effect("a cancellation can be claimed by only one client", () =>
    Effect.gen(function* () {
      const queued = (yield* apply(yield* running, enqueue("first"))).readModel;
      const remove = {
        type: "thread.queue.remove" as const,
        commandId: CommandId.make("remove"),
        threadId,
        messageId: MessageId.make("first"),
      };
      const state = (yield* apply(queued, remove)).readModel;
      const error = yield* Effect.flip(
        apply(state, { ...remove, commandId: CommandId.make("other-client") }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("restart preserves queued work and holds ambiguous provider handoffs", () =>
    Effect.gen(function* () {
      let state = (yield* apply(yield* running, enqueue("first"))).readModel;
      state = (yield* apply(state, enqueue("second"))).readModel;
      state = (yield* apply(state, {
        type: "thread.queue.send",
        commandId: CommandId.make("send"),
        threadId,
        messageId: MessageId.make("first"),
      })).readModel;
      state = (yield* apply(state, {
        type: "thread.queue.recover",
        commandId: CommandId.make("recover"),
        threadId,
      })).readModel;
      expect(state.threads[0]?.queuedMessages?.map((message) => message.status)).toEqual([
        "held",
        "queued",
      ]);
      expect((yield* apply(state, advance)).events).toEqual([]);
    }),
  );
  it.effect("blocks Send now as well as automatic dispatch for a pending request", () =>
    Effect.gen(function* () {
      const state = (yield* apply(yield* running, enqueue("first"))).readModel;
      const result = yield* decideOrchestrationCommand({
        readModel: state,
        queueBlocked: true,
        command: {
          type: "thread.queue.send",
          commandId: CommandId.make("send"),
          threadId,
          messageId: MessageId.make("first"),
        },
      });
      expect(result).toEqual([]);
    }),
  );
});
