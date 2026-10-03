import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

layer("057_CodexUsageNativeTurnIndex", (it) => {
  it.effect("indexes the Codex lookup without changing matches or removing ambiguous turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });

      for (const { id, driver, nativeId } of [
        { id: "match", driver: "codex", nativeId: "requested" },
        { id: "duplicate", driver: "codex", nativeId: "requested" },
        { id: "second", driver: "codex", nativeId: "requested-second" },
        { id: "other-provider", driver: "claude", nativeId: "requested" },
        { id: "unrelated", driver: "codex", nativeId: "unrelated" },
      ]) {
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
          attempt_id: `attempt-${id}`,
          thread_id: `thread-${id}`,
          run_id: `run-${id}`,
          attempt_ordinal: 1,
          root_node_id: `node-${id}`,
          provider: driver,
          provider_thread_id: `provider-thread-${id}`,
          status: "completed",
          payload_json: "{}",
        })}`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
          provider_turn_id: `turn-${id}`,
          thread_id: `thread-${id}`,
          provider_thread_id: `provider-thread-${id}`,
          node_id: `node-${id}`,
          run_attempt_id: `attempt-${id}`,
          ordinal: 1,
          status: "completed",
          payload_json: encodeJson({ nativeTurnRef: { driver, nativeId, strength: "strong" } }),
        })}`;
      }

      // Use the usage reader's joins and batched native-ID predicate.
      const lookup = sql<{ readonly provider_turn_id: string }>`
        SELECT turn.provider_turn_id
        FROM orchestration_v2_projection_provider_turns AS turn
        JOIN orchestration_v2_projection_run_attempts AS attempt
          ON attempt.attempt_id = turn.run_attempt_id
          AND attempt.thread_id = turn.thread_id
          AND attempt.provider_thread_id = turn.provider_thread_id
        WHERE json_extract(turn.payload_json, '$.nativeTurnRef.driver') = 'codex'
          AND json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') IN (
            SELECT value FROM json_each(${encodeJson(["requested", "requested-second", "missing"])})
          )
      `;
      const before = (yield* lookup).map((row) => row.provider_turn_id).toSorted();
      assert.deepStrictEqual(before, ["turn-duplicate", "turn-match", "turn-second"]);

      yield* runMigrations({ toMigrationInclusive: 57 });
      assert.deepStrictEqual((yield* lookup).map((row) => row.provider_turn_id).toSorted(), before);

      const [statement, parameters] = lookup.compile();
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
        parameters,
      );
      assert.isTrue(
        plan.some((row) =>
          /SEARCH turn USING INDEX orchestration_v2_provider_turns_codex_native_id_idx\b/.test(
            row.detail,
          ),
        ),
        plan.map((row) => row.detail).join("\n"),
      );
      assert.isFalse(plan.some((row) => /SCAN turn\b/.test(row.detail)));
    }),
  );
});
