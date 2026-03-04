import {
  CommandId,
  EventId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  RuntimeSessionId,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Queue, Stream } from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { OrchestrationDispatchError } from "../Errors.ts";

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

function toProviderThreadId(value: string | undefined): ProviderThreadId | null {
  return value === undefined ? null : ProviderThreadId.makeUnsafe(String(value));
}

function toProviderSessionId(value: RuntimeSessionId): ProviderSessionId {
  return ProviderSessionId.makeUnsafe(String(value));
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

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;

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
    readonly sessionId: ProviderSessionId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find(
        (entry) => entry.session?.providerSessionId === input.sessionId,
      );
      if (!thread) {
        return;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("checkpoint-capture-failure"),
        threadId: thread.id,
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
    });

  const resolveSessionRuntimeForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<
    Option.Option<{ readonly sessionId: ProviderSessionId; readonly cwd: string }>
  > {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    const projectedSessionId = thread?.session?.providerSessionId ?? null;
    const projectedProviderThreadId = thread?.session?.providerThreadId ?? undefined;

    const sessions = yield* providerService.listSessions();

    const findSessionWithCwd = (
      session: (typeof sessions)[number] | undefined,
    ): Option.Option<{ readonly sessionId: ProviderSessionId; readonly cwd: string }> => {
      if (!session?.cwd) {
        return Option.none();
      }
      return Option.some({ sessionId: session.sessionId, cwd: session.cwd });
    };

    if (projectedSessionId !== null) {
      const projectedSession = sessions.find((session) => session.sessionId === projectedSessionId);
      const fromProjected = findSessionWithCwd(projectedSession);
      if (Option.isSome(fromProjected)) {
        return fromProjected;
      }
    }

    if (projectedProviderThreadId) {
      const matchedSession = sessions.find(
        (session) => session.threadId === projectedProviderThreadId,
      );
      const fromProviderThread = findSessionWithCwd(matchedSession);
      if (Option.isSome(fromProviderThread)) {
        return fromProviderThread;
      }
    }

    return Option.none();
  });

  const captureCheckpointFromTurnCompletion = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const providerSessionId = toProviderSessionId(event.sessionId);
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find(
      (entry) => entry.session?.providerSessionId === providerSessionId,
    );
    if (!thread) {
      return;
    }

    const projectedProviderThreadId = thread.session?.providerThreadId ?? null;
    const eventProviderThreadId = toProviderThreadId(event.threadId);
    if (
      projectedProviderThreadId !== null &&
      eventProviderThreadId !== null &&
      !sameId(projectedProviderThreadId, eventProviderThreadId)
    ) {
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

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const nextTurnCount = currentTurnCount + 1;
    const fromTurnCount = Math.max(0, nextTurnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(thread.id, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(thread.id, nextTurnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
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

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: targetCheckpointRef,
    });

    const files = yield* checkpointStore
      .diffCheckpoints({
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
            sessionId: providerSessionId,
            turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: event.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: thread.id,
            turnId,
            turnCount: nextTurnCount,
            detail: error.message,
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
    const providerSessionId = toProviderSessionId(event.sessionId);
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find(
      (entry) => entry.session?.providerSessionId === providerSessionId,
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

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
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

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
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

    const restored = yield* checkpointStore.restoreCheckpoint({
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
      yield* providerService.rollbackConversation({
        sessionId: sessionRuntime.value.sessionId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
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
            detail: error.message,
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
            detail: error.message,
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
            sessionId: toProviderSessionId(event.sessionId),
            turnId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
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
      Stream.runForEach(providerService.streamEvents, (event) => {
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
