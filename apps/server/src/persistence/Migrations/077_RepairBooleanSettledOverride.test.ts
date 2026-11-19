import { assert, it } from "@effect/vitest";
import { OrchestrationV2AppThreadJson } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const createdAt = "2026-09-01T00:00:00.000Z";
const decodeThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

layer("077_RepairBooleanSettledOverride", (it) => {
  it.effect("canonicalizes boolean settled overrides so recovery can decode them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      const overrides: ReadonlyArray<readonly [string, unknown]> = [
        ["true", true],
        ["false", false],
        ["settled", "settled"],
        ["active", "active"],
        ["null", null],
        ["absent", undefined],
      ];
      for (const [id, settledOverride] of overrides) {
        const payload = {
          id,
          projectId: "project-1",
          title: id,
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: null,
          deletedAt: null,
          settledOverride,
          settledAt: settledOverride === true ? createdAt : null,
        };
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${id}, 'project-1', ${id}, 'codex', 'full-access', 'default',
            ${createdAt}, ${createdAt}, ${JSON.stringify(payload)}
          )
        `;
      }
      const rows = sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_threads ORDER BY thread_id
      `;
      const before = new Map((yield* rows).map((row) => [row.thread_id, row.payload_json]));

      yield* runMigrations({ toMigrationInclusive: 77 });
      const after = new Map((yield* rows).map((row) => [row.thread_id, row.payload_json]));
      for (const id of ["settled", "active", "null", "absent"]) {
        assert.strictEqual(after.get(id), before.get(id));
      }
      const repaired = yield* sql`
        SELECT thread_id,
          json_type(payload_json, '$.settledOverride') AS type,
          json_extract(payload_json, '$.settledOverride') AS settled_override,
          json_extract(payload_json, '$.settledAt') AS settled_at
        FROM orchestration_v2_projection_threads WHERE thread_id IN ('true', 'false')
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(repaired, [
        { thread_id: "false", type: "null", settled_override: null, settled_at: null },
        { thread_id: "true", type: "text", settled_override: "settled", settled_at: createdAt },
      ]);
      const thread = yield* decodeThreadPayload(after.get("true"));
      assert.strictEqual(thread.settledOverride, "settled");
    }),
  );
});
