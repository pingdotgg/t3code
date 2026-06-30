import type { BoardId, LaneKey, WorkflowSourceConfig } from "@t3tools/contracts";
import { effectiveAutoPullRule } from "@t3tools/contracts/workSource";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { PredicateEvaluator } from "../Services/PredicateEvaluator.ts";
import {
  WorkSourceProviderRegistry,
  WorkSourceRateLimitError,
  type WorkSourceProvider,
  type WorkSourceProviderError,
} from "../Services/WorkSourceProvider.ts";
import {
  scanSource,
  chunkArray,
  describeWorkSourceProviderError,
  MAX_DELTAS_PER_RECONCILE_CHUNK,
} from "../scanSource.ts";
// Re-export for existing importers (e.g. WorkflowSourceSyncer.test.ts).
export { MAX_DELTAS_PER_RECONCILE_CHUNK } from "../scanSource.ts";
import { WorkflowSourceCommitter, type SourceDelta } from "../Services/WorkflowSourceCommitter.ts";
import {
  WorkflowSourceSyncer,
  type WorkflowSourceSyncerShape,
} from "../Services/WorkflowSourceSyncer.ts";
import { classifyDeltas, type MappingRow } from "../sourceReconcileDiff.ts";
import { gateNewDeltas } from "../sourceAutoPull.ts";

// ---------------------------------------------------------------------------
// Locked tuning constants (do not change without the plan owner's sign-off).
// ---------------------------------------------------------------------------

// Fallback sweep cadence when a source omits syncIntervalSec.
export const DEFAULT_SYNC_INTERVAL_SEC = 120;

// Exponential backoff base + cap for non-rate-limited provider failures.
const BACKOFF_BASE_MS = 30_000; // 30s
const BACKOFF_CAP_MS = 3_600_000; // 1h

// Schema-aware runtime guard for the rate-limit variant (the codebase forbids
// `instanceof` on Schema TaggedError classes — use Schema.is).
const isRateLimitError = Schema.is(WorkSourceRateLimitError);

// ---------------------------------------------------------------------------
// SQL row shapes
// ---------------------------------------------------------------------------

interface SourceStateRow {
  readonly backoffUntil: string | null;
  readonly consecutiveFailures: number;
  readonly lastFullRunAt: string | null;
}

interface MappingSelectRow {
  readonly externalId: string;
  readonly ticketId: string;
  readonly contentHash: string;
  readonly providerVersion: string | null;
  readonly lifecycle: string;
  readonly syncStatus: string;
  readonly sourceMetadataJson: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* WorkSourceProviderRegistry;
  const committer = yield* WorkflowSourceCommitter;
  const engine = yield* WorkflowEngine;
  const boards = yield* BoardRegistry;
  const predicates = yield* PredicateEvaluator;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // Read (board, source) state, treating an absent row as fresh (no backoff,
  // zero failures). The state row is upserted lazily on the first sweep that
  // touches the source.
  const readState = (boardId: BoardId, sourceId: string) =>
    sql<SourceStateRow>`
      SELECT backoff_until AS "backoffUntil",
             consecutive_failures AS "consecutiveFailures",
             last_full_run_at AS "lastFullRunAt"
      FROM work_source_state
      WHERE board_id = ${String(boardId)} AND source_id = ${sourceId}
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  // Idempotent upsert of the state row keyed by (board_id, source_id).
  const ensureStateRow = (boardId: BoardId, sourceId: string) =>
    sql`
      INSERT INTO work_source_state (board_id, source_id, consecutive_failures)
      VALUES (${String(boardId)}, ${sourceId}, 0)
      ON CONFLICT (board_id, source_id) DO NOTHING
    `;

  const readMappings = (boardId: BoardId, sourceId: string) =>
    sql<MappingSelectRow>`
      SELECT external_id AS "externalId",
             ticket_id AS "ticketId",
             content_hash AS "contentHash",
             provider_version AS "providerVersion",
             lifecycle AS "lifecycle",
             sync_status AS "syncStatus",
             source_metadata_json AS "sourceMetadataJson"
      FROM work_source_mapping
      WHERE board_id = ${String(boardId)} AND source_id = ${sourceId}
    `.pipe(
      Effect.map((rows) =>
        rows.map(
          (row): MappingRow => ({
            externalId: row.externalId,
            ticketId: row.ticketId,
            contentHash: row.contentHash,
            providerVersion: row.providerVersion,
            lifecycle: row.lifecycle,
            syncStatus: row.syncStatus,
            sourceMetadataJson: row.sourceMetadataJson,
          }),
        ),
      ),
    );

  // For each `missing` delta, ask the provider whether the item still exists.
  // Result handling (CRITICAL — only a confirmed null deletes):
  //   - getItem succeeds with null  → confirmedDeleted=true (404/gone), the
  //     committer may terminal-route the ticket.
  //   - getItem succeeds with item  → the item still exists (merely fell out of
  //     the FILTERED scan, e.g. label removed) → confirmedDeleted=false, the
  //     ticket stays orphaned (NOT terminal).
  //   - getItem FAILS (auth/rate-limit/transient) → we CANNOT confirm deletion.
  //     The failure propagates to the source-pass failure channel → recorded as
  //     a backoff by recordFailure; the missing delta is NEVER marked
  //     confirmedDeleted on the strength of an error. (The whole pass is
  //     reprocessed next sweep, so no delta is silently dropped as deleted.)
  // This getItem call is network and runs OUTSIDE any transaction.
  const resolveMissing = (
    provider: WorkSourceProvider,
    source: WorkflowSourceConfig,
    deltas: ReadonlyArray<SourceDelta>,
  ): Effect.Effect<ReadonlyArray<SourceDelta>, WorkSourceProviderError> =>
    Effect.forEach(deltas, (delta) => {
      if (delta._tag !== "missing") {
        return Effect.succeed(delta);
      }
      return provider
        .getItem({
          connectionRef: source.connectionRef,
          selector: source.selector,
          externalId: delta.item.externalId,
        })
        .pipe(
          Effect.map(
            (item): SourceDelta => ({
              ...delta,
              confirmedDeleted: item === null,
            }),
          ),
        );
    });

  // On a successful source pass: reset failure tracking and advance the
  // cadence anchor (last_full_run_at).
  //
  // `last_full_run_at` is the cadence-throttle anchor read by the per-source
  // interval gate in `processSource` (its ONLY consumer — it is NOT a
  // completeness proof; missing-detection is gated independently by the
  // per-tick `scanCompleted` flag passed to classifyDeltas). It is therefore
  // advanced on EVERY successful pass, partial or complete. A source larger
  // than MAX_ITEMS_PER_SOURCE_TICK only ever produces partial scans; if the
  // anchor were frozen on partials it would stay NULL forever and the gate
  // would never engage, re-running a full multi-page scan on every tick
  // regardless of the configured syncIntervalSec (the M19 hammering bug).
  // Advancing it on partials still does NOT enable missing/orphan detection —
  // that remains suppressed until a tick actually completes the scan.
  const recordSuccess = (boardId: BoardId, sourceId: string) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* sql`
        UPDATE work_source_state
        SET consecutive_failures = 0,
            backoff_until = NULL,
            last_error = NULL,
            last_full_run_at = ${now}
        WHERE board_id = ${String(boardId)} AND source_id = ${sourceId}
      `;
    });

  // On a provider error: increment the failure counter and schedule a backoff.
  // A rate-limit error uses the server-provided retryAfterMs verbatim; any
  // other failure uses exponential backoff min(cap, base * 2^failures).
  const recordFailure = (
    boardId: BoardId,
    sourceId: string,
    priorFailures: number,
    error: WorkSourceProviderError,
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const isRateLimit = isRateLimitError(error);
      const delayMs = isRateLimit
        ? error.retryAfterMs
        : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** priorFailures);
      const backoffUntil = DateTime.formatIso(DateTime.addDuration(now, Duration.millis(delayMs)));
      const message = isRateLimit
        ? `rate-limited (retryAfterMs=${error.retryAfterMs})`
        : describeWorkSourceProviderError(error);
      yield* sql`
        UPDATE work_source_state
        SET consecutive_failures = consecutive_failures + 1,
            backoff_until = ${backoffUntil},
            last_error = ${message}
        WHERE board_id = ${String(boardId)} AND source_id = ${sourceId}
      `;
    });

  // Process ONE source end-to-end. The whole body is wrapped by the caller in
  // Effect.result so a provider/SQL failure here is isolated — it can never
  // abort the board's other sources or the sweep. A provider error is caught
  // HERE and converted into a recorded backoff (also a non-failing result).
  const processSource = (boardId: BoardId, source: WorkflowSourceConfig) =>
    Effect.gen(function* () {
      yield* ensureStateRow(boardId, source.id);
      const state = yield* readState(boardId, source.id);

      // Backoff gate: skip this source this tick if its backoff has not passed.
      if (state?.backoffUntil != null) {
        const until = DateTime.makeUnsafe(state.backoffUntil);
        if (DateTime.isFutureUnsafe(until)) {
          return;
        }
      }

      // Per-source interval gate: the global sweep runs every
      // DEFAULT_SYNC_INTERVAL_SEC, but a source may request a LONGER cadence via
      // syncIntervalSec. Skip this source this tick if its last successful scan
      // pass (last_full_run_at, the cadence anchor — advanced on partial scans
      // too; see recordSuccess) was more recent than its effective interval. A
      // source that has never had a successful pass (no last_full_run_at) always
      // runs.
      if (state?.lastFullRunAt != null) {
        const effectiveIntervalSec = source.syncIntervalSec ?? DEFAULT_SYNC_INTERVAL_SEC;
        const dueAt = DateTime.addDuration(
          DateTime.makeUnsafe(state.lastFullRunAt),
          Duration.seconds(effectiveIntervalSec),
        );
        if (DateTime.isFutureUnsafe(dueAt)) {
          return;
        }
      }

      const provider = registry.get(source.provider);
      const priorFailures = state?.consecutiveFailures ?? 0;

      // Mapping read is plain SQL (not network). Keep it OUT of the
      // provider-error capture below so the captured failure channel is purely
      // WorkSourceProviderError — a backoff-able failure. (A SQL failure here
      // is handled by the per-source isolation catch in the sweep.)
      const mappings = yield* readMappings(boardId, source.id);

      // Scan gate: if the source has no auto-pull rule (manual-only) AND has no
      // existing mappings, there is nothing to track and nothing to auto-create —
      // skip the network scan entirely for this tick.
      if (effectiveAutoPullRule(source) === null && mappings.length === 0) {
        yield* recordSuccess(boardId, source.id); // advance cadence anchor
        return;
      }

      // The network phase (listPage pagination + getItem confirmations) is the
      // ONLY part that can raise a provider error; capture it so a rate-limit /
      // auth / transient failure becomes a recorded backoff (not an exception).
      const outcome = yield* scanSource(provider, source, undefined).pipe(
        Effect.flatMap((scanned) =>
          Effect.gen(function* () {
            const deltas = classifyDeltas({
              sourceId: source.id,
              provider: source.provider,
              items: scanned.items,
              mappings,
              scanCompleted: scanned.scanCompleted,
            });
            // Gate `new` deltas by the auto-pull rule (never gates non-new).
            const gated = yield* gateNewDeltas(deltas, effectiveAutoPullRule(source), predicates);
            // getItem confirmation for missing deltas — OUTSIDE any tx.
            const resolved = yield* resolveMissing(provider, source, gated);
            return { resolved, scanCompleted: scanned.scanCompleted };
          }),
        ),
        Effect.result,
      );

      if (outcome._tag === "Failure") {
        yield* recordFailure(boardId, source.id, priorFailures, outcome.failure);
        return;
      }

      const { resolved } = outcome.success;
      // Drive the committer per chunk; each chunk takes/releases its own locks.
      for (const chunk of chunkArray(resolved, MAX_DELTAS_PER_RECONCILE_CHUNK)) {
        yield* committer.reconcileChunk(
          boardId,
          {
            destinationLane: source.destinationLane as LaneKey,
            closedLane: source.closedLane as LaneKey,
          },
          chunk,
        );
      }
      yield* recordSuccess(boardId, source.id);
    });

  const sweep: WorkflowSourceSyncerShape["sweep"] = Effect.gen(function* () {
    const definitions = yield* boards
      .listDefinitions()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workflow.source-syncer.list-boards-failed", { cause }).pipe(
            Effect.as([] as ReadonlyArray<{ readonly boardId: BoardId }>),
          ),
        ),
      );

    for (const { boardId, definition } of definitions as ReadonlyArray<{
      readonly boardId: BoardId;
      readonly definition: { readonly sources?: ReadonlyArray<WorkflowSourceConfig> };
    }>) {
      const sources = definition.sources ?? [];
      for (const source of sources) {
        // Per-source isolation: any failure (provider error escaping the inner
        // capture, SQL error, defect) is logged and swallowed so it never
        // aborts the sweep or other sources/boards.
        yield* processSource(boardId, source).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workflow.source-syncer.source-failed", {
              boardId,
              sourceId: source.id,
              cause,
            }),
          ),
        );
      }

      // FINDING #5: recover the board's WIP once per board per sweep,
      // REGARDLESS of delta count. A prior cycle could have admitted a ticket
      // whose committer post-tx recoverBoardWip failed; a later no-change cycle
      // produces zero deltas, so without this unconditional call the
      // admitted-but-unstarted pipeline is stranded forever. Defensively
      // wrapped (catch + log) — a recovery failure must not abort the sweep.
      yield* engine
        .recoverBoardWip(boardId)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workflow.source-syncer.recover-wip-failed", { boardId, cause }),
          ),
        );
    }
  });

  const start: WorkflowSourceSyncerShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        sweep.pipe(
          Effect.catchDefect((defect: unknown) =>
            Effect.logWarning("workflow.source-syncer.sweep-defect", { defect }),
          ),
          Effect.repeat(Schedule.spaced(Duration.seconds(DEFAULT_SYNC_INTERVAL_SEC))),
        ),
      );
      yield* Effect.logInfo("workflow.source-syncer.started", {
        intervalSec: DEFAULT_SYNC_INTERVAL_SEC,
      });
    });

  return { sweep, start } satisfies WorkflowSourceSyncerShape;
});

export const WorkflowSourceSyncerLive = Layer.effect(WorkflowSourceSyncer, make);
