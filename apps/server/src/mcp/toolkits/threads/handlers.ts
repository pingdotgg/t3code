import {
  CommandId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadsCreateInput,
  type ThreadsCreateResult,
  type ThreadsListInput,
  type ThreadsListResult,
  ThreadsSurfaceError,
  type ThreadsListItem,
  THREADS_SURFACE_LIST_DEFAULT_LIMIT,
  THREADS_SURFACE_LIST_MAX_LIMIT,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadsToolkit } from "./tools.ts";

const failFrom = (operation: ThreadsSurfaceError["operation"], detail: string) =>
  Effect.mapError((cause: unknown) => new ThreadsSurfaceError({ operation, detail, cause }));

const isThreadSettled = (thread: OrchestrationReadModel["threads"][number]): boolean =>
  thread.settledOverride === "settled" ||
  (thread.settledOverride === null && thread.settledAt !== null);

/**
 * Shapes live read-model threads into the tool's result: filtered by project
 * and settled state, newest first by instant (ISO strings can carry offsets,
 * so they are parsed rather than compared as text), capped by the input limit.
 */
export const threadsListItems = (
  threads: ReadonlyArray<OrchestrationReadModel["threads"][number]>,
  input: ThreadsListInput,
): ThreadsListItem[] =>
  threads
    .filter((thread) => thread.deletedAt === null && thread.archivedAt === null)
    .filter((thread) => input.projectId === undefined || thread.projectId === input.projectId)
    .filter((thread) => {
      if (input.filter === "settled") return isThreadSettled(thread);
      if (input.filter === "active") return !isThreadSettled(thread);
      return true;
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(
      0,
      Math.min(input.limit ?? THREADS_SURFACE_LIST_DEFAULT_LIMIT, THREADS_SURFACE_LIST_MAX_LIMIT),
    )
    .map((thread) => ({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      settled: isThreadSettled(thread),
      updatedAt: thread.updatedAt,
    }));

const threadsList = (input: ThreadsListInput) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const readModel = yield* query
      .getCommandReadModel()
      .pipe(failFrom("threads_list", "Failed to load the environment's threads."));

    return { threads: threadsListItems(readModel.threads, input) } satisfies ThreadsListResult;
  });

const threadsCreate = (input: ThreadsCreateInput) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const readModel = yield* query
      .getCommandReadModel()
      .pipe(failFrom("threads_create", "Failed to load the environment's threads."));

    const callingThread = readModel.threads.find((thread) => thread.id === scope.threadId);
    if (!callingThread) {
      return yield* Effect.fail(
        new ThreadsSurfaceError({
          operation: "threads_create",
          detail: "Calling thread no longer exists; cannot derive the target project.",
        }),
      );
    }
    const projectId = input.projectId ?? callingThread.projectId;
    const targetProject = readModel.projects.find((project) => project.id === projectId);
    if (!targetProject || targetProject.deletedAt !== null) {
      return yield* Effect.fail(
        new ThreadsSurfaceError({
          operation: "threads_create",
          detail: `Project ${projectId} does not exist in this environment.`,
        }),
      );
    }

    const crypto = yield* Crypto.Crypto;
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`threads-create:${uuid}`),
        threadId: ThreadId.make(uuid),
        projectId,
        title: input.title,
        modelSelection: callingThread.modelSelection,
        runtimeMode: callingThread.runtimeMode,
        interactionMode: callingThread.interactionMode,
        branch: null,
        worktreePath: null,
        source: "agent",
        createdAt,
      })
      .pipe(failFrom("threads_create", "Failed to create the thread."));

    return { threadId: ThreadId.make(uuid), title: input.title } satisfies ThreadsCreateResult;
  });

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer({
  threads_list: threadsList,
  threads_create: threadsCreate,
});
