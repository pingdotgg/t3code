import { RunId, ThreadId } from "@piku/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { DEFAULT_EFFECT_WORKER_MAX_ATTEMPTS } from "./EffectWorker.ts";
import { ProviderRuntimeRecoveryService } from "./ProviderRuntimeRecoveryService.ts";
import { RunLeaseTimingsRef } from "./RunLeaseService.ts";

/**
 * The continuous companion to the startup/shutdown reconcile: while the
 * server is alive, every non-terminal run must be owned by live work (a
 * valid run lease), covered by a durable outbox effect, or recently active.
 * Anything else is orphaned — a fiber died without finalizing, a cascade was
 * missed, a promotion never happened — and gets terminalized here within a
 * bounded delay instead of spinning in the UI forever.
 *
 * The sweep also settles expired effect-outbox leases first, so a hung effect
 * executor stops wedging its thread's queue and the runs behind it become
 * either runnable again or sweepable.
 */

export class RunJanitorError extends Schema.TaggedErrorClass<RunJanitorError>()("RunJanitorError", {
  operation: Schema.Literals(["settle-effects", "find-orphans", "terminalize"]),
  threadId: Schema.optional(ThreadId),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Orchestration V2 janitor failed during ${this.operation}.`;
  }
}

export interface RunJanitorSweepSummary {
  readonly requeuedEffects: number;
  readonly failedEffects: number;
  readonly terminalizedRuns: number;
  readonly sweptThreads: number;
}

export class RunJanitorV2 extends Context.Service<
  RunJanitorV2,
  {
    readonly sweepOnce: Effect.Effect<RunJanitorSweepSummary, RunJanitorError>;
    readonly daemon: Effect.Effect<never>;
  }
>()("piku/orchestration-v2/RunJanitorService/RunJanitorV2") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const outbox = yield* EffectOutboxV2;
  const recovery = yield* ProviderRuntimeRecoveryService;
  const timings = yield* RunLeaseTimingsRef;

  const sweepOnce = Effect.fn("RunJanitorV2.sweepOnce")(function* () {
    const settled = yield* outbox
      .settleExpiredLeases({ maxAttempts: DEFAULT_EFFECT_WORKER_MAX_ATTEMPTS })
      .pipe(
        Effect.mapError((cause) => new RunJanitorError({ operation: "settle-effects", cause })),
      );

    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const graceCutoff = DateTime.formatIso(
      DateTime.subtract(now, { milliseconds: Math.max(1, timings.graceMs) }),
    );
    // Expired lease rows carry no information (no lease survives its holder)
    // and would otherwise accumulate after crashes; prune as we go.
    yield* sql`
      DELETE FROM orchestration_v2_run_leases
      WHERE expires_at <= ${nowIso}
    `.pipe(Effect.mapError((cause) => new RunJanitorError({ operation: "find-orphans", cause })));
    // A run is orphaned when its whole thread has no live lease, no durable
    // work queued, and no recent event activity. The thread-level scope
    // deliberately spares queued runs sequenced behind a leased sibling and
    // fresh runs whose execution has not acquired its lease yet.
    const orphanRows = yield* sql<{ readonly thread_id: string; readonly run_id: string }>`
      SELECT r.thread_id, r.run_id
      FROM orchestration_v2_projection_runs AS r
      WHERE r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        AND NOT EXISTS (
          SELECT 1
          FROM orchestration_v2_run_leases AS lease
          WHERE lease.thread_id = r.thread_id
            AND lease.expires_at > ${nowIso}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM orchestration_v2_effect_outbox AS effect
          WHERE effect.thread_id = r.thread_id
            AND effect.status IN ('pending', 'running')
        )
        AND COALESCE((
          SELECT event.occurred_at
          FROM orchestration_events AS event
          WHERE event.aggregate_kind = 'thread'
            AND event.stream_id = r.thread_id
            AND event.application_event_version = 2
          ORDER BY event.sequence DESC
          LIMIT 1
        ), '') < ${graceCutoff}
      ORDER BY r.thread_id ASC, r.run_id ASC
    `.pipe(Effect.mapError((cause) => new RunJanitorError({ operation: "find-orphans", cause })));

    const orphansByThread = new Map<ThreadId, Set<RunId>>();
    for (const row of orphanRows) {
      const threadId = ThreadId.make(row.thread_id);
      const runIds = orphansByThread.get(threadId) ?? new Set<RunId>();
      runIds.add(RunId.make(row.run_id));
      orphansByThread.set(threadId, runIds);
    }

    let terminalizedRuns = 0;
    for (const [threadId, runIds] of orphansByThread) {
      const result = yield* recovery
        .janitorThread({ threadId, runIds })
        .pipe(
          Effect.mapError(
            (cause) => new RunJanitorError({ operation: "terminalize", threadId, cause }),
          ),
        );
      terminalizedRuns += result.terminalizedRuns;
    }

    return {
      requeuedEffects: settled.requeued,
      failedEffects: settled.failed,
      terminalizedRuns,
      sweptThreads: orphansByThread.size,
    } satisfies RunJanitorSweepSummary;
  });

  const daemon = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(Math.max(1, timings.janitorIntervalMs)));
      yield* sweepOnce().pipe(
        Effect.tap((summary) =>
          summary.terminalizedRuns > 0 || summary.requeuedEffects > 0 || summary.failedEffects > 0
            ? Effect.logInfo("V2 orchestration janitor reclaimed orphaned work", summary)
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("V2 orchestration janitor sweep failed", { cause }),
        ),
      );
    }
  }) as Effect.Effect<never>;

  return RunJanitorV2.of({ sweepOnce: sweepOnce(), daemon });
});

export const layer: Layer.Layer<
  RunJanitorV2,
  never,
  SqlClient.SqlClient | EffectOutboxV2 | ProviderRuntimeRecoveryService
> = Layer.effect(RunJanitorV2, make);
