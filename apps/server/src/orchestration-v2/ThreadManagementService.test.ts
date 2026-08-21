import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestratorProjectionError, OrchestratorV2 } from "./Orchestrator.ts";
import {
  existingThreadIdsForCommand,
  layer,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementProjectionLoadError,
  ThreadManagementRunNotFoundError,
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementThreadArchivedError,
  ThreadManagementNoSteerableRunError,
  userFacingShellSnapshot,
  withCreationProvenance,
} from "./ThreadManagementService.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
});

it("leaves commands that do not create durable authored content unchanged", () => {
  const command: OrchestrationV2Command = {
    type: "run.interrupt",
    commandId: CommandId.make("command:thread-management:interrupt"),
    threadId: ThreadId.make("thread:thread-management:interrupt"),
    runId: RunId.make("run:thread-management:interrupt"),
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toBe(command);
});

it("identifies every existing thread that must be hydrated before dispatch", () => {
  const sourceThreadId = ThreadId.make("thread:thread-management:source");
  const targetThreadId = ThreadId.make("thread:thread-management:target");
  const parentThreadId = ThreadId.make("thread:thread-management:parent");

  expect(
    existingThreadIdsForCommand({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:create"),
      threadId: targetThreadId,
      projectId: ProjectId.make("project:thread-management"),
      title: "Created thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.archive",
      commandId: CommandId.make("command:thread-management:archive"),
      threadId: targetThreadId,
    }),
  ).toEqual([targetThreadId]);

  // Read-state commands skip transcript hydration entirely: they fire on
  // every activity bump while a thread is open and never touch messages.
  expect(
    existingThreadIdsForCommand({
      type: "thread.visit",
      commandId: CommandId.make("command:thread-management:visit"),
      threadId: targetThreadId,
      visitedAt: "2026-07-30T00:00:00.000Z",
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.mark-unread",
      commandId: CommandId.make("command:thread-management:mark-unread"),
      threadId: targetThreadId,
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.merge_back",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:merge"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId, targetThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "provider",
      commandId: CommandId.make("command:thread-management:delegate"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      task: "Inspect the migration",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
  ).toEqual([parentThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("command:thread-management:wake-policy"),
      parentThreadId,
      taskId: NodeId.make("node:thread-management:delegated"),
      completionWake: "always",
    }),
  ).toEqual([parentThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.created.record",
      commandId: CommandId.make("command:thread-management:record"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      targetThreadId,
      targetRunId: null,
    }),
  ).toEqual([parentThreadId, targetThreadId]);
});

it("derives thread management messages from structural error attributes", () => {
  const projectId = ProjectId.make("project:thread-management:errors");
  const threadId = ThreadId.make("thread:thread-management:errors");
  const runId = RunId.make("run:thread-management:errors");
  const messageId = MessageId.make("message:thread-management:errors");
  const infrastructureCause = new Error("private sqlite detail");

  const threadNotFound = new ThreadManagementThreadNotFoundError({
    projectId,
    threadId,
  });
  expect(threadNotFound).toMatchObject({ projectId, threadId });
  expect(threadNotFound.message).toBe(`Thread ${threadId} was not found in project ${projectId}.`);

  const runNotFound = new ThreadManagementRunNotFoundError({ threadId, runId });
  expect(runNotFound).toMatchObject({ threadId, runId });
  expect(runNotFound.message).toBe(`Run ${runId} does not belong to thread ${threadId}.`);

  const archived = new ThreadManagementThreadArchivedError({
    threadId,
  });
  expect(archived).toMatchObject({ threadId });
  expect(archived.message).toBe(`Thread ${threadId} is archived and cannot receive messages.`);

  const notSteerable = new ThreadManagementNoSteerableRunError({
    threadId,
    mode: "restart",
  });
  expect(notSteerable).toMatchObject({
    threadId,
    mode: "restart",
  });
  expect(notSteerable.message).toBe(
    `Thread ${threadId} has no running turn that can be restarted.`,
  );

  const notInterruptible = new ThreadManagementThreadNotInterruptibleError({
    threadId,
    runId,
  });
  expect(notInterruptible).toMatchObject({ threadId, runId });
  expect(notInterruptible.message).toBe(`Run ${runId} is not currently interruptible.`);

  const listFailure = new ThreadManagementProjectThreadsListError({
    projectId,
    cause: infrastructureCause,
  });
  expect(listFailure).toMatchObject({ projectId, cause: infrastructureCause });
  expect(listFailure.message).toBe(`Unable to list threads in project ${projectId}.`);
  expect(listFailure.message).not.toContain(infrastructureCause.message);

  const durableProjectionFailure = new ThreadManagementDurableRunProjectionError({
    threadId,
    messageId,
  });
  expect(durableProjectionFailure).toMatchObject({ threadId, messageId });
  expect(durableProjectionFailure.message).toBe(
    `Message ${messageId} was accepted on thread ${threadId} without a durable run projection.`,
  );
});

it.effect("classifies projection infrastructure failures separately from a missing thread", () => {
  const projectId = ProjectId.make("project:thread-management:projection-failure");
  const threadId = ThreadId.make("thread:thread-management:projection-failure");
  const infrastructureCause = new Error("sqlite read failed");
  const projectionError = new OrchestratorProjectionError({
    threadId,
    cause: infrastructureCause,
  });
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getThreadProjection: () => Effect.fail(projectionError),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementProjectionLoadError);
    expect(error).toMatchObject({
      projectId,
      threadId,
      cause: projectionError,
    });
    expect(error.message).toBe(`Unable to load thread ${threadId} in project ${projectId}.`);
  }).pipe(Effect.provide(testLayer));
});

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(testLayer));
});

it("removes internal subagent children from active and archived shell collections", () => {
  const rootId = ThreadId.make("thread:thread-management:root");
  const forkId = ThreadId.make("thread:thread-management:fork");
  const lineageSubagentId = ThreadId.make("thread:thread-management:lineage-subagent");
  const nodeSubagentId = ThreadId.make("thread:thread-management:node-subagent");
  const shell = (
    id: ThreadId,
    lineage: OrchestrationV2ThreadShell["lineage"],
    forkedFrom: OrchestrationV2ThreadShell["forkedFrom"],
  ) =>
    ({
      id,
      lineage,
      forkedFrom,
    }) as OrchestrationV2ThreadShell;
  const rootLineage = {
    rootThreadId: rootId,
    parentThreadId: null,
    relationshipToParent: null,
  } as const;
  const snapshot = userFacingShellSnapshot({
    schemaVersion: 3,
    snapshotSequence: 10,
    threads: [
      shell(rootId, rootLineage, null),
      shell(
        forkId,
        {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "fork",
        },
        { type: "run", threadId: rootId, runId: RunId.make("run:thread-management:fork") },
      ),
      shell(
        lineageSubagentId,
        {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "subagent",
        },
        null,
      ),
    ],
    archivedThreads: [
      shell(nodeSubagentId, rootLineage, {
        type: "node",
        nodeId: NodeId.make("node:thread-management:subagent"),
      }),
    ],
  });

  expect(snapshot.threads.map((thread) => thread.id)).toEqual([rootId, forkId]);
  expect(snapshot.archivedThreads).toEqual([]);
});

it.effect("lists compact references for every active thread, including hidden subagents", () => {
  const projectId = ProjectId.make("project:thread-management:refs");
  const rootId = ThreadId.make("thread:thread-management:refs-root");
  const lineageChildId = ThreadId.make("thread:thread-management:refs-lineage-child");
  const nodeChildId = ThreadId.make("thread:thread-management:refs-node-child");
  const worktreePath = "/workspace/project/.worktrees/feature";
  const shell = (
    id: ThreadId,
    lineage: OrchestrationV2ThreadShell["lineage"],
    forkedFrom: OrchestrationV2ThreadShell["forkedFrom"],
  ) => ({ id, projectId, worktreePath, lineage, forkedFrom }) as OrchestrationV2ThreadShell;
  const rootLineage = {
    rootThreadId: rootId,
    parentThreadId: null,
    relationshipToParent: null,
  } as const;
  const archivedId = ThreadId.make("thread:thread-management:refs-archived");
  const threads = [
    shell(rootId, rootLineage, null),
    shell(
      lineageChildId,
      {
        rootThreadId: rootId,
        parentThreadId: rootId,
        relationshipToParent: "subagent",
      },
      null,
    ),
    shell(nodeChildId, rootLineage, {
      type: "node",
      nodeId: NodeId.make("node:thread-management:refs-child"),
    }),
  ];
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 3,
            snapshotSequence: 10,
            threads,
            // An archived thread still holds its worktree; worktree cleanup
            // treats this RPC as the complete set, so omitting the archive
            // would classify that worktree as orphaned and remove it.
            archivedThreads: [shell(archivedId, rootLineage, null)],
          }),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;

    expect(yield* service.listAllThreadRefs()).toEqual({
      threadRefs: [...threads, shell(archivedId, rootLineage, null)].map((thread) => ({
        threadId: thread.id,
        projectId,
        worktreePath,
      })),
    });
  }).pipe(Effect.provide(testLayer));
});
