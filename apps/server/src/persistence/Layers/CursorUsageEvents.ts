import type { CursorUsageEvent, UsageDay } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CursorUsageEventsRepository,
  type CursorUsageEventsPageCursor,
  type CursorUsageEventsRepositoryShape,
  type CursorUsageSyncState,
} from "../Services/CursorUsageEvents.ts";

interface CursorUsageEventRow {
  readonly id: string;
  readonly occurred_at_ms: number;
  readonly day: string;
  readonly model: string;
  readonly usage_type: string;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly total_tokens: number | null;
  readonly raw_cost_cents: number | null;
  readonly charged_cents: number | null;
}

function rowToEvent(row: CursorUsageEventRow): CursorUsageEvent {
  return {
    id: row.id as CursorUsageEvent["id"],
    occurredAt: DateTime.formatIso(DateTime.makeUnsafe(row.occurred_at_ms)),
    day: row.day as UsageDay,
    model: row.model,
    usageType: row.usage_type === "onDemand" ? "onDemand" : "included",
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.cache_write_tokens !== null ? { cacheWriteTokens: row.cache_write_tokens } : {}),
    ...(row.cache_read_tokens !== null ? { cacheReadTokens: row.cache_read_tokens } : {}),
    ...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}),
    ...(row.raw_cost_cents !== null ? { rawCostCents: row.raw_cost_cents } : {}),
    ...(row.charged_cents !== null ? { chargedCents: row.charged_cents } : {}),
  };
}

const dayOf = (occurredAt: string): string => occurredAt.slice(0, 10);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertEvents: CursorUsageEventsRepositoryShape["upsertEvents"] = (events) =>
    Effect.gen(function* () {
      if (events.length === 0) return { inserted: 0, deduplicated: 0 };

      // De-dupe within the batch itself first: overlapping sync windows can
      // hand back the same event twice in one page set, before any of it is
      // in the database yet, so a DB-only existence check would miss it.
      const seenIds = new Set<string>();
      const uniqueEvents: CursorUsageEvent[] = [];
      let duplicatedWithinBatch = 0;
      for (const event of events) {
        if (seenIds.has(event.id)) {
          duplicatedWithinBatch += 1;
          continue;
        }
        seenIds.add(event.id);
        uniqueEvents.push(event);
      }

      const existingRows = yield* sql<{ readonly id: string }>`
        SELECT id FROM cursor_usage_events WHERE ${sql.in("id", [...seenIds])}
      `;
      const existingIds = new Set(existingRows.map((row) => row.id));
      const newEvents = uniqueEvents.filter((event) => !existingIds.has(event.id));

      for (const event of newEvents) {
        yield* sql`
          INSERT INTO cursor_usage_events (
            id, occurred_at_ms, day, model, usage_type,
            input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
            total_tokens, raw_cost_cents, charged_cents
          )
          VALUES (
            ${event.id},
            ${Date.parse(event.occurredAt)},
            ${event.day ?? dayOf(event.occurredAt)},
            ${event.model},
            ${event.usageType},
            ${event.inputTokens ?? null},
            ${event.outputTokens ?? null},
            ${event.cacheWriteTokens ?? null},
            ${event.cacheReadTokens ?? null},
            ${event.totalTokens ?? null},
            ${event.rawCostCents ?? null},
            ${event.chargedCents ?? null}
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }

      return { inserted: newEvents.length, deduplicated: events.length - newEvents.length };
    }).pipe(
      Effect.mapError(toPersistenceSqlError("CursorUsageEventsRepository.upsertEvents")),
      Effect.withSpan("CursorUsageEventsRepository.upsertEvents"),
    );

  const listEventsInRange: CursorUsageEventsRepositoryShape["listEventsInRange"] = ({
    sinceMs,
    untilMs,
  }) =>
    sql<CursorUsageEventRow>`
      SELECT
        id, occurred_at_ms, day, model, usage_type,
        input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
        total_tokens, raw_cost_cents, charged_cents
      FROM cursor_usage_events
      WHERE occurred_at_ms >= ${sinceMs} AND occurred_at_ms < ${untilMs}
      ORDER BY occurred_at_ms ASC, id ASC
    `.pipe(
      Effect.map((rows) => rows.map(rowToEvent)),
      Effect.mapError(toPersistenceSqlError("CursorUsageEventsRepository.listEventsInRange")),
      Effect.withSpan("CursorUsageEventsRepository.listEventsInRange"),
    );

  const listEventsPage: CursorUsageEventsRepositoryShape["listEventsPage"] = ({
    sinceMs,
    untilMs,
    cursor,
    limit,
  }) =>
    Effect.gen(function* () {
      const fetchLimit = limit + 1;
      const rows = Option.isSome(cursor)
        ? yield* sql<CursorUsageEventRow>`
            SELECT
              id, occurred_at_ms, day, model, usage_type,
              input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
              total_tokens, raw_cost_cents, charged_cents
            FROM cursor_usage_events
            WHERE occurred_at_ms >= ${sinceMs} AND occurred_at_ms < ${untilMs}
              AND (
                occurred_at_ms < ${cursor.value.occurredAtMs}
                OR (occurred_at_ms = ${cursor.value.occurredAtMs} AND id < ${cursor.value.id})
              )
            ORDER BY occurred_at_ms DESC, id DESC
            LIMIT ${fetchLimit}
          `
        : yield* sql<CursorUsageEventRow>`
            SELECT
              id, occurred_at_ms, day, model, usage_type,
              input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
              total_tokens, raw_cost_cents, charged_cents
            FROM cursor_usage_events
            WHERE occurred_at_ms >= ${sinceMs} AND occurred_at_ms < ${untilMs}
            ORDER BY occurred_at_ms DESC, id DESC
            LIMIT ${fetchLimit}
          `;

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor: Option.Option<CursorUsageEventsPageCursor> =
        hasMore && last !== undefined
          ? Option.some({ occurredAtMs: last.occurred_at_ms, id: last.id })
          : Option.none();

      return { events: page.map(rowToEvent), nextCursor };
    }).pipe(
      Effect.mapError(toPersistenceSqlError("CursorUsageEventsRepository.listEventsPage")),
      Effect.withSpan("CursorUsageEventsRepository.listEventsPage"),
    );

  const getSyncState: CursorUsageEventsRepositoryShape["getSyncState"] = () =>
    sql<{
      readonly last_successful_sync_at_ms: number | null;
      readonly sync_version: number;
      readonly backfill_completed: number;
    }>`
      SELECT last_successful_sync_at_ms, sync_version, backfill_completed
      FROM cursor_usage_sync_state
      WHERE provider = 'cursor'
    `.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (row === undefined) return Option.none<CursorUsageSyncState>();
        return Option.some<CursorUsageSyncState>({
          lastSuccessfulSyncAtMs: row.last_successful_sync_at_ms,
          syncVersion: row.sync_version,
          backfillCompleted: row.backfill_completed !== 0,
        });
      }),
      Effect.mapError(toPersistenceSqlError("CursorUsageEventsRepository.getSyncState")),
      Effect.withSpan("CursorUsageEventsRepository.getSyncState"),
    );

  const setSyncState: CursorUsageEventsRepositoryShape["setSyncState"] = (state) =>
    sql`
      INSERT INTO cursor_usage_sync_state (
        provider, last_successful_sync_at_ms, sync_version, backfill_completed
      )
      VALUES ('cursor', ${state.lastSuccessfulSyncAtMs}, ${state.syncVersion}, ${state.backfillCompleted ? 1 : 0})
      ON CONFLICT (provider) DO UPDATE SET
        last_successful_sync_at_ms = excluded.last_successful_sync_at_ms,
        sync_version = excluded.sync_version,
        backfill_completed = excluded.backfill_completed
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("CursorUsageEventsRepository.setSyncState")),
      Effect.withSpan("CursorUsageEventsRepository.setSyncState"),
    );

  const pruneOlderThan: CursorUsageEventsRepositoryShape["pruneOlderThan"] = (cutoffMs) =>
    Effect.gen(function* () {
      const counted = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM cursor_usage_events WHERE occurred_at_ms < ${cutoffMs}
      `;
      const count = counted[0]?.count ?? 0;
      if (count === 0) return 0;
      yield* sql`DELETE FROM cursor_usage_events WHERE occurred_at_ms < ${cutoffMs}`;
      return count;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("CursorUsageEventsRepository.pruneOlderThan")),
      Effect.withSpan("CursorUsageEventsRepository.pruneOlderThan"),
    );

  return {
    upsertEvents,
    listEventsInRange,
    listEventsPage,
    getSyncState,
    setSyncState,
    pruneOlderThan,
  } satisfies CursorUsageEventsRepositoryShape;
});

export const layer = Layer.effect(CursorUsageEventsRepository, make);
