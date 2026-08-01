import { RunId, ThreadId } from "@piku/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Liveness leases for non-terminal runs.
 *
 * A persisted "running" status is a claim that some fiber in some process is
 * driving the run. The lease is what makes that claim falsifiable: the fiber
 * that owns the run holds a row in orchestration_v2_run_leases and renews it
 * while it is alive; the renewal fiber dies with its owner, so once
 * expires_at passes, the run is provably orphaned and the janitor may
 * terminalize it. Every non-terminal run is therefore either owned by live
 * work, covered by a durable outbox effect, or on a bounded clock toward
 * cleanup — "stuck at working forever" stops being a representable state.
 */

export interface RunLeaseTimings {
  /** How long a lease stays valid without renewal. */
  readonly ttlMs: number;
  /** How often a live holder renews. Must be well under ttlMs. */
  readonly renewIntervalMs: number;
  /** How often the janitor sweeps. */
  readonly janitorIntervalMs: number;
  /**
   * How long a run may exist without lease, effect, or thread activity before
   * the janitor terminalizes it. Covers the handoff gaps between a run's
   * creation, its outbox effect, and its execution fiber acquiring the lease.
   */
  readonly graceMs: number;
}

const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export class RunLeaseTimingsRef extends Context.Reference<RunLeaseTimings>(
  "piku/orchestration-v2/RunLeaseService/RunLeaseTimings",
  {
    defaultValue: () => ({
      ttlMs: envMs("PIKU_ORCH_RUN_LEASE_TTL_MS", 30_000),
      renewIntervalMs: envMs("PIKU_ORCH_RUN_LEASE_RENEW_MS", 10_000),
      janitorIntervalMs: envMs("PIKU_ORCH_RUN_JANITOR_INTERVAL_MS", 15_000),
      graceMs: envMs("PIKU_ORCH_RUN_JANITOR_GRACE_MS", 90_000),
    }),
  },
) {}

export interface RunLeaseServiceV2Shape {
  /**
   * Hold a lease on the run for the lifetime of the wrapped effect. Acquire,
   * renewal, and release never fail the wrapped work: the lease is advisory
   * infrastructure, and a run that loses it is cleaned up by the janitor
   * rather than crashed here.
   */
  readonly withRunLease: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class RunLeaseServiceV2 extends Context.Service<RunLeaseServiceV2, RunLeaseServiceV2Shape>()(
  "piku/orchestration-v2/RunLeaseService/RunLeaseServiceV2",
) {}

export const layer: Layer.Layer<RunLeaseServiceV2, never, SqlClient.SqlClient> = Layer.effect(
  RunLeaseServiceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const timings = yield* RunLeaseTimingsRef;
    const owner = `orchestration-v2:${process.pid}`;

    const logged =
      (operation: string, runId: RunId) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
        effect.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning(`run lease ${operation} failed`, { runId, cause }),
          ),
        );

    const acquire = (input: { readonly threadId: ThreadId; readonly runId: RunId }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const expiresAt = DateTime.formatIso(
          DateTime.add(now, { milliseconds: Math.max(1, timings.ttlMs) }),
        );
        yield* sql`
          INSERT INTO orchestration_v2_run_leases (
            run_id,
            thread_id,
            owner,
            expires_at,
            created_at,
            updated_at
          )
          VALUES (${input.runId}, ${input.threadId}, ${owner}, ${expiresAt}, ${nowIso}, ${nowIso})
          ON CONFLICT(run_id) DO UPDATE SET
            owner = excluded.owner,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `;
      });

    const renew = (input: { readonly runId: RunId }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const expiresAt = DateTime.formatIso(
          DateTime.add(now, { milliseconds: Math.max(1, timings.ttlMs) }),
        );
        yield* sql`
          UPDATE orchestration_v2_run_leases
          SET expires_at = ${expiresAt}, updated_at = ${nowIso}
          WHERE run_id = ${input.runId} AND owner = ${owner}
        `;
      });

    const release = (input: { readonly runId: RunId }) =>
      sql`
        DELETE FROM orchestration_v2_run_leases
        WHERE run_id = ${input.runId} AND owner = ${owner}
      `;

    const withRunLease: RunLeaseServiceV2Shape["withRunLease"] =
      (input) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(logged("acquire", input.runId)(acquire(input)), () =>
              logged("release", input.runId)(release(input)),
            );
            yield* Effect.forkScoped(
              logged(
                "renew",
                input.runId,
              )(renew(input)).pipe(
                Effect.delay(Duration.millis(Math.max(1, timings.renewIntervalMs))),
                Effect.forever,
              ),
            );
            return yield* effect;
          }),
        );

    return RunLeaseServiceV2.of({ withRunLease });
  }),
);
