import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Queue, Stream } from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  WorkspaceRuntimeRouter,
  WorkspaceRuntimeRouterError,
} from "../../remote/Services/WorkspaceRuntimeRouter.ts";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.makeUnsafe(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const runtimeRouter = yield* WorkspaceRuntimeRouter;

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: {
          turnCount: input.turnCount,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.capture.failed",
        summary: "Checkpoint capture failed",
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const resolveSessionRuntimeForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<
    Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>
  > {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);

    const sessions = yield* runtimeRouter
      .listProviderSessions()
      .pipe(Effect.catch(() => Effect.succeed([])));

    const findSessionWithCwd = (
      session: (typeof sessions)[number] | undefined,
    ): Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }> => {
      if (!session?.cwd) {
        return Option.none();
      }
      return Option.some({ threadId: session.threadId, cwd: session.cwd });
    };

    if (thread) {
      const projectedSession = sessions.find(
        (session) => session.threadId === thread.id,
      );
      const fromProjected = findSessionWithCwd(projectedSession);
      if (Option.isSome(fromProjected)) {
        return fromProjected;
      }
    }

    return Option.none();
  });

  const captureCheckpointFromTurnCompletion = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.threadId);
    if (!thread) {
      return;
    }

    // When a primary turn is active, only that turn may produce completion checkpoints.
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
      return;
    }

    if (thread.checkpoints.some((checkpoint) => checkpoint.turnId === turnId)) {
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(thread.id);
    const checkpointCwd =
      Option.match(sessionRuntime, {
        onNone: () => undefined,
        onSome: (runtime) => runtime.cwd,
      }) ??
      resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      });
    if (!checkpointCwd) {
      yield* Effect.logWarning("checkpoint capture skipped: no active provider session cwd", {
        threadId: thread.id,
        turnId,
      });
      return;
    }
    if (!(yield* runtimeRouter.checkpointIsGitRepository({ threadId: thread.id, cwd: checkpointCwd }))) {
      yield* Effect.logDebug("checkpoint capture skipped for non-git workspace", {
        threadId: thread.id,
        turnId,
        cwd: checkpointCwd,
      });
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const nextTurnCount = currentTurnCount + 1;
    const fromTurnCount = Math.max(0, nextTurnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(thread.id, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(thread.id, nextTurnCount);

    const fromCheckpointExists = yield* runtimeRouter.checkpointHasRef({
      threadId: thread.id,
      cwd: checkpointCwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint completion missing pre-turn baseline", {
        threadId: thread.id,
        turnId,
        fromTurnCount,
      });
    }

    yield* runtimeRouter.checkpointCapture({
      threadId: thread.id,
      cwd: checkpointCwd,
      checkpointRef: targetCheckpointRef,
    });

    const files = yield* runtimeRouter
      .checkpointDiff({
        threadId: thread.id,
        cwd: checkpointCwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: thread.id,
            turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${toErrorMessage(error)}`,
            createdAt: event.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: thread.id,
            turnId,
            turnCount: nextTurnCount,
            detail: toErrorMessage(error),
          }).pipe(Effect.as([])),
        ),
      );

    const assistantMessageId =
      thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === turnId)?.id ??
      MessageId.makeUnsafe(`assistant:${turnId}`);

    const now = event.createdAt;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: thread.id,
      turnId,
      completedAt: now,
      checkpointRef: targetCheckpointRef,
      status: checkpointStatusFromRuntime(event.payload.state),
      files,
      assistantMessageId,
      checkpointTurnCount: nextTurnCount,
      createdAt: now,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: thread.id,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: nextTurnCount,
          status: event.payload.state,
        },
        turnId,
        createdAt: now,
      },
      createdAt: now,
    });
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find(
      (entry) => entry.id === event.threadId,
    );
    if (!thread) {
      return;
    }

    const checkpointCwdFromThreadOrProject = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    const checkpointCwd =
      checkpointCwdFromThreadOrProject ??
      Option.match(yield* resolveSessionRuntimeForThread(thread.id), {
        onNone: () => undefined,
        onSome: (runtime) => runtime.cwd,
      });
    if (!checkpointCwd) {
      yield* Effect.logWarning("checkpoint pre-turn capture skipped: no workspace cwd", {
        threadId: thread.id,
        turnId,
      });
      return;
    }
    if (!(yield* runtimeRouter.checkpointIsGitRepository({ threadId: thread.id, cwd: checkpointCwd }))) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
    const baselineExists = yield* runtimeRouter.checkpointHasRef({
      threadId: thread.id,
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* runtimeRouter.checkpointCapture({
      threadId: thread.id,
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fnUntraced(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return;
    }

    const checkpointCwdFromThreadOrProject = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    const checkpointCwd =
      checkpointCwdFromThreadOrProject ??
      Option.match(yield* resolveSessionRuntimeForThread(threadId), {
        onNone: () => undefined,
        onSome: (runtime) => runtime.cwd,
      });
    if (!checkpointCwd) {
      yield* Effect.logWarning("checkpoint pre-turn capture skipped: no workspace cwd", {
        threadId,
      });
      return;
    }
    if (!(yield* runtimeRouter.checkpointIsGitRepository({ threadId, cwd: checkpointCwd }))) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* runtimeRouter.checkpointHasRef({
      threadId,
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* runtimeRouter.checkpointCapture({
      threadId,
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
  });

  const handleRevertRequested = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = new Date().toISOString();

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (
      !(yield* runtimeRouter.checkpointIsGitRepository({
        threadId: event.payload.threadId,
        cwd: sessionRuntime.value.cwd,
      }))
    ) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const restored = yield* runtimeRouter.checkpointRestore({
      threadId: event.payload.threadId,
      cwd: sessionRuntime.value.cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: event.payload.turnCount === 0,
    });
    if (!restored) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* runtimeRouter.rollbackProviderConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);

    if (staleCheckpointRefs.length > 0) {
      yield* runtimeRouter.checkpointDeleteRefs({
        threadId: event.payload.threadId,
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: toErrorMessage(error),
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: toErrorMessage(error),
            createdAt: new Date().toISOString(),
          }),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.threadId,
            turnId,
            detail: toErrorMessage(error),
            createdAt: new Date().toISOString(),
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, OrchestrationDispatchError | WorkspaceRuntimeRouterError, never> =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: CheckpointReactorShape["start"] = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ReactorInput>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processInputSafely))),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return Queue.offer(queue, { source: "domain", event }).pipe(Effect.asVoid);
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(runtimeRouter.providerEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return Queue.offer(queue, { source: "runtime", event }).pipe(Effect.asVoid);
      }),
    );
  });

  return {
    start,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
