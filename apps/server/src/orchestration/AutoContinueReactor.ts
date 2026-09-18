import { CommandId, MessageId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Fires scheduled "continue when the limit resets" turns. The schedule is a
 * persisted thread field (`autoContinueAt`, written by thread.auto-continue.set),
 * so it survives restarts: each sweep re-reads the shell snapshot and triggers
 * every due thread. The decider validates the schedule again at fire time
 * (compare-and-set on the timestamp), so a cancel or reschedule that raced a
 * sweep wins over the stale trigger, and duplicate sweeps are no-ops.
 */
export class AutoContinueReactor extends Context.Service<
  AutoContinueReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/AutoContinueReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const sweep = Effect.fn("AutoContinueReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const nowMs = Date.parse(DateTime.formatIso(yield* DateTime.now));
    // Archived threads keep no schedule (archive clears it in the decider),
    // but guard anyway: firing into an archived thread would be rejected and
    // logged every minute until the stale row is repaired.
    const due = snapshot.threads.filter(
      (thread) =>
        thread.autoContinueAt != null &&
        Date.parse(thread.autoContinueAt) <= nowMs &&
        thread.archivedAt === null,
    );
    yield* Effect.forEach(
      due,
      (thread) =>
        Effect.gen(function* () {
          const autoContinueAt = thread.autoContinueAt;
          if (autoContinueAt == null) return;
          const commandUuid = yield* crypto.randomUUIDv4;
          const messageUuid = yield* crypto.randomUUIDv4;
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* engine.dispatch({
            type: "thread.auto-continue.fire",
            commandId: CommandId.make(`server:auto-continue:${thread.id}:${commandUuid}`),
            threadId: thread.id,
            autoContinueAt,
            messageId: MessageId.make(messageUuid),
            createdAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("auto-continue fire skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });

  const runSweep = sweep().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("auto-continue sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );
  const worker = yield* makeDrainableWorker((_: void) => runSweep);

  const start: AutoContinueReactor["Service"]["start"] = Effect.fn("AutoContinueReactor.start")(
    function* () {
      // The first sweep on start fires continuations whose reset passed while
      // the server was down — exactly what the user asked for by scheduling.
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
    },
  );

  return { start, drain: worker.drain } satisfies AutoContinueReactor["Service"];
});

export const layer = Layer.effect(AutoContinueReactor, make);
