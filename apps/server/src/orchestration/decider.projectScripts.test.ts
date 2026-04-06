import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

async function withProjectReadModel(projectId = "project-1", now = new Date().toISOString()) {
  return await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId(`evt-project-create-${projectId}`),
      aggregateKind: "project",
      aggregateId: asProjectId(projectId),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe(`cmd-project-create-${projectId}`),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe(`cmd-project-create-${projectId}`),
      metadata: {},
      payload: {
        projectId: asProjectId(projectId),
        title: `Project ${projectId}`,
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function withThreadReadModel(input: {
  readModel: Awaited<ReturnType<typeof withProjectReadModel>>;
  sequence: number;
  projectId: string;
  threadId: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  parentThreadId?: string | null;
  now: string;
}) {
  return await Effect.runPromise(
    projectEvent(input.readModel, {
      sequence: input.sequence,
      eventId: asEventId(`evt-thread-create-${input.threadId}`),
      aggregateKind: "thread",
      aggregateId: asThreadId(input.threadId),
      type: "thread.created",
      occurredAt: input.now,
      commandId: CommandId.makeUnsafe(`cmd-thread-create-${input.threadId}`),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe(`cmd-thread-create-${input.threadId}`),
      metadata: {},
      payload: {
        threadId: asThreadId(input.threadId),
        projectId: asProjectId(input.projectId),
        parentThreadId: input.parentThreadId === undefined ? null : asThreadId(input.parentThreadId),
        title: `Thread ${input.threadId}`,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: input.now,
        updatedAt: input.now,
      },
    }).pipe(
      Effect.map((nextReadModel) => ({
        ...nextReadModel,
        threads: nextReadModel.threads.map((thread) =>
          thread.id === input.threadId
            ? {
                ...thread,
                archivedAt: input.archivedAt ?? thread.archivedAt,
                deletedAt: input.deletedAt ?? thread.deletedAt,
              }
            : thread,
        ),
      })),
    ),
  );
}

describe("decider project scripts", () => {
  it("emits empty scripts on project.create", async () => {
    const now = new Date().toISOString();
    const readModel = createEmptyReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it("propagates scripts in project.meta.update payload", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const scripts = [
      {
        id: "lint",
        name: "Lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ] as const;

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
  });

  it("emits thread.created with parentThreadId for valid child creates", async () => {
    const now = new Date().toISOString();
    const withProject = await withProjectReadModel("project-1", now);
    const readModel = await withThreadReadModel({
      readModel: withProject,
      sequence: 2,
      projectId: "project-1",
      threadId: "thread-parent",
      now,
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create-child"),
          threadId: asThreadId("thread-child"),
          projectId: asProjectId("project-1"),
          parentThreadId: asThreadId("thread-parent"),
          title: "Child Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) {
      return;
    }
    expect(result).toMatchObject({
      type: "thread.created",
      payload: {
        threadId: asThreadId("thread-child"),
        projectId: asProjectId("project-1"),
        parentThreadId: asThreadId("thread-parent"),
      },
    });
  });

  it("rejects thread.create when the parent thread is missing", async () => {
    const now = new Date().toISOString();
    const readModel = await withProjectReadModel("project-1", now);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-thread-create-missing-parent"),
            threadId: asThreadId("thread-child"),
            projectId: asProjectId("project-1"),
            parentThreadId: asThreadId("thread-missing"),
            title: "Child Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("treats undefined parentThreadId from undecoded internal callers as unparented", async () => {
    const now = new Date().toISOString();
    const readModel = await withProjectReadModel("project-1", now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create-undefined-parent"),
          threadId: asThreadId("thread-child"),
          projectId: asProjectId("project-1"),
          parentThreadId: undefined,
          title: "Child Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now,
        } as unknown as Parameters<typeof decideOrchestrationCommand>[0]["command"],
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) {
      return;
    }
    expect(result).toMatchObject({
      type: "thread.created",
      payload: {
        threadId: asThreadId("thread-child"),
        parentThreadId: null,
      },
    });
  });

  it("rejects thread.create when the parent thread belongs to another project", async () => {
    const now = new Date().toISOString();
    const withProjectA = await withProjectReadModel("project-1", now);
    const withProjectB = await withProjectReadModel("project-2", now);
    const readModel = await withThreadReadModel({
      readModel: {
        ...withProjectB,
        projects: [...withProjectA.projects, ...withProjectB.projects],
        threads: withProjectA.threads,
        snapshotSequence: withProjectB.snapshotSequence,
        updatedAt: withProjectB.updatedAt,
      },
      sequence: 2,
      projectId: "project-2",
      threadId: "thread-parent",
      now,
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-thread-create-cross-project-parent"),
            threadId: asThreadId("thread-child"),
            projectId: asProjectId("project-1"),
            parentThreadId: asThreadId("thread-parent"),
            title: "Child Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("different project");
  });

  it("rejects thread.create when the parent thread is deleted", async () => {
    const now = new Date().toISOString();
    const withProject = await withProjectReadModel("project-1", now);
    const readModel = await withThreadReadModel({
      readModel: withProject,
      sequence: 2,
      projectId: "project-1",
      threadId: "thread-parent",
      deletedAt: now,
      now,
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-thread-create-deleted-parent"),
            threadId: asThreadId("thread-child"),
            projectId: asProjectId("project-1"),
            parentThreadId: asThreadId("thread-parent"),
            title: "Child Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("deleted");
  });

  it("allows archived parent threads during thread.create", async () => {
    const now = new Date().toISOString();
    const archivedAt = new Date(Date.parse(now) + 1_000).toISOString();
    const withProject = await withProjectReadModel("project-1", now);
    const readModel = await withThreadReadModel({
      readModel: withProject,
      sequence: 2,
      projectId: "project-1",
      threadId: "thread-parent",
      archivedAt,
      now,
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create-archived-parent"),
          threadId: asThreadId("thread-child"),
          projectId: asProjectId("project-1"),
          parentThreadId: asThreadId("thread-parent"),
          title: "Child Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) {
      return;
    }
    expect(result.type).toBe("thread.created");
  });

  it("rejects thread.create when a thread attempts to parent itself", async () => {
    const now = new Date().toISOString();
    const readModel = await withProjectReadModel("project-1", now);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-thread-create-self-parent"),
            threadId: asThreadId("thread-self"),
            projectId: asProjectId("project-1"),
            parentThreadId: asThreadId("thread-self"),
            title: "Self Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("cannot parent itself");
  });

  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: asMessageId("message-user-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "approval-required",
    });
  });

  it("emits thread.runtime-mode-set from thread.runtime-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.makeUnsafe("cmd-runtime-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single runtime-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.runtime-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
      },
    });
  });

  it("emits thread.interaction-mode-set from thread.interaction-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe("cmd-interaction-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          interactionMode: "plan",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single interaction-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.interaction-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
      },
    });
  });
});
