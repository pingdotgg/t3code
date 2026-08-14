/**
 * CursorUsageEventsRepository - persistence for synced Cursor usage events.
 *
 * Cursor usage events are fetched from the Cursor API (see
 * `apps/server/src/usage/cursor/`) and persisted here so the usage summary
 * pipeline does not need to re-fetch on every read, and so history survives
 * server restarts. Day-bucketed aggregation is done in application code
 * (`usage/cursor/CursorUsageAggregation.ts`) rather than in SQL, so that
 * bucketing honors the caller's requested time zone the same way the
 * Claude/Codex file-scan path does.
 *
 * @module CursorUsageEventsRepository
 */
import { type CursorUsageEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type CursorUsageEventsRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface CursorUsageEventsPageCursor {
  readonly occurredAtMs: number;
  readonly id: string;
}

export interface CursorUsageSyncState {
  readonly lastSuccessfulSyncAtMs: number | null;
  readonly syncVersion: number;
  readonly backfillCompleted: boolean;
}

export interface CursorUsageEventsRepositoryShape {
  /** Upserts by event id. Returns how many rows were new vs. already present. */
  readonly upsertEvents: (
    events: readonly CursorUsageEvent[],
  ) => Effect.Effect<
    { readonly inserted: number; readonly deduplicated: number },
    CursorUsageEventsRepositoryError
  >;

  /** All events in `[sinceMs, untilMs)`, for aggregation and CSV export. */
  readonly listEventsInRange: (input: {
    readonly sinceMs: number;
    readonly untilMs: number;
  }) => Effect.Effect<readonly CursorUsageEvent[], CursorUsageEventsRepositoryError>;

  /** Keyset-paginated events in `[sinceMs, untilMs)`, newest first. */
  readonly listEventsPage: (input: {
    readonly sinceMs: number;
    readonly untilMs: number;
    readonly cursor: Option.Option<CursorUsageEventsPageCursor>;
    readonly limit: number;
  }) => Effect.Effect<
    {
      readonly events: readonly CursorUsageEvent[];
      readonly nextCursor: Option.Option<CursorUsageEventsPageCursor>;
    },
    CursorUsageEventsRepositoryError
  >;

  readonly getSyncState: () => Effect.Effect<
    Option.Option<CursorUsageSyncState>,
    CursorUsageEventsRepositoryError
  >;

  readonly setSyncState: (
    state: CursorUsageSyncState,
  ) => Effect.Effect<void, CursorUsageEventsRepositoryError>;

  /** Deletes events strictly older than `cutoffMs`. Returns rows removed. */
  readonly pruneOlderThan: (
    cutoffMs: number,
  ) => Effect.Effect<number, CursorUsageEventsRepositoryError>;
}

export class CursorUsageEventsRepository extends Context.Service<
  CursorUsageEventsRepository,
  CursorUsageEventsRepositoryShape
>()("t3/persistence/Services/CursorUsageEvents/CursorUsageEventsRepository") {}

/** Empty in-memory stub, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  CursorUsageEventsRepository,
  CursorUsageEventsRepository.of({
    upsertEvents: () => Effect.succeed({ inserted: 0, deduplicated: 0 }),
    listEventsInRange: () => Effect.succeed([]),
    listEventsPage: () => Effect.succeed({ events: [], nextCursor: Option.none() }),
    getSyncState: () => Effect.succeed(Option.none()),
    setSyncState: () => Effect.void,
    pruneOlderThan: () => Effect.succeed(0),
  }),
);
