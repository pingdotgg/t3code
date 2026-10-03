import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import repair from "./103_RepairActivityChronologyIndexes.ts";

it.effect("repairs skipped chronology indexes above the existing migration high-water mark", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 102 });
    yield* sql`DROP INDEX idx_projection_thread_activities_thread_chronology`;
    yield* sql`DROP INDEX idx_projection_thread_activities_thread_kind_created`;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 60`;

    assert.deepStrictEqual(yield* runMigrations(), [
      [103, "RepairActivityChronologyIndexes"],
      [104, "StopTerminalPullRequestMonitors"],
      [105, "ProjectionThreadPendingPullRequestAssociation"],
      [106, "PullRequestCreationIntents"],
      [107, "DelegationAudit"],
      [108, "DelegationAuditLookupIndexes"],
      [109, "DelegationAuditToolCallIndex"],
      [110, "ActivityPayloadBlobs"],
      [111, "RemoveRedundantProjectionIndexes"],
      [112, "RequeuePullRequestGatedWorktreeCleanup"],
      [113, "ProjectionCheckpointTransitionFiles"],
      [114, "RepairThreadContextHistory"],
      [115, "GitActivityLedger"],
      [116, "CollaborativeAcceptancePullRequestLookup"],
      [117, "PendingPullRequestFeedbackIndex"],
      [118, "QueueHoldAndShutdownMarker"],
    ]);
    yield* repair;
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 60`,
      [],
    );

    const indexes = yield* sql<{ readonly name: string }>`
      PRAGMA index_list(projection_thread_activities)
    `;
    for (const name of [
      "idx_projection_thread_activities_thread_chronology",
      "idx_projection_thread_activities_thread_kind_created",
    ]) {
      assert.isTrue(indexes.some((index) => index.name === name));
    }
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT activity_id, payload_json
      FROM projection_thread_activities
      WHERE thread_id = 'thread'
      ORDER BY created_at DESC, activity_id DESC
      LIMIT 500
    `;
    assert.isTrue(
      plan.some((row) => row.detail.includes("idx_projection_thread_activities_thread_chronology")),
    );
    assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
