import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

async function seedReadModel(): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  const initial = createEmptyReadModel(now);
  const withProject = await Effect.runPromise(
    projectEvent(initial, {
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
    }),
  );

  const withFirstThread = await Effect.runPromise(
    projectEvent(withProject, {
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
        pendingRuntimeMode: null,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return Effect.runPromise(
    projectEvent(withFirstThread, {
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
        pendingRuntimeMode: null,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

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

describe("decider deletion flows", () => {
  it("records safe worktree cleanup context for the last active thread", async () => {
    const baseReadModel = await seedReadModel();
    const worktreePath = "/tmp/project-delete-worktree";
    const readModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((thread) =>
        thread.id === asThreadId("thread-delete-1") ? { ...thread, worktreePath } : thread,
      ),
    };

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-thread-cleanup"),
          threadId: asThreadId("thread-delete-1"),
          cleanupWorktree: true,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;

    expect(event?.type).toBe("thread.deleted");
    if (event?.type === "thread.deleted") {
      expect(event.payload.worktreeCleanup).toEqual({
        cwd: "/tmp/project-delete",
        path: worktreePath,
      });
    }
  });

  it("does not request cleanup while another active thread shares the worktree", async () => {
    const baseReadModel = await seedReadModel();
    const worktreePath = "/tmp/shared-worktree";
    const readModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((thread) => ({ ...thread, worktreePath })),
    };

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-thread-shared-cleanup"),
          threadId: asThreadId("thread-delete-1"),
          cleanupWorktree: true,
        },
        readModel,
      }),
    );
    const event = Array.isArray(result) ? result[0] : result;

    expect(event?.type).toBe("thread.deleted");
    if (event?.type === "thread.deleted") {
      expect(event.payload.worktreeCleanup).toBeUndefined();
    }
  });

  it("defers cleanup until the last canonical worktree alias is deleted", async () => {
    const baseReadModel = await seedReadModel();
    const canonicalWorktreePath = "/tmp/shared-worktree";
    const aliasWorktreePath = "/tmp/parent/../shared-worktree";
    const readModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((thread) => ({
        ...thread,
        worktreePath:
          thread.id === asThreadId("thread-delete-1") ? canonicalWorktreePath : aliasWorktreePath,
      })),
    };

    const firstResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-thread-alias-cleanup-1"),
          threadId: asThreadId("thread-delete-1"),
          cleanupWorktree: true,
        },
        readModel,
      }),
    );
    const firstEvent = Array.isArray(firstResult) ? firstResult[0] : firstResult;

    expect(firstEvent?.type).toBe("thread.deleted");
    if (firstEvent?.type !== "thread.deleted") {
      return;
    }
    expect(firstEvent.payload.worktreeCleanup).toBeUndefined();

    const afterFirstDeletion = await Effect.runPromise(
      projectEvent(readModel, {
        ...firstEvent,
        sequence: readModel.snapshotSequence + 1,
      }),
    );
    const secondResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-thread-alias-cleanup-2"),
          threadId: asThreadId("thread-delete-2"),
          cleanupWorktree: true,
        },
        readModel: afterFirstDeletion,
      }),
    );
    const secondEvent = Array.isArray(secondResult) ? secondResult[0] : secondResult;

    expect(secondEvent?.type).toBe("thread.deleted");
    if (secondEvent?.type === "thread.deleted") {
      expect(secondEvent.payload.worktreeCleanup).toEqual({
        cwd: "/tmp/project-delete",
        path: aliasWorktreePath,
      });
    }
  });

  it("rejects deleting a non-empty project without force", async () => {
    const readModel = await seedReadModel();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("cannot be deleted without force=true");
  });

  it("reuses thread.delete semantics when force-deleting a non-empty project", async () => {
    const readModel = await seedReadModel();
    const projectDeleteCommand: Extract<OrchestrationCommand, { type: "project.delete" }> = {
      type: "project.delete",
      commandId: asCommandId("cmd-project-delete-force"),
      projectId: asProjectId("project-delete"),
      force: true,
    };

    const forcedResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      }),
    );
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
      const decided = await Effect.runPromise(
        decideOrchestrationCommand({
          command: nextCommand,
          readModel: sequentialReadModel,
        }),
      );
      const nextEvents = Array.isArray(decided) ? decided : [decided];
      sequentialEvents.push(...nextEvents);
      for (const nextEvent of nextEvents) {
        nextSequence += 1;
        sequentialReadModel = await Effect.runPromise(
          projectEvent(sequentialReadModel, {
            ...nextEvent,
            sequence: nextSequence,
          }),
        );
      }
    }

    expect(normalizeDeleteEvent(forcedResult)).toEqual(normalizeDeleteEvent(sequentialEvents));
  });
});
