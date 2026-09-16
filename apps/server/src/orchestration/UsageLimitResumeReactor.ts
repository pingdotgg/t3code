import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/** Sweep cadence: how often armed threads are checked for resume readiness. */
const USAGE_LIMIT_RESUME_SWEEP_INTERVAL = "1 minute";

/** Prompt used for the automatic resume turn (matches server-update continuation). */
const USAGE_LIMIT_RESUME_PROMPT = "Continue where you left off.";

export class UsageLimitResumeReactor extends Context.Service<
  UsageLimitResumeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/UsageLimitResumeReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const sweep = Effect.fn("UsageLimitResumeReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const dueThreads = snapshot.threads.filter(
      (thread) =>
        thread.usageLimitResumeAt !== null &&
        thread.usageLimitResumeAt !== undefined &&
        thread.session?.status !== "running" &&
        thread.session?.status !== "starting" &&
        DateTime.make(thread.usageLimitResumeAt).pipe(
          Option.match({
            onNone: () => false,
            onSome: (resumeAt) => DateTime.toEpochMillis(resumeAt) <= nowMs,
          }),
        ),
    );

    yield* Effect.forEach(
      dueThreads,
      Effect.fn("UsageLimitResumeReactor.resumeThread")(function* (thread) {
        // Re-read the arm: a cancel (or a user turn, which disarms in the
        // decider) may land between the sweep's snapshot and this dispatch,
        // and an armed-then-cancelled thread must not receive an
        // unsolicited continuation.
        const current = yield* snapshots.getThreadShellById(thread.id);
        if (
          Option.isNone(current) ||
          current.value.usageLimitResumeAt === null ||
          current.value.usageLimitResumeAt === undefined ||
          current.value.usageLimitResumeAt !== thread.usageLimitResumeAt
        ) {
          return;
        }
        // The turn.start itself disarms the resume in the decider; if the
        // provider rejects the turn again the failure re-arms a fresh window.
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(
              `server:usage-limit-resume:${thread.id}:${yield* crypto.randomUUIDv4}`,
            ),
            threadId: ThreadId.make(thread.id),
            message: {
              messageId: MessageId.make(yield* crypto.randomUUIDv4),
              role: "user",
              text: USAGE_LIMIT_RESUME_PROMPT,
              attachments: [],
            },
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("usage-limit resume failed for thread", {
                    threadId: thread.id,
                    cause: Cause.pretty(cause),
                  }),
            ),
          );
      }),
      { concurrency: 1, discard: true },
    );
  });

  const runSweep = sweep().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("usage-limit resume sweep failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );
  const worker = yield* makeDrainableWorker(() => runSweep);

  const start: UsageLimitResumeReactor["Service"]["start"] = Effect.fn(
    "UsageLimitResumeReactor.start",
  )(function* () {
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced(USAGE_LIMIT_RESUME_SWEEP_INTERVAL)), Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies UsageLimitResumeReactor["Service"];
});

export const layer = Layer.effect(UsageLimitResumeReactor, make);
