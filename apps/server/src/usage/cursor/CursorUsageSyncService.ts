/**
 * CursorUsageSyncService - backfills and incrementally syncs Cursor usage
 * events from `CursorUsageClient` into `CursorUsageEventsRepository`.
 *
 * On first run (no persisted sync state) this fetches the last 90 days in
 * one backfill; afterwards it re-fetches from a little before the last
 * successful sync (an overlap window, since events can settle after being
 * first reported) and relies on `upsertEvents`'s id-based de-duplication to
 * make repeated syncs idempotent. A sync failure never throws out of
 * `syncOnce` - errors are caught, logged, and reported in the result so a
 * flaky Cursor API cannot take down the server or the RPC that triggers a
 * manual refresh.
 *
 * @module CursorUsageSyncService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { forkParked } from "../../serverActivation.ts";
import { CursorUsageEventsRepository } from "../../persistence/Services/CursorUsageEvents.ts";
import { CursorUsageClient } from "./CursorUsageClient.ts";

const BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Re-fetches a little before the last sync, since Cursor can settle an
 * event's final cost slightly after first reporting it. */
const INCREMENTAL_OVERLAP_MS = 60 * 60 * 1000;
const DEFAULT_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const SYNC_VERSION = 1;

export type CursorUsageSyncStatus = "ok" | "partial" | "notConfigured";

export interface CursorUsageSyncResult {
  readonly status: CursorUsageSyncStatus;
  readonly eventsFetched: number;
  readonly eventsInserted: number;
  readonly eventsDeduplicated: number;
  readonly lastSuccessfulSyncAtMs: number | null;
  readonly message: string | null;
}

export interface CursorUsageStatus {
  readonly configured: boolean;
  readonly connectionMode: "adminApi" | "session" | "none";
  readonly lastSuccessfulSyncAtMs: number | null;
  readonly backfillCompleted: boolean;
}

export interface CursorUsageSyncServiceShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly syncNow: () => Effect.Effect<CursorUsageSyncResult>;
  readonly getStatus: () => Effect.Effect<CursorUsageStatus>;
}

export class CursorUsageSyncService extends Context.Service<
  CursorUsageSyncService,
  CursorUsageSyncServiceShape
>()("t3/usage/cursor/CursorUsageSyncService") {}

/** No-op stub, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  CursorUsageSyncService,
  CursorUsageSyncService.of({
    start: () => Effect.void,
    syncNow: () =>
      Effect.succeed({
        status: "notConfigured",
        eventsFetched: 0,
        eventsInserted: 0,
        eventsDeduplicated: 0,
        lastSuccessfulSyncAtMs: null,
        message: null,
      }),
    getStatus: () =>
      Effect.succeed({
        configured: false,
        connectionMode: "none" as const,
        lastSuccessfulSyncAtMs: null,
        backfillCompleted: false,
      }),
  }),
);

export interface CursorUsageSyncServiceLiveOptions {
  readonly syncIntervalMs?: number;
}

const makeCursorUsageSyncService = (options?: CursorUsageSyncServiceLiveOptions) =>
  Effect.gen(function* () {
    const client = yield* CursorUsageClient;
    const repository = yield* CursorUsageEventsRepository;
    const semaphore = yield* Semaphore.make(1);
    const syncIntervalMs = Math.max(1, options?.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS);

    const runSync = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const syncState = yield* repository
        .getSyncState()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("cursor_usage_sync_state_read_failed", { cause }).pipe(
              Effect.as(Option.none()),
            ),
          ),
        );

      const startMs = Option.match(syncState, {
        onNone: () => nowMs - BACKFILL_WINDOW_MS,
        onSome: (state) =>
          state.lastSuccessfulSyncAtMs === null
            ? nowMs - BACKFILL_WINDOW_MS
            : Math.max(
                nowMs - BACKFILL_WINDOW_MS,
                state.lastSuccessfulSyncAtMs - INCREMENTAL_OVERLAP_MS,
              ),
      });

      yield* Effect.logInfo("cursor_usage_sync_started", {
        provider: "cursor",
        sinceMs: startMs,
        untilMs: nowMs,
      });

      const page = yield* client
        .getUsageEvents({ startDateMs: startMs, endDateMs: nowMs })
        .pipe(Effect.result);

      if (page._tag === "Failure") {
        const error = page.failure;
        if (error._tag === "CursorUsageClientNotConfiguredError") {
          return {
            status: "notConfigured",
            eventsFetched: 0,
            eventsInserted: 0,
            eventsDeduplicated: 0,
            lastSuccessfulSyncAtMs: Option.match(syncState, {
              onNone: () => null,
              onSome: (state) => state.lastSuccessfulSyncAtMs,
            }),
            message: null,
          } satisfies CursorUsageSyncResult;
        }

        yield* Effect.logWarning("cursor_usage_sync_failed", {
          provider: "cursor",
          reason: error._tag,
          detail: "detail" in error ? error.detail : undefined,
        });
        return {
          status: "partial",
          eventsFetched: 0,
          eventsInserted: 0,
          eventsDeduplicated: 0,
          lastSuccessfulSyncAtMs: Option.match(syncState, {
            onNone: () => null,
            onSome: (state) => state.lastSuccessfulSyncAtMs,
          }),
          message: error.message,
        } satisfies CursorUsageSyncResult;
      }

      const { events } = page.success;
      yield* Effect.logInfo("cursor_usage_events_fetched", {
        provider: "cursor",
        count: events.length,
        sinceMs: startMs,
        untilMs: nowMs,
      });

      const persistenceResult = yield* repository.upsertEvents(events).pipe(Effect.result);
      if (persistenceResult._tag === "Failure") {
        yield* Effect.logWarning("cursor_usage_events_insert_failed", {
          cause: persistenceResult.failure,
        });
        return {
          status: "partial",
          eventsFetched: events.length,
          eventsInserted: 0,
          eventsDeduplicated: 0,
          lastSuccessfulSyncAtMs: Option.match(syncState, {
            onNone: () => null,
            onSome: (state) => state.lastSuccessfulSyncAtMs,
          }),
          message: "Cursor usage events could not be persisted.",
        } satisfies CursorUsageSyncResult;
      }
      const { inserted, deduplicated } = persistenceResult.success;
      yield* Effect.logInfo("cursor_usage_events_inserted", {
        provider: "cursor",
        count: inserted,
      });
      yield* Effect.logInfo("cursor_usage_events_deduplicated", {
        provider: "cursor",
        count: deduplicated,
      });

      yield* repository
        .pruneOlderThan(nowMs - RETENTION_MS)
        .pipe(Effect.catchCause(() => Effect.void));

      yield* repository
        .setSyncState({
          lastSuccessfulSyncAtMs: nowMs,
          syncVersion: SYNC_VERSION,
          backfillCompleted: true,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("cursor_usage_sync_state_write_failed", { cause }),
          ),
        );

      yield* Effect.logInfo("cursor_usage_sync_completed", {
        provider: "cursor",
        status: "ok",
        eventsFetched: events.length,
        eventsInserted: inserted,
        eventsDeduplicated: deduplicated,
      });

      return {
        status: "ok",
        eventsFetched: events.length,
        eventsInserted: inserted,
        eventsDeduplicated: deduplicated,
        lastSuccessfulSyncAtMs: nowMs,
        message: null,
      } satisfies CursorUsageSyncResult;
    });

    const syncNow: CursorUsageSyncServiceShape["syncNow"] = () =>
      semaphore
        .withPermits(1)(runSync)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("cursor_usage_sync_defect", { cause }).pipe(
              Effect.as({
                status: "partial" as const,
                eventsFetched: 0,
                eventsInserted: 0,
                eventsDeduplicated: 0,
                lastSuccessfulSyncAtMs: null,
                message: "Cursor usage sync failed unexpectedly.",
              }),
            ),
          ),
        );

    const getStatus: CursorUsageSyncServiceShape["getStatus"] = () =>
      Effect.gen(function* () {
        const configured = yield* client.isConfigured;
        const connectionMode = yield* client.getConnectionMode;
        const syncState = yield* repository
          .getSyncState()
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
        return {
          configured,
          connectionMode,
          lastSuccessfulSyncAtMs: Option.match(syncState, {
            onNone: () => null,
            onSome: (state) => state.lastSuccessfulSyncAtMs,
          }),
          backfillCompleted: Option.match(syncState, {
            onNone: () => false,
            onSome: (state) => state.backfillCompleted,
          }),
        } satisfies CursorUsageStatus;
      });

    const start: CursorUsageSyncServiceShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          syncNow().pipe(Effect.repeat(Schedule.spaced(Duration.millis(syncIntervalMs)))),
        );
        yield* Effect.logInfo("cursor_usage_sync.started", { syncIntervalMs });
      });

    return { start, syncNow, getStatus } satisfies CursorUsageSyncServiceShape;
  });

export const makeCursorUsageSyncServiceLive = (options?: CursorUsageSyncServiceLiveOptions) =>
  Layer.effect(CursorUsageSyncService, makeCursorUsageSyncService(options));

export const CursorUsageSyncServiceLive = makeCursorUsageSyncServiceLive();
