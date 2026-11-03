import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("orders external history before live messages and upgrades legacy positions", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("external-history");
    const input = { threadId, runId: null, turnItemId: TurnItemId.make("recent") };
    const legacy = yield* positions.allocate(input);
    assert.equal(legacy, 1);
    const recentAt = DateTime.makeUnsafe("2026-11-02T12:00:00Z");
    const recent = yield* positions.allocate({
      ...input,
      chronological: true,
      sourceTimestamp: recentAt,
    });
    const old = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("history"),
      chronological: true,
      sourceTimestamp: DateTime.makeUnsafe("2026-11-01T12:00:00Z"),
    });
    const simultaneous = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("tool"),
      chronological: true,
      sourceTimestamp: recentAt,
    });
    assert.isBelow(old, recent);
    assert.isAbove(simultaneous, recent);
    const managed = {
      ...input,
      turnItemId: TurnItemId.make("managed"),
      runId: RunId.make("managed-run"),
      runOrdinal: 1,
    };
    const beforeRepair = yield* positions.allocate(managed);
    assert.isBelow(beforeRepair, old);
    const afterRepair = yield* positions.allocate({
      ...managed,
      sourceTimestamp: DateTime.makeUnsafe("2026-11-02T14:00:00Z"),
    });
    assert.isAbove(afterRepair, simultaneous);
    assert.equal(
      yield* positions.allocate({
        ...managed,
        sourceTimestamp: DateTime.makeUnsafe("2026-11-02T15:00:00Z"),
      }),
      afterRepair,
    );
    assert.equal(
      yield* positions.allocate({
        ...input,
        chronological: true,
        sourceTimestamp: DateTime.makeUnsafe("2026-11-02T13:00:00Z"),
      }),
      recent,
    );
  }).pipe(Effect.provide(layerTest)),
);
