import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertHandoff = (input: {
  readonly handoffId: string;
  readonly previousHandoffId?: string | null;
  readonly state?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_thread_handoffs (
        handoff_id,
        thread_id,
        peer_environment_id,
        peer_thread_id,
        previous_handoff_id,
        hop_count,
        state,
        manifest_json,
        created_at,
        updated_at
      ) VALUES (
        ${input.handoffId},
        'thread:1',
        'environment:staging',
        'thread:2',
        ${input.previousHandoffId ?? null},
        0,
        ${input.state ?? "departed"},
        '{"version":1}',
        '2026-08-06T00:00:00.000Z',
        '2026-08-06T00:00:00.000Z'
      )
    `;
  });

layer("046_OrchestrationV2ThreadHandoffs", (it) => {
  it.effect("stores a hop and leaves recovery columns empty until a bundle is applied", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });

      yield* insertHandoff({ handoffId: "handoff:1" });

      const rows = yield* sql<{
        readonly handoff_id: string;
        readonly hop_count: number;
        readonly previous_handoff_id: string | null;
        readonly applied_head_sha: string | null;
        readonly stash_ref: string | null;
        readonly pre_tag: string | null;
      }>`SELECT * FROM orchestration_v2_thread_handoffs`;

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.handoff_id, "handoff:1");
      assert.strictEqual(rows[0]?.hop_count, 0);
      assert.strictEqual(rows[0]?.previous_handoff_id, null);
      assert.strictEqual(rows[0]?.applied_head_sha, null);
      assert.strictEqual(rows[0]?.stash_ref, null);
      assert.strictEqual(rows[0]?.pre_tag, null);
    }),
  );

  it.effect("rejects a second row for the same hop, so a bundle cannot be applied twice", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 47 });

      yield* insertHandoff({ handoffId: "handoff:duplicate" });
      const duplicate = yield* Effect.result(insertHandoff({ handoffId: "handoff:duplicate" }));

      assert.strictEqual(duplicate._tag, "Failure");
    }),
  );

  it.effect("chains hops so a lineage can be walked back to an earlier environment", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });

      yield* insertHandoff({ handoffId: "handoff:hop-1" });
      yield* insertHandoff({ handoffId: "handoff:hop-2", previousHandoffId: "handoff:hop-1" });

      const rows = yield* sql<{
        readonly handoff_id: string;
        readonly previous_handoff_id: string | null;
      }>`
        SELECT handoff_id, previous_handoff_id
        FROM orchestration_v2_thread_handoffs
        WHERE handoff_id LIKE 'handoff:hop-%'
        ORDER BY handoff_id
      `;

      assert.deepStrictEqual(
        rows.map((row) => [row.handoff_id, row.previous_handoff_id]),
        [
          ["handoff:hop-1", null],
          ["handoff:hop-2", "handoff:hop-1"],
        ],
      );
    }),
  );

  it.effect("finds hops left mid-apply, the only state that can have touched a repository", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });

      yield* insertHandoff({ handoffId: "handoff:arrived", state: "arrived" });
      yield* insertHandoff({ handoffId: "handoff:applying", state: "applying" });

      const rows = yield* sql<{ readonly handoff_id: string }>`
        SELECT handoff_id FROM orchestration_v2_thread_handoffs WHERE state = 'applying'
      `;

      assert.deepStrictEqual(
        rows.map((row) => row.handoff_id),
        ["handoff:applying"],
      );
    }),
  );
});
