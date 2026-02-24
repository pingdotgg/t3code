import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProviderSessionId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Queue, Stream } from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { CheckpointDiffBlobRepository } from "../../persistence/Services/CheckpointDiffBlobs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { OrchestrationDispatchError } from "../Errors.ts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  const encodedThreadId = Buffer.from(threadId, "utf8").toString("base64url");
  return CheckpointRef.makeUnsafe(`${CHECKPOINT_REFS_PREFIX}/${encodedThreadId}/turn/${turnCount}`);
}

function toTurnId(value: string | undefined): TurnId | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? TurnId.makeUnsafe(normalized) : null;
}

function trimToNonEmpty(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
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
  const checkpointDiffBlobRepository = yield* CheckpointDiffBlobRepository;

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

    const sessions = yield* providerService.listSessions();

    const findSessionWithCwd = (
      session: (typeof sessions)[number] | undefined,
    ): Option.Option<{ readonly sessionId: ProviderSessionId; readonly cwd: string }> => {
      const cwd = session?.cwd?.trim();
      if (!session || !cwd) {
        return Option.none();
      }
      return Option.some({ sessionId: session.sessionId, cwd });
    };

    if (projectedSessionId !== null) {
      const projectedSession = sessions.find((session) => session.sessionId === projectedSessionId);
      const fromProjected = findSessionWithCwd(projectedSession);
      if (Option.isSome(fromProjected)) {
        return fromProjected;
      }
    }

    const matchedSession = sessions.find((session) => session.threadId?.trim() === threadId.trim());
    return findSessionWithCwd(matchedSession);
  });

  const persistDiffBlobFromTurnCompletion = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const toTurnCount = event.payload.checkpointTurnCount;
    const fromTurnCount = Math.max(0, toTurnCount - 1);

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    if (!thread) {
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* Effect.logWarning(
        "checkpoint diff blob skipped: no active provider session cwd for thread",
        {
          threadId: event.payload.threadId,
          fromTurnCount,
          toTurnCount,
        },
      );
      return;
    }

    const fromCheckpointRef =
      fromTurnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === fromTurnCount)
            ?.checkpointRef;

    if (!fromCheckpointRef) {
      yield* Effect.logWarning("checkpoint diff blob skipped: missing from checkpoint ref", {
        threadId: event.payload.threadId,
        fromTurnCount,
        toTurnCount,
      });
      return;
    }

    const diff = yield* checkpointStore.diffCheckpoints({
      cwd: sessionRuntime.value.cwd,
      fromCheckpointRef,
      toCheckpointRef: event.payload.checkpointRef,
      fallbackFromToHead: false,
    });

    yield* checkpointDiffBlobRepository.upsert({
      threadId: event.payload.threadId,
      fromTurnCount,
      toTurnCount,
      diff,
      createdAt: event.payload.completedAt,
    });
  });

  const captureCheckpointFromTurnCompletion = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find(
      (entry) => entry.session?.providerSessionId === event.sessionId,
    );
    if (!thread) {
      return;
    }

    if (thread.checkpoints.some((checkpoint) => checkpoint.turnId === turnId)) {
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(thread.id);
    if (Option.isNone(sessionRuntime)) {
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
      cwd: sessionRuntime.value.cwd,
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
      cwd: sessionRuntime.value.cwd,
      checkpointRef: targetCheckpointRef,
    });

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: sessionRuntime.value.cwd,
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
      status: checkpointStatusFromRuntime(event.status),
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
          ...(event.status !== undefined ? { status: event.status } : {}),
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
      (entry) => entry.session?.providerSessionId === event.sessionId,
    );
    if (!thread) {
      return;
    }

    const checkpointCwdFromThread = trimToNonEmpty(thread.worktreePath);
    const checkpointCwd =
      checkpointCwdFromThread ??
      Option.match(yield* resolveSessionRuntimeForThread(thread.id), {
        onNone: () => undefined,
        onSome: (runtime) => runtime.cwd,
      });
    if (!checkpointCwd) {
      yield* Effect.logWarning(
        "checkpoint pre-turn capture skipped: no workspace cwd",
        {
          threadId: thread.id,
          turnId,
        },
      );
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
    event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" | "thread.message-sent" }>,
  ) {
    if (event.type === "thread.message-sent") {
      if (event.payload.role !== "user" || event.payload.streaming || event.payload.turnId !== null) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return;
    }

    const checkpointCwdFromThread = trimToNonEmpty(thread.worktreePath);
    const checkpointCwd =
      checkpointCwdFromThread ??
      Option.match(yield* resolveSessionRuntimeForThread(threadId), {
        onNone: () => undefined,
        onSome: (runtime) => runtime.cwd,
      });
    if (!checkpointCwd) {
      yield* Effect.logWarning(
        "checkpoint pre-turn capture skipped: no workspace cwd",
        {
          threadId,
        },
      );
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
        Effect.forkScoped,
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.turn-diff-completed") {
      yield* persistDiffBlobFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.logWarning("checkpoint diff blob persistence failed", {
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            detail: error.message,
          }),
        ),
      );
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
            sessionId: event.sessionId,
            turnId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      return;
    }

    if (event.type === "checkpoint.captured") {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find(
        (entry) => entry.session?.providerSessionId === event.sessionId,
      );
      if (!thread) {
        return;
      }

      if (
        thread.checkpoints.some(
          (checkpoint) =>
            checkpoint.turnId === turnId || checkpoint.checkpointTurnCount === event.turnCount,
        )
      ) {
        return;
      }

      const sessionRuntime = yield* resolveSessionRuntimeForThread(thread.id);
      if (Option.isNone(sessionRuntime)) {
        return;
      }

      const fromTurnCount = Math.max(0, event.turnCount - 1);
      const fromCheckpointRef = checkpointRefForThreadTurn(thread.id, fromTurnCount);
      const targetCheckpointRef = checkpointRefForThreadTurn(thread.id, event.turnCount);

      const targetExists = yield* checkpointStore.hasCheckpointRef({
        cwd: sessionRuntime.value.cwd,
        checkpointRef: targetCheckpointRef,
      });
      if (!targetExists) {
        yield* checkpointStore.captureCheckpoint({
          cwd: sessionRuntime.value.cwd,
          checkpointRef: targetCheckpointRef,
        });
      }

      const files = yield* checkpointStore
        .diffCheckpoints({
          cwd: sessionRuntime.value.cwd,
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
          Effect.catch(() => Effect.succeed([])),
        );

      const assistantMessageId =
        thread.messages
          .toReversed()
          .find((entry) => entry.role === "assistant" && entry.turnId === turnId)?.id ??
        MessageId.makeUnsafe(`assistant:${turnId}`);

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: serverCommandId("checkpoint-runtime-captured-diff-complete"),
        threadId: thread.id,
        turnId,
        completedAt: event.createdAt,
        checkpointRef: targetCheckpointRef,
        status: checkpointStatusFromRuntime(event.status),
        files,
        assistantMessageId,
        checkpointTurnCount: event.turnCount,
        createdAt: event.createdAt,
      });
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const start: CheckpointReactorShape["start"] = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ReactorInput>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processInput))));

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.turn-diff-completed" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return Queue.offer(queue, { source: "domain", event }).pipe(Effect.asVoid);
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "checkpoint.captured"
        ) {
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
