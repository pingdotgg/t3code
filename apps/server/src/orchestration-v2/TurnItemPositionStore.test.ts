import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
      2_000_001,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("appends live voice after existing coding items instead of the runless bucket", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:voice-order");
    const coding = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("coding"),
      runId: RunId.make("run:voice-order"),
      runOrdinal: 2,
    });
    const voice = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("voice"),
      runId: null,
      appendAfterLatest: true,
    });
    assert.equal(voice, coding + 1);
    assert.equal(
      yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("voice"),
        runId: null,
        appendAfterLatest: true,
      }),
      voice,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a stitched voice ordinal and leaves room after live voice receipts", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:voice-positions");
    const live = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("item:live-voice"),
      runId: null,
      appendAfterLatest: true,
      appendStep: 64,
    });
    assert.equal(live, 64);
    const stitched = { threadId, turnItemId: TurnItemId.make("item:recovered"), runId: null };
    assert.equal(yield* positions.allocate({ ...stitched, fixedOrdinal: 32 }), 32);
    assert.equal(yield* positions.allocate({ ...stitched, fixedOrdinal: 50 }), 32);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("falls back to receipt order when a stitched voice ordinal is taken", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:voice-collision");
    const taken = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("item:live"),
      runId: null,
      appendAfterLatest: true,
      appendStep: 64,
    });
    const recovered = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("item:recovered"),
      runId: null,
      fixedOrdinal: taken,
      appendAfterLatest: true,
      appendStep: 64,
    });
    assert.equal(recovered, taken + 64);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("places a run-start item ahead of the run's items, then appends once taken", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:run-start");
    const allocate = (id: string, placement?: "run_start") =>
      positions.allocate({
        threadId,
        turnItemId: TurnItemId.make(id),
        runId: RunId.make("run:2"),
        runOrdinal: 2,
        ...(placement === undefined ? {} : { placement }),
      });
    const message = yield* allocate("item:message");
    const recovery = yield* allocate("item:recovery", "run_start");
    assert.isBelow(recovery, message);
    assert.isAbove(recovery, 1_999_999);
    assert.equal(yield* allocate("item:retry-recovery", "run_start"), message + 1);
    assert.equal(yield* allocate("item:reply"), message + 2);
  }).pipe(Effect.provide(layerTest)),
);
