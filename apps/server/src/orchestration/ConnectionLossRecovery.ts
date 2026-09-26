import {
  CommandId,
  EventId,
  isToolLifecycleItemType,
  type OrchestrationEvent,
  type OrchestrationSession,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

interface Recovery {
  readonly threadId: ThreadId;
  readonly interruptedTurnId: TurnId;
  readonly interruptedSequence: number;
  reservationUpdatedAt?: string;
  interruptedSession?: OrchestrationSession;
  resumedTurnId?: TurnId;
  readonly outcomes: Map<TurnId, "resumed" | "failed" | "cancelled">;
  admitting: boolean;
  cancelRequested?: boolean;
  fiber?: Fiber.Fiber<void>;
  admissionFiber?: Fiber.Fiber<void>;
}

/** One environment owns admission; clients only display its receipts. */
export const makeConnectionLossRecovery = Effect.fnUntraced(function* (
  enqueueAdmission: (effect: Effect.Effect<void>) => Effect.Effect<void>,
) {
  const recoveryScope = yield* Effect.scope;
  const provider = yield* ProviderService;
  const turns = yield* ProjectionTurnRepository;
  const settings = yield* ServerSettingsService;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const pending = new Map<ThreadId, Recovery>();
  const seen = new Set<string>();
  const cancellations = new Map<ThreadId, Deferred.Deferred<boolean>>();

  const append = Effect.fnUntraced(function* (
    recovery: Recovery,
    state: "waiting" | "resumed" | "failed" | "cancelled",
    detail?: string,
    reason?: "unsupported" | "cancellation-failed",
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const id = yield* crypto.randomUUIDv4;
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`connection-recovery:${id}`),
      threadId: recovery.threadId,
      activity: {
        id: EventId.make(id),
        kind: `connection.recovery.${state}`,
        tone: state === "failed" ? "error" : "info",
        summary:
          state === "resumed"
            ? "Task resumed"
            : state === "waiting"
              ? "Connection lost. Waiting to resume…"
              : state === "failed"
                ? "Automatic resume unavailable"
                : "Automatic resume cancelled",
        turnId: recovery.interruptedTurnId,
        payload: {
          interruptedTurnId: recovery.interruptedTurnId,
          ...(recovery.resumedTurnId ? { resumedTurnId: recovery.resumedTurnId } : {}),
          ...(detail ? { detail } : {}),
          ...(reason ? { reason } : {}),
        },
        createdAt: now,
      },
      createdAt: now,
    });
  });

  const current = (recovery: Recovery) =>
    pending.get(recovery.threadId) === recovery && recovery.cancelRequested !== true;
  const eligible = Effect.fnUntraced(function* (recovery: Recovery) {
    if (!current(recovery) || !(yield* settings.getSettings).resumeThreadsAfterConnectionLoss)
      return undefined;
    const thread = Option.getOrUndefined(yield* query.getThreadShellById(recovery.threadId));
    if (
      !thread ||
      thread.archivedAt !== null ||
      thread.settledAt !== null ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.latestTurn?.turnId !== recovery.interruptedTurnId ||
      thread.latestTurn.state !== "error" ||
      thread.session?.status !== "error" ||
      thread.session.activeTurnId !== null
    )
      return undefined;
    if (Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId: recovery.threadId })))
      return undefined;
    if (!current(recovery)) return undefined;
    return thread;
  });

  const hasLaterUserIntent = Effect.fnUntraced(function* (
    recovery: Recovery,
    snapshotSequence: number,
  ) {
    const event = yield* engine
      .readThreadEvents({
        threadId: recovery.threadId,
        fromSequenceExclusive: recovery.interruptedSequence,
        toSequenceInclusive: snapshotSequence,
        limit: snapshotSequence - recovery.interruptedSequence,
      })
      .pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.turn-start-requested" ||
            event.type === "thread.turn-interrupt-requested" ||
            event.type === "thread.session-stop-requested" ||
            event.type === "thread.archived" ||
            event.type === "thread.deleted" ||
            event.type === "thread.settled",
        ),
        Stream.runHead,
      );
    return Option.isSome(event);
  });

  const releaseReservation = Effect.fnUntraced(function* (recovery: Recovery) {
    if (!recovery.reservationUpdatedAt || !recovery.interruptedSession) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { snapshotSequence } = yield* query.getSnapshotSequence();
      const thread = Option.getOrUndefined(yield* query.getThreadShellById(recovery.threadId));
      if (
        thread?.session?.status !== "starting" ||
        thread.session.updatedAt !== recovery.reservationUpdatedAt ||
        thread.latestTurn?.turnId !== recovery.interruptedTurnId
      )
        return;
      const now = DateTime.formatIso(yield* DateTime.now);
      const released = yield* engine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`connection-release:${yield* crypto.randomUUIDv4}`),
          threadId: recovery.threadId,
          session: {
            ...recovery.interruptedSession,
            status: "error",
            activeTurnId: null,
            updatedAt: now,
          },
          recoveryAdmission: {
            interruptedTurnId: recovery.interruptedTurnId,
            expectedSnapshotSequence: snapshotSequence,
            reservationUpdatedAt: recovery.reservationUpdatedAt,
          },
          createdAt: now,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
        );
      if (released) return;
    }
  });

  const finish = Effect.fnUntraced(function* (
    recovery: Recovery,
    state: "failed" | "cancelled" | "resumed",
    detail?: string,
    reason?: "unsupported" | "cancellation-failed",
  ) {
    if (!current(recovery)) return;
    pending.delete(recovery.threadId);
    if (state !== "resumed") yield* releaseReservation(recovery);
    if (state === "resumed" && recovery.resumedTurnId)
      seen.delete(`${recovery.threadId}:${recovery.resumedTurnId}`);
    yield* append(recovery, state, detail, reason);
  });

  const stopNative = Effect.fnUntraced(function* (recovery: Recovery) {
    const threadId = recovery.threadId;
    if (recovery.resumedTurnId) {
      yield* provider
        .interruptTurn({ threadId, turnId: recovery.resumedTurnId })
        .pipe(Effect.catch(() => provider.stopSession({ threadId })));
    } else if (recovery.admitting) {
      // A turn/start can be accepted without delivering its reply. Closing this
      // session cancels that ambiguity and preserves its cursor for later work.
      yield* provider.stopSession({ threadId });
    }
  });

  const cancel = Effect.fnUntraced(function* (threadId: ThreadId, fromAdmission = false) {
    const inFlight = cancellations.get(threadId);
    if (inFlight) return yield* Deferred.await(inFlight);
    const recovery = pending.get(threadId);
    if (!recovery) return true;
    const settled = yield* Deferred.make<boolean>();
    cancellations.set(threadId, settled);
    recovery.cancelRequested = true;
    let stopped = false;
    return yield* Effect.gen(function* () {
      // Block later user work until native cancellation finishes. Cancelling a
      // local RPC wait does not undo a turn/start already accepted by Codex.
      if (recovery.fiber) yield* Fiber.interrupt(recovery.fiber);
      if (recovery.admissionFiber && !fromAdmission)
        yield* Fiber.interrupt(recovery.admissionFiber);
      yield* stopNative(recovery);
      yield* releaseReservation(recovery);
      yield* append(
        recovery,
        fromAdmission ? "failed" : "cancelled",
        fromAdmission
          ? "Could not resume this task automatically. Send a message to continue."
          : undefined,
      );
      pending.delete(threadId);
      stopped = true;
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : append(
              recovery,
              "failed",
              "Could not stop the automatic continuation. Use Stop before continuing.",
              "cancellation-failed",
            ).pipe(Effect.as(false)),
      ),
      Effect.ensuring(
        Effect.sync(() => cancellations.delete(threadId)).pipe(
          Effect.andThen(Effect.suspend(() => Deferred.succeed(settled, stopped))),
        ),
      ),
    );
  });

  const recover = Effect.fnUntraced(function* (recovery: Recovery) {
    let delay = 2_000;
    while (current(recovery)) {
      if (!(yield* eligible(recovery))) return yield* finish(recovery, "cancelled");
      const connected = yield* (
        provider.checkConnection?.(recovery.threadId) ?? Effect.succeed(undefined)
      );
      if (connected === undefined) {
        return yield* finish(
          recovery,
          "failed",
          "Automatic resume is not supported by this provider connection. Send a message to continue.",
          "unsupported",
        );
      }
      if (!connected) {
        yield* Effect.sleep(delay);
        delay = Math.min(delay * 2, 60_000);
        continue;
      }
      const admissionSettled = yield* Deferred.make<boolean>();
      let retryAdmission = false;
      const admission = Effect.gen(function* () {
        // Admission shares the provider command worker with user turns and Stop.
        // Resolve capabilities before the final intent check, since it can yield.
        const before = yield* eligible(recovery);
        if (!before) return yield* finish(recovery, "cancelled");
        const capabilities = yield* provider.getCapabilities(
          before.session?.providerInstanceId ?? before.modelSelection.instanceId,
        );
        let reserved = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const { snapshotSequence } = yield* query.getSnapshotSequence();
          const thread = yield* eligible(recovery);
          if (!thread || !thread.session || (yield* hasLaterUserIntent(recovery, snapshotSequence)))
            return yield* finish(recovery, "cancelled");
          const now = DateTime.formatIso(yield* DateTime.now);
          // Once dispatch queues the command, cancellation must wait for its
          // receipt so it can release a reservation that committed meanwhile.
          recovery.reservationUpdatedAt = now;
          recovery.interruptedSession = thread.session;
          reserved = yield* engine
            .dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`connection-admission:${yield* crypto.randomUUIDv4}`),
              threadId: recovery.threadId,
              session: {
                ...thread.session,
                status: "starting",
                activeTurnId: null,
                lastError: null,
                updatedAt: now,
              },
              recoveryAdmission: {
                interruptedTurnId: recovery.interruptedTurnId,
                expectedSnapshotSequence: snapshotSequence,
              },
              createdAt: now,
            })
            .pipe(
              Effect.uninterruptible,
              Effect.as(true),
              Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
            );
          if (reserved) break;
        }
        if (!reserved) {
          retryAdmission = true;
          return;
        }
        const enabled = (yield* settings.getSettings).resumeThreadsAfterConnectionLoss;
        if (!enabled || !current(recovery)) {
          yield* releaseReservation(recovery);
          return yield* finish(recovery, "cancelled");
        }
        recovery.admitting = true;
        const started = yield* provider.sendTurn({
          threadId: recovery.threadId,
          ...(capabilities.promptlessTurnContinuation === true
            ? { continuation: true }
            : {
                input:
                  "Continue the interrupted task from its existing conversation and work. The connection was lost. Do not repeat completed work.",
              }),
          interactionMode: before.interactionMode,
        });
        recovery.resumedTurnId = started.turnId;
        recovery.admitting = false;
        if (!current(recovery)) return;
        seen.add(`${recovery.threadId}:${started.turnId}`);
        const outcome = recovery.outcomes.get(started.turnId);
        if (outcome)
          yield* finish(
            recovery,
            outcome,
            outcome === "failed"
              ? "The resumed task could not continue. Send a message to continue."
              : undefined,
          );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : cancel(recovery.threadId, true).pipe(Effect.asVoid, Effect.ignoreCause),
        ),
        Effect.ensuring(Effect.suspend(() => Deferred.succeed(admissionSettled, retryAdmission))),
      );
      yield* enqueueAdmission(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkIn(
            Deferred.await(ready).pipe(Effect.andThen(admission)),
            recoveryScope,
          );
          recovery.admissionFiber = fiber;
          if (!current(recovery)) {
            yield* Fiber.interrupt(fiber);
            return;
          }
          yield* Deferred.succeed(ready, undefined);
          yield* Fiber.join(fiber);
        }).pipe(Effect.ignoreCause),
      );
      if (yield* Deferred.await(admissionSettled)) {
        yield* Effect.sleep(delay);
        delay = Math.min(delay * 2, 60_000);
        continue;
      }
      return;
    }
  });

  const process = Effect.fnUntraced(function* (event: OrchestrationEvent | ProviderRuntimeEvent) {
    if (
      event.type === "thread.activity-appended" &&
      event.payload.activity.kind === "connection.interrupted"
    ) {
      const turnId = event.payload.activity.turnId;
      if (!turnId || !(yield* settings.getSettings).resumeThreadsAfterConnectionLoss) return;
      const threadId = event.payload.threadId;
      const key = `${threadId}:${turnId}`;
      if (seen.has(key)) return;
      seen.add(key);
      // The bounded cache only suppresses redelivery; eligibility still rejects stale turns.
      if (seen.size > 10_000) seen.delete(seen.values().next().value!);
      if (cancellations.has(threadId)) return;
      const existing = pending.get(threadId);
      if (existing?.cancelRequested) return;
      if (existing && (existing.admitting || existing.resumedTurnId)) {
        return yield* finish(
          existing,
          "failed",
          "The resumed task could not continue. Send a message to continue.",
        );
      }
      if (!(yield* cancel(threadId))) return;
      const recovery: Recovery = {
        threadId,
        interruptedTurnId: turnId,
        interruptedSequence: event.sequence,
        admitting: false,
        outcomes: new Map(),
      };
      pending.set(threadId, recovery);
      if (!(yield* eligible(recovery))) return yield* finish(recovery, "cancelled");
      yield* append(recovery, "waiting");
      recovery.fiber = yield* recover(recovery).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : finish(
                recovery,
                "failed",
                "Could not resume this task automatically. Send a message to continue.",
              ).pipe(Effect.ignoreCause),
        ),
        Effect.forkScoped,
      );
      return;
    }
    if (!("threadId" in event)) return;
    const recovery = pending.get(event.threadId);
    if (!recovery || recovery.cancelRequested) return;
    const isRequest = event.type === "request.opened" || event.type === "user-input.requested";
    if (isRequest && !recovery.admitting && recovery.resumedTurnId === undefined) {
      yield* cancel(event.threadId);
      return;
    }
    if (!event.turnId || event.turnId === recovery.interruptedTurnId) return;
    if (recovery.resumedTurnId !== event.turnId && !recovery.admitting) return;
    const outcome =
      event.type === "turn.aborted"
        ? "cancelled"
        : event.type === "turn.completed" && event.payload.state !== "completed"
          ? "failed"
          : isRequest ||
              (event.type === "content.delta" && event.payload.delta.length > 0) ||
              (event.type === "item.started" && isToolLifecycleItemType(event.payload.itemType)) ||
              (event.type === "turn.completed" && event.payload.state === "completed")
            ? "resumed"
            : undefined;
    if (!outcome) return;
    if (recovery.resumedTurnId === event.turnId)
      return yield* finish(
        recovery,
        outcome,
        outcome === "failed"
          ? "The resumed task could not continue. Send a message to continue."
          : undefined,
      );
    // Native events may precede the admission RPC response. Hold evidence by id
    // until that response identifies our turn; unrelated background turns cannot win.
    if (recovery.admitting && recovery.outcomes.size < 16 && !recovery.outcomes.has(event.turnId))
      recovery.outcomes.set(event.turnId, outcome);
  });
  const worker = yield* makeDrainableWorker((event: OrchestrationEvent | ProviderRuntimeEvent) =>
    process(event).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("connection recovery event failed", { cause }),
      ),
    ),
  );

  const handleDomainEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.turn-interrupt-requested":
      case "thread.session-stop-requested":
        if (event.payload.turnId) {
          seen.add(`${event.payload.threadId}:${event.payload.turnId}`);
          if (seen.size > 10_000) seen.delete(seen.values().next().value!);
        }
        return cancel(event.payload.threadId).pipe(Effect.orElseSucceed(() => false));
      case "thread.turn-start-requested":
      case "thread.archived":
      case "thread.deleted":
      case "thread.settled":
        return cancel(event.payload.threadId).pipe(Effect.orElseSucceed(() => false));
      case "thread.activity-appended":
        return event.payload.activity.kind === "connection.interrupted"
          ? worker.enqueue(event).pipe(Effect.as(true))
          : Effect.succeed(true);
      default:
        return Effect.succeed(true);
    }
  };
  const start = Effect.fnUntraced(function* () {
    const changes = yield* settings.subscribeChanges;
    // Pending probes belong to this process. A previous process's waiting notice
    // must not survive as a promise of recovery after an unrelated restart.
    const { threads } = yield* query.getCommandReadModel();
    for (const thread of threads) {
      if (
        thread.latestTurn?.state !== "error" &&
        thread.session?.status !== "starting" &&
        thread.session?.status !== "error"
      )
        continue;
      const detail = Option.getOrUndefined(
        yield* query.getThreadDetailById(thread.id, {
          activityKinds: [
            "connection.recovery.waiting",
            "connection.recovery.resumed",
            "connection.recovery.failed",
            "connection.recovery.cancelled",
          ],
        }),
      );
      const last = detail?.activities.at(-1);
      if (last?.kind === "connection.recovery.waiting" && last.turnId) {
        yield* append(
          {
            threadId: thread.id,
            interruptedTurnId: last.turnId,
            interruptedSequence: 0,
            admitting: false,
            outcomes: new Map(),
          },
          "cancelled",
        );
      }
    }
    yield* forkParked(
      Stream.runForEach(changes, (value) =>
        value.resumeThreadsAfterConnectionLoss
          ? Effect.void
          : Effect.forEach(
              [...pending.keys()],
              (threadId) => cancel(threadId).pipe(Effect.ignoreCause),
              { discard: true },
            ),
      ),
    );
    yield* forkParked(
      Stream.runForEach(provider.streamEvents, (event) =>
        pending.has(event.threadId) ? worker.enqueue(event) : Effect.void,
      ),
    );
  });
  return { start, handleDomainEvent, drain: worker.drain };
});
