import { assert, it } from "@effect/vitest";
import { BoardId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { WorkflowWebhook } from "../Services/WorkflowWebhook.ts";
import { WorkflowWebhookLive } from "./WorkflowWebhook.ts";

// Canonical in-memory SQL stack: SqlitePersistenceMemory (which runs migrations
// internally) + MigrationsLive so the workflow_webhook_delivery table + its
// (board_id, delivery_id) PRIMARY KEY from migration 033 exist, plus the layer
// under test. No timers or heavy deps are needed for delivery dedupe.
const layer = it.layer(
  WorkflowWebhookLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowWebhook delivery dedupe (concurrency)", (it) => {
  it.effect("first record is fresh (false), a repeat of the same id is a duplicate (true)", () =>
    Effect.gen(function* () {
      const webhook = yield* WorkflowWebhook;
      const board = BoardId.make("board-dedupe");

      // recordDelivery inserts ON CONFLICT DO NOTHING RETURNING and returns
      // `inserted.length === 0`: the first call inserts the row → false (fresh,
      // proceed to ingest); the second call with the same id hits the conflict →
      // no row returned → true (duplicate, skip).
      assert.isFalse(yield* webhook.recordDelivery(board, "delivery-1"));
      assert.isTrue(yield* webhook.recordDelivery(board, "delivery-1"));
    }),
  );

  it.effect(
    "concurrent same-id deliveries: EXACTLY ONE wins (false), the rest are duplicates (true)",
    () =>
      Effect.gen(function* () {
        const webhook = yield* WorkflowWebhook;
        const board = BoardId.make("board-race");
        const N = 8;

        // Fire N concurrent recordDelivery calls for the SAME id. The
        // ON CONFLICT(board_id, delivery_id) DO NOTHING ... RETURNING guarantees
        // exactly one INSERT succeeds (gets the row → false); every other call
        // sees the conflict (no row → true). This is the load-bearing
        // exactly-one-winner invariant that prevents double-ingest. We assert the
        // invariant (one false, N-1 true), NOT any specific interleaving — the
        // in-memory SqlClient may serialize the writes, but the result must hold
        // regardless of ordering.
        const results = yield* Effect.all(
          Array.from({ length: N }, () => webhook.recordDelivery(board, "delivery-concurrent")),
          { concurrency: "unbounded" },
        );

        const winners = results.filter((isDuplicate) => isDuplicate === false);
        const duplicates = results.filter((isDuplicate) => isDuplicate === true);
        assert.strictEqual(winners.length, 1, "exactly one fresh winner");
        assert.strictEqual(duplicates.length, N - 1, "every other call is a duplicate");
      }),
  );

  it.effect("releaseDelivery forgets the row so a subsequent record is fresh again", () =>
    Effect.gen(function* () {
      const webhook = yield* WorkflowWebhook;
      const board = BoardId.make("board-release");

      assert.isFalse(yield* webhook.recordDelivery(board, "delivery-r"));
      // Same id now reads as a duplicate...
      assert.isTrue(yield* webhook.recordDelivery(board, "delivery-r"));

      // releaseDelivery DELETEs the row (failed-ingest retry path). After it, the
      // sender's retry must be treated as FRESH (false), not answered "duplicate".
      yield* webhook.releaseDelivery(board, "delivery-r");
      assert.isFalse(yield* webhook.recordDelivery(board, "delivery-r"));
    }),
  );

  it.effect("different board OR different id are independent (both fresh)", () =>
    Effect.gen(function* () {
      const webhook = yield* WorkflowWebhook;
      const boardA = BoardId.make("board-indep-a");
      const boardB = BoardId.make("board-indep-b");

      // Establish a recorded delivery on board A.
      assert.isFalse(yield* webhook.recordDelivery(boardA, "shared-id"));

      // Same id on a DIFFERENT board is independent (the PK is composite) → fresh.
      assert.isFalse(yield* webhook.recordDelivery(boardB, "shared-id"));
      // A DIFFERENT id on the same board A is independent → fresh.
      assert.isFalse(yield* webhook.recordDelivery(boardA, "other-id"));

      // ...and each is now its own duplicate on a repeat.
      assert.isTrue(yield* webhook.recordDelivery(boardA, "shared-id"));
      assert.isTrue(yield* webhook.recordDelivery(boardB, "shared-id"));
      assert.isTrue(yield* webhook.recordDelivery(boardA, "other-id"));
    }),
  );
});
