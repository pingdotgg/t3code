import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type OrchestrationArchiveThreadInput,
  type OrchestrationArchiveThreadResult,
  type OrchestrationCreateThreadInput,
  type OrchestrationCreateThreadResult,
  type OrchestrationListProjectsResult,
  type OrchestrationListThreadsInput,
  type OrchestrationListThreadsResult,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationToolkit } from "./tools.ts";

const listProjects = Effect.fn("McpOrchestration.listProjects")(function* (): Effect.fn.Return<
  OrchestrationListProjectsResult,
  OrchestrationGetSnapshotError,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery
> {
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const snapshot = yield* snapshotQuery.getShellSnapshot().pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: "Failed to load projects.",
          cause,
        }),
    ),
  );
  return { projects: snapshot.projects };
});

const listThreads = Effect.fn("McpOrchestration.listThreads")(function* (
  input: OrchestrationListThreadsInput,
): Effect.fn.Return<
  OrchestrationListThreadsResult,
  OrchestrationGetSnapshotError,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery
> {
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const snapshot = yield* snapshotQuery.getShellSnapshot().pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: "Failed to load threads.",
          cause,
        }),
    ),
  );
  return { threads: snapshot.threads.filter((thread) => thread.projectId === input.projectId) };
});

const createThread = Effect.fn("McpOrchestration.createThread")(function* (
  input: OrchestrationCreateThreadInput,
): Effect.fn.Return<
  OrchestrationCreateThreadResult,
  OrchestrationDispatchCommandError | OrchestrationGetSnapshotError,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery | OrchestrationEngine.OrchestrationEngineService
> {
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const project = yield* snapshotQuery.getProjectShellById(input.projectId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: `Failed to load project '${input.projectId}'.`,
          cause,
        }),
    ),
  );
  if (Option.isNone(project)) {
    return yield* new OrchestrationDispatchCommandError({
      message: `Project '${input.projectId}' was not found.`,
    });
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const threadId = ThreadId.make(globalThis.crypto.randomUUID());
  const modelSelection =
    input.modelSelection ??
    project.value.defaultModelSelection ??
    ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection();
  const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;

  yield* orchestrationEngine
    .dispatch({
      type: "thread.create",
      commandId: CommandId.make(`mcp:thread-create:${globalThis.crypto.randomUUID()}`),
      threadId,
      projectId: project.value.id,
      title: input.title ?? "New thread",
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
      createdAt,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to create thread.",
            cause,
          }),
      ),
    );

  const createdThread = yield* snapshotQuery.getThreadShellById(threadId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: "Thread was created but could not be reloaded from the projection.",
          cause,
        }),
    ),
  );
  if (Option.isNone(createdThread)) {
    return yield* new OrchestrationGetSnapshotError({
      message: "Thread was created but could not be reloaded from the projection.",
    });
  }

  return { thread: createdThread.value };
});

const archiveThread = Effect.fn("McpOrchestration.archiveThread")(function* (
  input: OrchestrationArchiveThreadInput,
): Effect.fn.Return<
  OrchestrationArchiveThreadResult,
  OrchestrationDispatchCommandError | OrchestrationGetSnapshotError,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery | OrchestrationEngine.OrchestrationEngineService
> {
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const currentThread = yield* snapshotQuery.getThreadShellById(input.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: `Failed to load thread '${input.threadId}'.`,
          cause,
        }),
    ),
  );
  if (Option.isNone(currentThread)) {
    return yield* new OrchestrationDispatchCommandError({
      message: `Thread '${input.threadId}' was not found.`,
    });
  }

  if (currentThread.value.archivedAt !== null) {
    return { thread: currentThread.value };
  }

  yield* orchestrationEngine
    .dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`mcp:thread-archive:${globalThis.crypto.randomUUID()}`),
      threadId: input.threadId,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to archive thread.",
            cause,
          }),
      ),
    );

  const archivedThread = yield* snapshotQuery.getThreadShellById(input.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: "Thread was archived but could not be reloaded from the projection.",
          cause,
        }),
    ),
  );
  if (Option.isNone(archivedThread)) {
    return yield* new OrchestrationGetSnapshotError({
      message: "Thread was archived but could not be reloaded from the projection.",
    });
  }

  return { thread: archivedThread.value };
});

const handlers = {
  projects_list: () => listProjects(),
  threads_list: (input) => listThreads(input),
  threads_create: (input) => createThread(input),
  threads_archive: (input) => archiveThread(input),
} satisfies Parameters<typeof OrchestrationToolkit.toLayer>[0];

export const OrchestrationToolkitHandlersLive = OrchestrationToolkit.toLayer(handlers);
