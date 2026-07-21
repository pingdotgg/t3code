import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const seedReadModel = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delete"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delete"),
      title: "Project Delete",
      workspaceRoot: "/tmp/project-delete",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const withFirstThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create-1"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1",
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

  return yield* projectEvent(withFirstThread, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-2"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-2"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-2"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-2"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-2"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 2",
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
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function normalizeDeleteEvent(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            threadId: entry.payload.threadId,
          },
        };
      case "project.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            projectId: entry.payload.projectId,
          },
        };
      default:
        return entry;
    }
  });
}

it.layer(NodeServices.layer)("decider deletion flows", (it) => {
  it.effect("rejects deleting a non-empty project without force", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("reuses thread.delete semantics when force-deleting a non-empty project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const projectDeleteCommand: Extract<OrchestrationCommand, { type: "project.delete" }> = {
        type: "project.delete",
        commandId: asCommandId("cmd-project-delete-force"),
        projectId: asProjectId("project-delete"),
        force: true,
      };

      const forcedResult = yield* decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      });
      const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult];

      expect(forcedEvents.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "project.deleted",
      ]);

      let sequentialReadModel = readModel;
      let nextSequence = readModel.snapshotSequence;
      const sequentialEvents: PlannedEvent[] = [];
      for (const nextCommand of [
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-1"),
        },
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-2"),
        },
        {
          type: "project.delete",
          commandId: projectDeleteCommand.commandId,
          projectId: asProjectId("project-delete"),
        },
      ] satisfies ReadonlyArray<OrchestrationCommand>) {
        const decided = yield* decideOrchestrationCommand({
          command: nextCommand,
          readModel: sequentialReadModel,
        });
        const nextEvents = Array.isArray(decided) ? decided : [decided];
        sequentialEvents.push(...nextEvents);
        for (const nextEvent of nextEvents) {
          nextSequence += 1;
          sequentialReadModel = yield* projectEvent(sequentialReadModel, {
            ...nextEvent,
            sequence: nextSequence,
          });
        }
      }

      expect(normalizeDeleteEvent(forcedResult)).toEqual(normalizeDeleteEvent(sequentialEvents));
    }),
  );

  it.effect("rejects commands targeting an already-deleted (evicted) thread", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const now = "2026-01-01T00:00:00.000Z";

      // Delete thread-delete-1; the projector evicts it from the model.
      const afterDelete = yield* projectEvent(seeded, {
        sequence: 4,
        eventId: asEventId("evt-thread-delete-1"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-delete-1"),
        type: "thread.deleted",
        occurredAt: now,
        commandId: asCommandId("cmd-thread-delete-1"),
        causationEventId: null,
        correlationId: asCommandId("cmd-thread-delete-1"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-delete-1"),
          deletedAt: now,
        },
      });

      // A follow-up command to the deleted thread now fails cleanly.
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: asCommandId("cmd-turn-after-delete"),
            threadId: asThreadId("thread-delete-1"),
            message: {
              messageId: MessageId.make("msg-after-delete"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          },
          readModel: afterDelete,
        }),
      );
      expect(error.message).toContain("does not exist");

      // Re-creating a thread with the SAME (deleted) id is rejected: the id is
      // retained in deletedThreadIds even though the thread body was evicted, so
      // the "cannot be created twice" invariant still holds and the durable DB
      // row is not silently overwritten.
      const recreateSameId = (threadId: ThreadId) =>
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: asCommandId(`cmd-recreate-${threadId}`),
            threadId,
            projectId: asProjectId("project-delete"),
            title: "Recreate",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          readModel: afterDelete,
        });

      const recreateError = yield* Effect.flip(recreateSameId(asThreadId("thread-delete-1")));
      expect(recreateError.message).toContain("cannot be created twice");

      // A fresh thread with a NEW, never-used id can still be created.
      const created = yield* recreateSameId(asThreadId("thread-delete-3"));
      const createdEvents = Array.isArray(created) ? created : [created];
      expect(createdEvents.map((event) => event.type)).toEqual(["thread.created"]);
    }),
  );

  it.effect("projector evicts deleted threads but retains archived threads", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const now = "2026-01-01T00:00:00.000Z";
      expect(HashMap.size(seeded.threads)).toBe(2);

      // Archiving keeps the thread resident (unarchive/other commands need it).
      const afterArchive = yield* projectEvent(seeded, {
        sequence: 4,
        eventId: asEventId("evt-thread-archive-1"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-delete-1"),
        type: "thread.archived",
        occurredAt: now,
        commandId: asCommandId("cmd-thread-archive-1"),
        causationEventId: null,
        correlationId: asCommandId("cmd-thread-archive-1"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-delete-1"),
          archivedAt: now,
          updatedAt: now,
        },
      });
      expect(HashMap.size(afterArchive.threads)).toBe(2);
      expect(HashMap.has(afterArchive.threads, asThreadId("thread-delete-1"))).toBe(true);

      // Deleting evicts the thread from the in-memory model entirely.
      const afterDelete = yield* projectEvent(afterArchive, {
        sequence: 5,
        eventId: asEventId("evt-thread-delete-2"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-delete-2"),
        type: "thread.deleted",
        occurredAt: now,
        commandId: asCommandId("cmd-thread-delete-2"),
        causationEventId: null,
        correlationId: asCommandId("cmd-thread-delete-2"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-delete-2"),
          deletedAt: now,
        },
      });
      expect(HashMap.size(afterDelete.threads)).toBe(1);
      expect(HashMap.has(afterDelete.threads, asThreadId("thread-delete-2"))).toBe(false);
      expect(HashMap.has(afterDelete.threads, asThreadId("thread-delete-1"))).toBe(true);
    }),
  );
});
