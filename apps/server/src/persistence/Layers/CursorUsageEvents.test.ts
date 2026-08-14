import type { CursorUsageEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CursorUsageEventsRepository } from "../Services/CursorUsageEvents.ts";
import { layer as CursorUsageEventsRepositoryLive } from "./CursorUsageEvents.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

// `it.layer` builds one shared in-memory database for every case below, so
// each test uses its own id namespace and a tight time window rather than
// asserting on global table state.
const layer = it.layer(
  CursorUsageEventsRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

function event(id: string, overrides: Partial<CursorUsageEvent> = {}): CursorUsageEvent {
  return {
    id: id as CursorUsageEvent["id"],
    occurredAt: "2026-08-07T12:00:00.000Z",
    day: "2026-08-07" as CursorUsageEvent["day"],
    model: "cursor-grok-4.5",
    usageType: "included",
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

layer("CursorUsageEventsRepository", (it) => {
  it.effect("deduplicates events with the same id across two upsert calls", () =>
    Effect.gen(function* () {
      const repository = yield* CursorUsageEventsRepository;
      const first = yield* repository.upsertEvents([event("dedup-across-calls")]);
      assert.deepStrictEqual(first, { inserted: 1, deduplicated: 0 });

      const second = yield* repository.upsertEvents([event("dedup-across-calls")]);
      assert.deepStrictEqual(second, { inserted: 0, deduplicated: 1 });

      const all = yield* repository.listEventsInRange({
        sinceMs: 0,
        untilMs: Date.parse("2030-01-01T00:00:00.000Z"),
      });
      assert.strictEqual(all.filter((row) => row.id === "dedup-across-calls").length, 1);
    }),
  );

  it.effect("deduplicates within a single overlapping-window upsert call", () =>
    Effect.gen(function* () {
      const repository = yield* CursorUsageEventsRepository;
      const result = yield* repository.upsertEvents([
        event("dedup-within-batch"),
        event("dedup-within-batch"),
      ]);
      assert.deepStrictEqual(result, { inserted: 1, deduplicated: 1 });
    }),
  );

  it.effect("keeps events with different ids but the same timestamp/model distinct", () =>
    Effect.gen(function* () {
      const repository = yield* CursorUsageEventsRepository;
      yield* repository.upsertEvents([event("distinct-a"), event("distinct-b")]);
      const all = yield* repository.listEventsInRange({
        sinceMs: 0,
        untilMs: Date.parse("2030-01-01T00:00:00.000Z"),
      });
      const ids = new Set(all.map((row) => row.id));
      assert.ok(ids.has("distinct-a" as CursorUsageEvent["id"]));
      assert.ok(ids.has("distinct-b" as CursorUsageEvent["id"]));
    }),
  );

  it.effect("paginates in descending order and terminates with a null cursor", () =>
    Effect.gen(function* () {
      const repository = yield* CursorUsageEventsRepository;
      // A window that only this test's events fall in, so pagination results
      // are not polluted by rows other cases in this file insert.
      const sinceMs = Date.parse("2027-01-01T00:00:00.000Z");
      const untilMs = Date.parse("2027-01-02T00:00:00.000Z");
      yield* repository.upsertEvents([
        event("page-1", { occurredAt: "2027-01-01T12:00:00.000Z" }),
        event("page-2", { occurredAt: "2027-01-01T13:00:00.000Z" }),
        event("page-3", { occurredAt: "2027-01-01T14:00:00.000Z" }),
      ]);

      const firstPage = yield* repository.listEventsPage({
        sinceMs,
        untilMs,
        cursor: Option.none(),
        limit: 2,
      });
      assert.strictEqual(firstPage.events.length, 2);
      assert.strictEqual(firstPage.events[0]?.id, "page-3");
      assert.strictEqual(firstPage.events[1]?.id, "page-2");
      assert.ok(Option.isSome(firstPage.nextCursor));

      const secondPage = yield* repository.listEventsPage({
        sinceMs,
        untilMs,
        cursor: firstPage.nextCursor,
        limit: 2,
      });
      assert.strictEqual(secondPage.events.length, 1);
      assert.strictEqual(secondPage.events[0]?.id, "page-1");
      assert.ok(Option.isNone(secondPage.nextCursor));
    }),
  );

  it.effect("returns an empty page for a range with no events", () =>
    Effect.gen(function* () {
      const repository = yield* CursorUsageEventsRepository;
      const page = yield* repository.listEventsPage({
        sinceMs: Date.parse("1999-01-01T00:00:00.000Z"),
        untilMs: Date.parse("1999-01-02T00:00:00.000Z"),
        cursor: Option.none(),
        limit: 10,
      });
      assert.deepStrictEqual(page, { events: [], nextCursor: Option.none() });
    }),
  );

  it.effect("round-trips sync state", () =>
    Effect.gen(function* () {
      const repository = yield* CursorUsageEventsRepository;

      const before = yield* repository.getSyncState();
      assert.ok(Option.isNone(before));

      yield* repository.setSyncState({
        lastSuccessfulSyncAtMs: 1_700_000_000_000,
        syncVersion: 1,
        backfillCompleted: true,
      });
      const after = yield* repository.getSyncState();
      assert.deepStrictEqual(Option.getOrThrow(after), {
        lastSuccessfulSyncAtMs: 1_700_000_000_000,
        syncVersion: 1,
        backfillCompleted: true,
      });

      yield* repository.setSyncState({
        lastSuccessfulSyncAtMs: 1_800_000_000_000,
        syncVersion: 1,
        backfillCompleted: true,
      });
      const updated = yield* repository.getSyncState();
      assert.strictEqual(Option.getOrThrow(updated).lastSuccessfulSyncAtMs, 1_800_000_000_000);
    }),
  );

  it.effect("prunes only events older than the cutoff", () =>
    Effect.gen(function* () {
      const repository = yield* CursorUsageEventsRepository;
      yield* repository.upsertEvents([
        event("prune-old", { occurredAt: "2015-06-01T00:00:00.000Z" }),
        event("prune-new", { occurredAt: "2027-06-01T00:00:00.000Z" }),
      ]);

      const cutoffMs = Date.parse("2020-01-01T00:00:00.000Z");
      const pruned = yield* repository.pruneOlderThan(cutoffMs);
      assert.ok(pruned >= 1);

      const remaining = yield* repository.listEventsInRange({
        sinceMs: Date.parse("2027-01-01T00:00:00.000Z"),
        untilMs: Date.parse("2028-01-01T00:00:00.000Z"),
      });
      assert.ok(remaining.some((row) => row.id === "prune-new"));

      const stillOld = yield* repository.listEventsInRange({
        sinceMs: Date.parse("2015-01-01T00:00:00.000Z"),
        untilMs: Date.parse("2016-01-01T00:00:00.000Z"),
      });
      assert.ok(!stillOld.some((row) => row.id === "prune-old"));
    }),
  );
});
