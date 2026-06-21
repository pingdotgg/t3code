import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
  ProviderItemId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asProviderItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

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

const seedReadModelWithSubagents = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const withRoots = yield* seedReadModel;
  const childThreadId = asThreadId("thread-delete-1-child");
  const grandchildThreadId = asThreadId("thread-delete-1-grandchild");
  const withChild = yield* projectEvent(withRoots, {
    sequence: 4,
    eventId: asEventId("evt-thread-create-1-child"),
    aggregateKind: "thread",
    aggregateId: childThreadId,
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1-child"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1-child"),
    metadata: {},
    payload: {
      threadId: childThreadId,
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1 Child",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      parentRelation: {
        kind: "subagent",
        rootThreadId: asThreadId("thread-delete-1"),
        parentThreadId: asThreadId("thread-delete-1"),
        parentTurnId: asTurnId("turn-delete-1"),
        parentItemId: asProviderItemId("item-delete-1"),
        parentActivitySequence: 1,
        providerThreadId: "provider-thread-delete-1-child",
        titleSeed: "Child",
        depth: 1,
        startedAt: now,
        completedAt: null,
        status: "running",
      },
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withChild, {
    sequence: 5,
    eventId: asEventId("evt-thread-create-1-grandchild"),
    aggregateKind: "thread",
    aggregateId: grandchildThreadId,
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1-grandchild"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1-grandchild"),
    metadata: {},
    payload: {
      threadId: grandchildThreadId,
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1 Grandchild",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      parentRelation: {
        kind: "subagent",
        rootThreadId: asThreadId("thread-delete-1"),
        parentThreadId: childThreadId,
        parentTurnId: asTurnId("turn-delete-1-child"),
        parentItemId: asProviderItemId("item-delete-1-child"),
        parentActivitySequence: 2,
        providerThreadId: "provider-thread-delete-1-grandchild",
        titleSeed: "Grandchild",
        depth: 2,
        startedAt: now,
        completedAt: null,
        status: "running",
      },
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

function normalizeThreadLifecycleEvents(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          threadId: entry.payload.threadId,
        };
      case "thread.archived":
        return {
          type: entry.type,
          threadId: entry.payload.threadId,
        };
      case "project.deleted":
        return {
          type: entry.type,
          projectId: entry.payload.projectId,
        };
      default:
        return { type: entry.type };
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

  it.effect("deletes subagent descendants before deleting their parent thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-thread-delete-cascade"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel,
      });

      expect(normalizeThreadLifecycleEvents(result)).toEqual([
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1-child") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1") },
      ]);
    }),
  );

  it.effect("archives subagent descendants before archiving their parent thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-thread-archive-cascade"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel,
      });

      expect(normalizeThreadLifecycleEvents(result)).toEqual([
        { type: "thread.archived", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.archived", threadId: asThreadId("thread-delete-1-child") },
        { type: "thread.archived", threadId: asThreadId("thread-delete-1") },
      ]);
    }),
  );

  it.effect("force-deletes subagent descendants once when deleting a project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithSubagents;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: asCommandId("cmd-project-delete-subagents"),
          projectId: asProjectId("project-delete"),
          force: true,
        },
        readModel,
      });

      expect(normalizeThreadLifecycleEvents(result)).toEqual([
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1-grandchild") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1-child") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-1") },
        { type: "thread.deleted", threadId: asThreadId("thread-delete-2") },
        { type: "project.deleted", projectId: asProjectId("project-delete") },
      ]);
    }),
  );
});
