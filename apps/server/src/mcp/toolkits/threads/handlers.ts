import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadToolkit, ThreadToolError } from "./tools.ts";

const asToolFailure = (operation: string) => (cause: Cause.Cause<unknown>) =>
  Effect.fail(
    new ThreadToolError({
      operation,
      detail: Cause.pretty(cause),
    }),
  );

const runThreadOperation = <A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ThreadToolError, R> => effect.pipe(Effect.catchCause(asToolFailure(operation)));

const makeHandlers = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.requireMcpCapability("threads");
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const newId = Effect.fn("ThreadToolkit.newId")(function* () {
    return yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  });

  const currentThread = Effect.fn("ThreadToolkit.currentThread")(function* () {
    const thread = yield* query.getThreadDetailById(invocation.threadId);
    if (Option.isNone(thread)) {
      return yield* new ThreadToolError({
        operation: "thread_current",
        detail: `Current thread '${invocation.threadId}' was not found.`,
      });
    }
    return thread.value;
  });

  const projectThread = Effect.fn("ThreadToolkit.projectThread")(function* (threadId: ThreadId) {
    const [current, target] = yield* Effect.all([
      currentThread(),
      query.getThreadDetailById(threadId),
    ]);
    if (Option.isNone(target) || target.value.projectId !== current.projectId) {
      return yield* new ThreadToolError({
        operation: "thread_target",
        detail: `Thread '${threadId}' is not an active thread in the current project.`,
      });
    }
    return target.value;
  });

  const startTurn = Effect.fn("ThreadToolkit.startTurn")(function* (
    thread: OrchestrationThread,
    prompt: string,
  ) {
    const [commandUuid, messageUuid, createdAt] = yield* Effect.all([
      newId(),
      newId(),
      DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    ]);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(commandUuid),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(messageUuid),
        role: "user",
        text: prompt,
        attachments: [],
      },
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt,
    });
  });

  const resultFor = (thread: Pick<OrchestrationThread, "id" | "title">, turnStarted: boolean) => ({
    threadId: thread.id,
    title: thread.title,
    turnStarted,
  });

  return {
    thread_list: (input: { readonly includeArchived?: boolean | undefined }) =>
      Effect.gen(function* () {
        const current = yield* currentThread();
        const snapshot = yield* query.getShellSnapshot();
        return snapshot.threads
          .filter(
            (thread) =>
              thread.projectId === current.projectId &&
              (input.includeArchived === true || thread.archivedAt === null),
          )
          .map((thread: OrchestrationThreadShell) => ({
            threadId: thread.id,
            title: thread.title,
            status: thread.session?.status ?? "idle",
            createdAt: thread.createdAt,
            ...(thread.forkedFrom?.threadId
              ? { forkedFromThreadId: thread.forkedFrom.threadId }
              : {}),
            ...(thread.forkedFrom?.turnId ? { forkedFromTurnId: thread.forkedFrom.turnId } : {}),
          }));
      }),
    thread_create: (input: {
      readonly title?: string | undefined;
      readonly prompt?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const current = yield* currentThread();
        const [threadUuid, commandUuid, createdAt] = yield* Effect.all([
          newId(),
          newId(),
          DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        ]);
        const threadId = ThreadId.make(threadUuid);
        const title = input.title ?? "New thread";
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(commandUuid),
          threadId,
          projectId: current.projectId,
          title,
          modelSelection: current.modelSelection,
          runtimeMode: current.runtimeMode,
          interactionMode: current.interactionMode,
          branch: current.branch,
          worktreePath: current.worktreePath,
          createdAt,
        });
        const created = { ...current, id: threadId, title };
        if (input.prompt !== undefined) yield* startTurn(created, input.prompt);
        return resultFor(created, input.prompt !== undefined);
      }),
    thread_fork: (input: {
      readonly sourceThreadId?: ThreadId | undefined;
      readonly sourceTurnId?: import("@t3tools/contracts").TurnId | undefined;
      readonly title?: string | undefined;
      readonly prompt?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const source = yield* projectThread(input.sourceThreadId ?? invocation.threadId);
        const [threadUuid, commandUuid, createdAt] = yield* Effect.all([
          newId(),
          newId(),
          DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        ]);
        const threadId = ThreadId.make(threadUuid);
        const title = input.title ?? `${source.title} (fork)`;
        yield* engine.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(commandUuid),
          threadId,
          sourceThreadId: source.id,
          ...(input.sourceTurnId !== undefined ? { sourceTurnId: input.sourceTurnId } : {}),
          title,
          createdAt,
        });
        const forked = {
          ...source,
          id: threadId,
          title,
          forkedFrom: {
            threadId: source.id,
            turnId: input.sourceTurnId ?? source.latestTurn?.turnId ?? null,
          },
          session: null,
        };
        if (input.prompt !== undefined) yield* startTurn(forked, input.prompt);
        return resultFor(forked, input.prompt !== undefined);
      }),
    thread_send: (input: { readonly threadId: ThreadId; readonly prompt: string }) =>
      Effect.gen(function* () {
        const target = yield* projectThread(input.threadId);
        yield* startTurn(target, input.prompt);
        return resultFor(target, true);
      }),
    thread_archive: (input: { readonly threadId: ThreadId }) =>
      Effect.gen(function* () {
        if (input.threadId === invocation.threadId) {
          return yield* new ThreadToolError({
            operation: "thread_archive",
            detail: "The current agent thread cannot archive itself.",
          });
        }
        yield* projectThread(input.threadId);
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(yield* newId()),
          threadId: input.threadId,
        });
        return null;
      }),
  };
});

export const ThreadToolkitHandlers = {
  thread_list: (input: { readonly includeArchived?: boolean | undefined }) =>
    runThreadOperation(
      "thread_list",
      makeHandlers.pipe(Effect.flatMap((handlers) => handlers.thread_list(input))),
    ),
  thread_create: (input: {
    readonly title?: string | undefined;
    readonly prompt?: string | undefined;
  }) =>
    runThreadOperation(
      "thread_create",
      makeHandlers.pipe(Effect.flatMap((handlers) => handlers.thread_create(input))),
    ),
  thread_fork: (input: {
    readonly sourceThreadId?: ThreadId | undefined;
    readonly sourceTurnId?: import("@t3tools/contracts").TurnId | undefined;
    readonly title?: string | undefined;
    readonly prompt?: string | undefined;
  }) =>
    runThreadOperation(
      "thread_fork",
      makeHandlers.pipe(Effect.flatMap((handlers) => handlers.thread_fork(input))),
    ),
  thread_send: (input: { readonly threadId: ThreadId; readonly prompt: string }) =>
    runThreadOperation(
      "thread_send",
      makeHandlers.pipe(Effect.flatMap((handlers) => handlers.thread_send(input))),
    ),
  thread_archive: (input: { readonly threadId: ThreadId }) =>
    runThreadOperation(
      "thread_archive",
      makeHandlers.pipe(Effect.flatMap((handlers) => handlers.thread_archive(input))),
    ),
} satisfies Parameters<typeof ThreadToolkit.toLayer>[0];

export const ThreadToolkitHandlersLayerLive = ThreadToolkit.toLayer(ThreadToolkitHandlers);
