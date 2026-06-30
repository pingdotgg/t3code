import { assert, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import {
  OutboundConfigError,
  WorkflowOutboundConnectionStore,
} from "../Services/WorkflowOutboundConnectionStore.ts";
import { WorkflowOutboundDispatcher } from "../Services/WorkflowOutboundDispatcher.ts";
import {
  claimOutboundDeliveryRow,
  makeWorkflowOutboundDispatcherLive,
} from "./WorkflowOutboundDispatcher.ts";

const ENV_ID = "env-1" as EnvironmentId;

// ---------------------------------------------------------------------------
// Minimal stubs for the dispatcher's deps. `claimRow` is internal, so its
// invariant is asserted at the SQL level (the exact UPDATE ... RETURNING run
// via SqlClient against a seeded row). `recoverStaleClaims` IS public, so it is
// called directly through the service — that path only touches SqlClient, but
// constructing the layer still requires HttpClient / connection store /
// ServerEnvironment, which we stub as never-called (Effect.die) since no sweep
// runs in these tests.
// ---------------------------------------------------------------------------
const stubHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const stubConnectionStoreLayer = Layer.succeed(WorkflowOutboundConnectionStore, {
  getTarget: () => Effect.fail(new OutboundConfigError({ reason: "not needed in test" })),
  create: () => Effect.die("not needed in test"),
  list: () => Effect.die("not needed in test"),
  remove: () => Effect.die("not needed in test"),
} satisfies WorkflowOutboundConnectionStore["Service"]);

const serverEnvironmentLayer = Layer.succeed(ServerEnvironment, {
  getEnvironmentId: Effect.succeed(ENV_ID),
  getDescriptor: Effect.die("unsupported descriptor read"),
} as unknown as ServerEnvironment["Service"]) as Layer.Layer<ServerEnvironment>;

const layer = it.layer(
  makeWorkflowOutboundDispatcherLive().pipe(
    Layer.provideMerge(stubHttpClientLayer),
    Layer.provideMerge(stubConnectionStoreLayer),
    Layer.provideMerge(serverEnvironmentLayer),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

// Seed one workflow_outbound_delivery row. Column set + NOT-NULL requirements
// mirror the committer's INSERT (WorkflowEventCommitter.ts ~L254): delivery_id,
// board_id, ticket_id, rule_id, event_sequence, connection_ref, formatter,
// context_json and created_at are required; delivery_state / attempt_count have
// DB defaults but we set delivery_state explicitly.
// it.layer shares one DB across the tests in this suite, so each seeded row
// uses a distinct (event_sequence, rule_id) to satisfy the table's UNIQUE
// constraint — keyed off the unique deliveryId.
const seedRow = (over: {
  readonly deliveryId: string;
  readonly deliveryState: string;
  readonly eventSequence: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO workflow_outbound_delivery (
        delivery_id, board_id, ticket_id, rule_id, event_sequence,
        connection_ref, formatter, context_json, delivery_state, attempt_count,
        next_attempt_at, created_at
      ) VALUES (
        ${over.deliveryId}, 'board-1', 'ticket-1', ${over.deliveryId}, ${over.eventSequence},
        'conn-1', 'generic', '{}', ${over.deliveryState}, 0,
        ${null}, '2026-06-07T00:00:00.000Z'
      )
    `;
  });

const readState = (deliveryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly deliveryState: string }>`
      SELECT delivery_state AS "deliveryState"
      FROM workflow_outbound_delivery WHERE delivery_id = ${deliveryId}
    `;
    return rows[0]!.deliveryState;
  });

// The PRODUCTION claim statement, imported (not copied) so this test cannot
// silently pass while production claimRow drifts. Returns the rows array; a row
// is yielded only when the conditional UPDATE actually transitioned
// 'pending' → 'processing'.
const claimRowSql = (deliveryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* claimOutboundDeliveryRow(sql, deliveryId);
  });

layer("WorkflowOutboundDispatcher atomic claim + stale recovery (concurrency)", (it) => {
  it.effect(
    "two concurrent claimRow UPDATEs on one pending row: EXACTLY ONE returns a row (the winner)",
    () =>
      Effect.gen(function* () {
        yield* seedRow({ deliveryId: "dlv-claim", deliveryState: "pending", eventSequence: 1 });

        // Fire the exact claimRow conditional UPDATE concurrently. The
        // UPDATE ... WHERE delivery_state='pending' ... RETURNING guarantees only
        // the call that actually flips the row yields a RETURNING row; the loser
        // matches zero rows (state already 'processing') and gets an empty array.
        // Only the claimant proceeds to POST. We assert the invariant (exactly one
        // non-empty result), not a specific interleaving — the in-memory SqlClient
        // may serialize writes, but the conditional UPDATE must still elect one
        // winner.
        const results = yield* Effect.all([claimRowSql("dlv-claim"), claimRowSql("dlv-claim")], {
          concurrency: "unbounded",
        });

        const winners = results.filter((rows) => rows.length > 0);
        const losers = results.filter((rows) => rows.length === 0);
        assert.strictEqual(winners.length, 1, "exactly one claimant wins the row");
        assert.strictEqual(losers.length, 1, "the other claim sees an empty result");

        // The row ends up 'processing' (claimed exactly once).
        assert.strictEqual(yield* readState("dlv-claim"), "processing");
      }),
  );

  it.effect("recoverStaleClaims resets a stranded 'processing' row back to 'pending'", () =>
    Effect.gen(function* () {
      // A crash after claimRow but before markSent/recordFailure leaves the row
      // stranded 'processing'; the sweep selects only 'pending', so without
      // recovery it is never retried.
      yield* seedRow({ deliveryId: "dlv-stranded", deliveryState: "processing", eventSequence: 2 });

      const dispatcher = yield* WorkflowOutboundDispatcher;
      yield* dispatcher.recoverStaleClaims();

      // Back to 'pending' so the next sweep re-selects it.
      assert.strictEqual(yield* readState("dlv-stranded"), "pending");
    }),
  );
});
