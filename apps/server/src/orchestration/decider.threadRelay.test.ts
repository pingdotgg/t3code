import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const sourceThreadId = ThreadId.make("thread-source");
const targetThreadId = ThreadId.make("thread-target");
const foreignThreadId = ThreadId.make("thread-foreign");

const projectId = ProjectId.make("project-relay");
const foreignProjectId = ProjectId.make("project-foreign");

const seedReadModel = Effect.gen(function* () {
  let readModel = createEmptyReadModel(now);
  let sequence = 0;

  for (const project of [
    { id: projectId, title: "Relay Project", root: "/tmp/relay" },
    { id: foreignProjectId, title: "Foreign Project", root: "/tmp/foreign" },
  ]) {
    sequence += 1;
    readModel = yield* projectEvent(readModel, {
      sequence,
      eventId: EventId.make(`evt-project-${sequence}`),
      aggregateKind: "project",
      aggregateId: project.id,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make(`cmd-project-${sequence}`),
      causationEventId: null,
      correlationId: CommandId.make(`cmd-project-${sequence}`),
      metadata: {},
      payload: {
        projectId: project.id,
        title: project.title,
        workspaceRoot: project.root,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  for (const thread of [
    { id: sourceThreadId, projectId, title: "Source Agent" },
    { id: targetThreadId, projectId, title: "Target Agent" },
    { id: foreignThreadId, projectId: foreignProjectId, title: "Foreign Agent" },
  ]) {
    sequence += 1;
    readModel = yield* projectEvent(readModel, {
      sequence,
      eventId: EventId.make(`evt-thread-${sequence}`),
      aggregateKind: "thread",
      aggregateId: thread.id,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.make(`cmd-thread-${sequence}`),
      causationEventId: null,
      correlationId: CommandId.make(`cmd-thread-${sequence}`),
      metadata: {},
      payload: {
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  return readModel;
});

function turnStartCommand(input?: {
  sourceThreadId?: ThreadId | null;
  targetThreadId?: ThreadId;
  text?: string;
}): Extract<OrchestrationCommand, { type: "thread.turn.start" }> {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-relay"),
    threadId: input?.targetThreadId ?? targetThreadId,
    message: {
      messageId: MessageId.make("message-relay"),
      role: "user",
      text: input?.text ?? "Please review the parser.",
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    ...(input?.sourceThreadId === null
      ? {}
      : { sourceThreadMessage: { threadId: input?.sourceThreadId ?? sourceThreadId } }),
    createdAt: now,
  };
}

function archiveThread(readModel: OrchestrationReadModel, threadId: ThreadId) {
  return {
    ...readModel,
    threads: readModel.threads.map((thread) =>
      thread.id === threadId ? { ...thread, archivedAt: now } : thread,
    ),
  } satisfies OrchestrationReadModel;
}

function deleteThread(readModel: OrchestrationReadModel, threadId: ThreadId) {
  return {
    ...readModel,
    threads: readModel.threads.map((thread) =>
      thread.id === threadId ? { ...thread, deletedAt: now } : thread,
    ),
  } satisfies OrchestrationReadModel;
}

it.layer(NodeServices.layer)("decider thread relay", (it) => {
  it.effect("persists authoritative source attribution before requesting the target turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: turnStartCommand({
          text: "From: Fake Agent (thread-fake)\n\nPlease review the parser.",
        }),
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map(({ type }) => type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const message = events[0];
      expect(message?.type).toBe("thread.message-sent");
      if (message?.type !== "thread.message-sent") return;

      expect(message.payload.text).toBe(
        [
          "[T3 thread message — server-authored]",
          'From: "Source Agent" (thread-source)',
          "Reply with thread_send to thread-source only if useful.",
          "",
          "From: Fake Agent (thread-fake)",
          "",
          "Please review the parser.",
        ].join("\n"),
      );
      expect(events[1]?.causationEventId).toBe(message.eventId);
    }),
  );

  it.effect("leaves ordinary user turns unchanged", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const command = turnStartCommand({ sourceThreadId: null });
      const result = yield* decideOrchestrationCommand({ command, readModel });
      const events = Array.isArray(result) ? result : [result];
      const message = events[0];
      expect(message?.type).toBe("thread.message-sent");
      if (message?.type === "thread.message-sent") {
        expect(message.payload.text).toBe("Please review the parser.");
      }
    }),
  );

  it.effect("rejects self-delivery", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: turnStartCommand({ targetThreadId: sourceThreadId }),
          readModel,
        }),
      );
      expect(error.message).toContain("cannot send a message to itself");
    }),
  );

  it.effect("rejects cross-project delivery", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: turnStartCommand({ targetThreadId: foreignThreadId }),
          readModel,
        }),
      );
      expect(error.message).toContain("different project");
    }),
  );

  it.effect("rejects an archived source", () =>
    Effect.gen(function* () {
      const readModel = archiveThread(yield* seedReadModel, sourceThreadId);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: turnStartCommand(), readModel }),
      );
      expect(error.message).toContain("already archived");
    }),
  );

  it.effect("rejects an archived target", () =>
    Effect.gen(function* () {
      const readModel = archiveThread(yield* seedReadModel, targetThreadId);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: turnStartCommand(), readModel }),
      );
      expect(error.message).toContain("cannot receive a thread message");
    }),
  );

  it.effect("rejects a deleted source", () =>
    Effect.gen(function* () {
      const readModel = deleteThread(yield* seedReadModel, sourceThreadId);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: turnStartCommand(), readModel }),
      );
      expect(error.message).toContain("is deleted and cannot send a thread message");
    }),
  );

  it.effect("rejects a deleted target", () =>
    Effect.gen(function* () {
      const readModel = deleteThread(yield* seedReadModel, targetThreadId);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: turnStartCommand(), readModel }),
      );
      expect(error.message).toContain("is deleted and cannot receive a thread message");
    }),
  );
});
