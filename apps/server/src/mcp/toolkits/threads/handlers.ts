import {
  CommandId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadsCreateInput,
  type ThreadsCreateResult,
  type ThreadsListInput,
  type ThreadsListResult,
  type ThreadsSurfaceError,
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

const fail = (detail: string) =>
  Effect.fail<ThreadsSurfaceError>({ _tag: "ThreadsSurfaceError", detail });

const failFrom = (error: { readonly message: string }) => fail(error.message);

const isThreadSettled = (thread: OrchestrationReadModel["threads"][number]): boolean =>
  thread.settledOverride === "settled" ||
  (thread.settledOverride === null && thread.settledAt !== null);

const liveThreads = (readModel: OrchestrationReadModel) =>
  readModel.threads.filter((thread) => thread.deletedAt === null && thread.archivedAt === null);

const threadsList = (input: ThreadsListInput) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const readModel = yield* query.getCommandReadModel().pipe(Effect.catch(failFrom));

    const threads = liveThreads(readModel)
      .filter((thread) => input.projectId === undefined || thread.projectId === input.projectId)
      .filter((thread) => {
        if (input.filter === "settled") return isThreadSettled(thread);
        if (input.filter === "active") return !isThreadSettled(thread);
        return true;
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(
        0,
        Math.min(input.limit ?? THREADS_SURFACE_LIST_DEFAULT_LIMIT, THREADS_SURFACE_LIST_MAX_LIMIT),
      );

    const items: ThreadsListItem[] = threads.map((thread) => ({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      settled: isThreadSettled(thread),
      updatedAt: thread.updatedAt,
    }));
    return { threads: items } satisfies ThreadsListResult;
  });

const threadsCreate = (input: ThreadsCreateInput) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const readModel = yield* query.getCommandReadModel().pipe(Effect.catch(failFrom));

    const callingThread = readModel.threads.find((thread) => thread.id === scope.threadId);
    if (!callingThread) {
      return yield* fail("Calling thread no longer exists; cannot derive the target project.");
    }
    const projectId = input.projectId ?? callingThread.projectId;
    if (!readModel.projects.some((project) => project.id === projectId)) {
      return yield* fail(`Project ${projectId} does not exist in this environment.`);
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
      .pipe(Effect.catch(failFrom));

    return { threadId: ThreadId.make(uuid), title: input.title } satisfies ThreadsCreateResult;
  });

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer({
  threads_list: threadsList,
  threads_create: threadsCreate,
});
