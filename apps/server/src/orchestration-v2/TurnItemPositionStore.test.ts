import { assert, it } from "@effect/vitest";
import { MessageId, ProviderTurnId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("fences boundary reservations and restores an explicitly retried message's own run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:boundary-position");
    const turnItemId = TurnItemId.make("item:boundary-message");
    const queuedRunId = RunId.make("run:queued");
    const runId = RunId.make("run:receiving");
    const providerTurnId = ProviderTurnId.make("turn:receiving");
    const offerId = "boundary-offer";
    const now = DateTime.makeUnsafe("2026-11-08T15:00:00Z");
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status,
        requested_at, completed_at, payload_json
      ) VALUES (
        ${queuedRunId}, ${threadId}, 5, 'claudeAgent', NULL, 'queued',
        ${DateTime.formatIso(now)}, NULL,
        ${JSON.stringify({ boundaryOffer: { id: offerId, targetRunId: runId, providerTurnId } })}
      )
    `;
    const original = yield* positions.allocate({
      threadId,
      turnItemId,
      runId: queuedRunId,
      runOrdinal: 5,
    });
    const reserve = {
      threadId,
      turnItemId,
      runId,
      runOrdinal: 1,
      queuedRunId,
      offerId,
      providerTurnId,
    };
    for (const stale of [
      { ...reserve, offerId: "stale-offer" },
      { ...reserve, providerTurnId: ProviderTurnId.make("turn:replacement") },
      { ...reserve, runId: RunId.make("run:replacement") },
    ]) {
      yield* positions.reserveBoundary(stale);
      assert.equal(yield* positions.allocate({ threadId, turnItemId, runId }), original);
    }
    const toolPosition = yield* positions.allocate({
      threadId,
      turnItemId: TurnItemId.make("item:preceding-tool"),
      runId,
      runOrdinal: 1,
    });
    yield* positions.reserveBoundary(reserve);
    const reserved = yield* positions.allocate({ threadId, turnItemId, runId });
    assert.equal(reserved, toolPosition + 2);
    assert.equal(
      yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("item:following-assistant"),
        runId,
        runOrdinal: 1,
      }),
      reserved + 1,
    );
    yield* positions.reserveBoundary(reserve);
    assert.equal(yield* positions.allocate({ threadId, turnItemId, runId }), reserved);
    const replacementOfferId = "replacement-boundary-offer";
    yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET payload_json = json_set(payload_json, '$.boundaryOffer.id', ${replacementOfferId})
      WHERE run_id = ${queuedRunId}
    `;
    yield* positions.reserveBoundary({ ...reserve, offerId: replacementOfferId });
    const replacementPosition = yield* positions.allocate({ threadId, turnItemId, runId });
    assert.isAbove(replacementPosition, reserved + 1);
    yield* positions.reserveBoundary({ ...reserve, offerId: replacementOfferId });
    yield* positions.reserveBoundary(reserve);
    assert.equal(yield* positions.allocate({ threadId, turnItemId, runId }), replacementPosition);
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'starting' WHERE run_id = ${queuedRunId}`;
    const retried = yield* positions.normalize(
      {
        id: turnItemId,
        threadId,
        runId: queuedRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: reserved,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: MessageId.make("message:retried"),
        inputIntent: "queued_turn",
        text: "Try again",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      6,
    );
    assert.equal(retried.ordinal, 6_000_001);
    yield* positions.reserveBoundary(reserve);
    assert.equal(yield* positions.allocate({ threadId, turnItemId, runId }), retried.ordinal);
  }).pipe(Effect.provide(layerTest)),
);
