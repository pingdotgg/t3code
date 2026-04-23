/**
 * CostTrackerService - USD + token ledger for every Claude/Codex turn.
 *
 * Backed by plain JSON under `<T3CODE_HOME>/<state>/usage/`:
 *   - `session_<threadId>.json` — per-thread cumulative.
 *   - `YYYY-MM.json` — month bucket (local tz).
 *   - `alltime.json` — running total since install.
 *
 * Works in dev, installed-app, and standalone binaries because persistence
 * lives next to the server's SQLite state. Client reads via a snapshot
 * endpoint; the tracker also exposes a Stream of post-write summaries so
 * the web UI can subscribe to live updates.
 *
 * @module CostTrackerService
 */
import { Context } from "effect";
import type { Effect, Stream } from "effect";

import type { CostSummary, RecordUsageInput } from "../types.ts";

export interface CostTrackerShape {
  /**
   * Record a single turn's usage. Idempotent when deltas sum to zero (e.g.
   * a redelivered no-op snapshot). Returns the summary after the write so
   * the caller can broadcast without a second read.
   */
  readonly recordUsage: (input: RecordUsageInput) => Effect.Effect<CostSummary>;

  /**
   * Read the current summary for a given thread. `threadId` may be omitted
   * to get just month + all-time totals (e.g. the user is between threads).
   */
  readonly getSummary: (input: {
    readonly threadId?: string | undefined;
    readonly at?: Date | undefined;
  }) => Effect.Effect<CostSummary>;

  /**
   * Live stream of summaries emitted after each `recordUsage` write.
   * Consumers pair it with `getSummary` for the initial value, then follow
   * the stream.
   */
  readonly updates: Stream.Stream<CostSummary>;
}

export class CostTrackerService extends Context.Service<
  CostTrackerService,
  CostTrackerShape
>()("t3/cost/Services/CostTracker/CostTrackerService") {}
