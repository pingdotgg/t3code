import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const MODEL_SELECTION = '{"instanceId":"codex","model":"gpt-5.6-sol"}';
const CREATED_AT = "2026-03-01T00:00:00.000Z";

layer("060_RepairClientSettlementTimestamps", (it) => {
  it.effect(
    "repairs a dense client-attributed burst on both sides of the V1 -> V2 import, and leaves everything else alone",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // 60 reads orchestration_v2_projection_threads, added by 55, so the
        // schema needs to exist before the fixtures below are inserted.
        yield* runMigrations({ toMigrationInclusive: 59 });

        const insertThread = (threadId: string, settledAt: string) => sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, latest_turn_id,
            created_at, updated_at, latest_user_message_at, settled_override, settled_at, deleted_at
          )
          VALUES (
            ${threadId}, 'project-1', ${threadId}, ${MODEL_SELECTION}, NULL,
            ${CREATED_AT}, ${settledAt}, NULL, 'settled', ${settledAt}, NULL
          )
        `;

        const insertEvent = (
          threadId: string,
          occurredAt: string,
          actorKind: "client" | "server",
          appVersion: string | null,
          streamVersion = 0,
        ) => sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          )
          VALUES (
            ${`event-${threadId}-${occurredAt}`}, 'thread', ${threadId}, ${streamVersion}, 'thread.settled', ${occurredAt},
            ${`client-random-${threadId}-${occurredAt}`}, NULL, ${`client-random-${threadId}-${occurredAt}`},
            ${actorKind},
            ${JSON.stringify({ threadId, settledAt: occurredAt, updatedAt: occurredAt })},
            ${appVersion === null ? "{}" : JSON.stringify({ origin: { appVersion } })}
          )
        `;

        // -- "sweep": 12 distinct threads settled ~2s apart, the shape of the
        // real bug report. All 12 should be repaired.
        const sweptAt = "2026-09-04T13:33:00.000Z";
        const sweepIds = Array.from({ length: 12 }, (_, index) => `sweep-${index}`);
        for (const [index, threadId] of sweepIds.entries()) {
          const occurredAt = isoPlusSeconds(sweptAt, index * 2);
          yield* insertThread(threadId, occurredAt);
          yield* insertEvent(threadId, occurredAt, "client", `0.0.${35 + (index % 4)}`);
        }
        // sweep-0 has real prior activity months before the sweep: the
        // repaired value should be that activity, not the creation fallback.
        const sweepZeroActivityAt = "2026-04-01T00:00:00.000Z";
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          )
          VALUES ('message-sweep-0', 'sweep-0', NULL, 'user', 'Prompt', 0, ${sweepZeroActivityAt}, ${sweepZeroActivityAt})
        `;
        // sweep-1 has no activity at all, so it falls back to created_at.

        // sweep-5 was already imported into V2 before this migration ran:
        // the bad settledAt is sitting in the V2 projection's JSON, not just
        // the legacy column. It also has its own real prior activity.
        const sweepFiveActivityAt = "2026-05-15T00:00:00.000Z";
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          )
          VALUES ('message-sweep-5', 'sweep-5', NULL, 'user', 'Prompt', 0, ${sweepFiveActivityAt}, ${sweepFiveActivityAt})
        `;
        const sweepFiveSweptAt = isoPlusSeconds(sweptAt, 5 * 2);
        const sweepFivePayloadBefore =
          `{"id":"sweep-5","title":"Imported before the fix",` +
          `"createdAt":"${CREATED_AT}","settledOverride":"settled","settledAt":"${sweepFiveSweptAt}"}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
          )
          VALUES (
            'sweep-5', 'project-1', 'Imported before the fix', 'codex', 'full-access', 'default',
            NULL, ${CREATED_AT}, ${sweepFiveSweptAt}, NULL, NULL, ${sweepFivePayloadBefore}
          )
        `;

        // -- A genuine manual settle 45s after the sweep's last member: well
        // inside the old "anything within 120s of a qualifying pivot" reach,
        // but more than the 30s cluster gap, so it must stay untouched. This
        // is the case Macroscope flagged on the closed PR.
        const laterManualAt = isoPlusSeconds(sweptAt, 22 + 45);
        yield* insertThread("later-manual", laterManualAt);
        yield* insertEvent("later-manual", laterManualAt, "client", "0.0.37");

        // -- A lone manual settle, far from everything in time.
        const manualAt = "2026-08-01T00:00:00.000Z";
        yield* insertThread("manual", manualAt);
        yield* insertEvent("manual", manualAt, "client", "0.0.36");

        // -- "small": 9 distinct threads, same cadence as the sweep, but
        // below the 10-thread threshold.
        const smallBase = "2026-09-03T00:00:00.000Z";
        const smallIds = Array.from({ length: 9 }, (_, index) => `small-${index}`);
        for (const [index, threadId] of smallIds.entries()) {
          const occurredAt = isoPlusSeconds(smallBase, index * 2);
          yield* insertThread(threadId, occurredAt);
          yield* insertEvent(threadId, occurredAt, "client", `0.0.${35 + (index % 4)}`);
        }

        // -- "repeated": one thread settled 10 times in a row. Ten events,
        // but one distinct thread, so it must not read as a 10-thread burst.
        const repeatedBase = "2026-09-03T01:00:00.000Z";
        const repeatedLastAt = isoPlusSeconds(repeatedBase, 9 * 2);
        yield* insertThread("repeated-0", repeatedLastAt);
        for (let index = 0; index < 10; index++) {
          yield* insertEvent(
            "repeated-0",
            isoPlusSeconds(repeatedBase, index * 2),
            "client",
            "0.0.37",
            index,
          );
        }

        // -- "spread": 10 distinct threads, each only 15s from the next (so
        // the gap check alone would not split it), but the cluster's full
        // span is 135s, over the 2-minute cap.
        const spreadBase = "2026-09-03T02:00:00.000Z";
        const spreadIds = Array.from({ length: 10 }, (_, index) => `spread-${index}`);
        for (const [index, threadId] of spreadIds.entries()) {
          const occurredAt = isoPlusSeconds(spreadBase, index * 15);
          yield* insertThread(threadId, occurredAt);
          yield* insertEvent(threadId, occurredAt, "client", `0.0.${35 + (index % 4)}`);
        }

        // -- "wrongver": same cadence as the sweep, same time window even,
        // but from a desktop build outside the affected range.
        const wrongverIds = Array.from({ length: 10 }, (_, index) => `wrongver-${index}`);
        for (const [index, threadId] of wrongverIds.entries()) {
          const occurredAt = isoPlusSeconds(sweptAt, index * 2);
          yield* insertThread(threadId, occurredAt);
          yield* insertEvent(threadId, occurredAt, "client", "0.0.40");
        }

        // -- "noorigin": same shape, but no app-version metadata at all.
        const noOriginIds = Array.from({ length: 10 }, (_, index) => `noorigin-${index}`);
        for (const [index, threadId] of noOriginIds.entries()) {
          const occurredAt = isoPlusSeconds(sweptAt, index * 2);
          yield* insertThread(threadId, occurredAt);
          yield* insertEvent(threadId, occurredAt, "client", null);
        }

        // -- "late": same shape, but on/after the cutover date.
        const lateBase = "2026-09-05T00:00:00.000Z";
        const lateIds = Array.from({ length: 10 }, (_, index) => `late-${index}`);
        for (const [index, threadId] of lateIds.entries()) {
          const occurredAt = isoPlusSeconds(lateBase, index * 2);
          yield* insertThread(threadId, occurredAt);
          yield* insertEvent(threadId, occurredAt, "client", `0.0.${35 + (index % 4)}`);
        }

        const eventsBefore = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;

        yield* runMigrations();

        const threads = yield* sql<{ readonly thread_id: string; readonly settled_at: string }>`
          SELECT thread_id, settled_at FROM projection_threads ORDER BY thread_id
        `;
        const settledAtByThread = new Map(threads.map((t) => [t.thread_id, t.settled_at]));

        // The sweep is repaired: real activity wins for sweep-0, creation
        // wins where there was no activity.
        assert.strictEqual(settledAtByThread.get("sweep-0"), sweepZeroActivityAt);
        assert.strictEqual(settledAtByThread.get("sweep-1"), CREATED_AT);
        for (const threadId of sweepIds) {
          assert.notStrictEqual(
            settledAtByThread.get(threadId),
            isoPlusSeconds(sweptAt, sweepIds.indexOf(threadId) * 2),
            `${threadId} should no longer carry its sweep timestamp`,
          );
        }

        // Already-imported V2 projection: the legacy row is repaired to the
        // real activity, and so is the JSON copy, without disturbing other
        // keys in that JSON payload.
        assert.strictEqual(settledAtByThread.get("sweep-5"), sweepFiveActivityAt);
        const sweepFiveV2 = yield* sql<{
          readonly settledAt: string;
          readonly title: string;
          readonly settledOverride: string;
        }>`
          SELECT
            json_extract(payload_json, '$.settledAt') AS "settledAt",
            json_extract(payload_json, '$.title') AS "title",
            json_extract(payload_json, '$.settledOverride') AS "settledOverride"
          FROM orchestration_v2_projection_threads WHERE thread_id = 'sweep-5'
        `;
        assert.strictEqual(sweepFiveV2[0]!.settledAt, sweepFiveActivityAt);
        assert.strictEqual(sweepFiveV2[0]!.title, "Imported before the fix");
        assert.strictEqual(sweepFiveV2[0]!.settledOverride, "settled");

        // Everything else is untouched, including the manual settle that
        // landed just after the sweep (the case the prior review flagged).
        assert.strictEqual(settledAtByThread.get("later-manual"), laterManualAt);
        assert.strictEqual(settledAtByThread.get("manual"), manualAt);
        for (const threadId of smallIds) {
          assert.strictEqual(
            settledAtByThread.get(threadId),
            isoPlusSeconds(smallBase, smallIds.indexOf(threadId) * 2),
          );
        }
        assert.strictEqual(settledAtByThread.get("repeated-0"), repeatedLastAt);
        for (const threadId of spreadIds) {
          assert.strictEqual(
            settledAtByThread.get(threadId),
            isoPlusSeconds(spreadBase, spreadIds.indexOf(threadId) * 15),
          );
        }
        for (const threadId of wrongverIds) {
          assert.strictEqual(
            settledAtByThread.get(threadId),
            isoPlusSeconds(sweptAt, wrongverIds.indexOf(threadId) * 2),
          );
        }
        for (const threadId of noOriginIds) {
          assert.strictEqual(
            settledAtByThread.get(threadId),
            isoPlusSeconds(sweptAt, noOriginIds.indexOf(threadId) * 2),
          );
        }
        for (const threadId of lateIds) {
          assert.strictEqual(
            settledAtByThread.get(threadId),
            isoPlusSeconds(lateBase, lateIds.indexOf(threadId) * 2),
          );
        }

        // Only the projections changed; event history is untouched.
        const eventsAfter = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
        assert.deepStrictEqual(eventsAfter, eventsBefore);

        // Idempotent: nothing left to run, and running the repair again is a no-op.
        assert.deepStrictEqual(yield* runMigrations(), []);
      }),
  );
});

function isoPlusSeconds(iso: string, seconds: number): string {
  return DateTime.makeUnsafe(iso).pipe(DateTime.add({ seconds }), DateTime.formatIso);
}
