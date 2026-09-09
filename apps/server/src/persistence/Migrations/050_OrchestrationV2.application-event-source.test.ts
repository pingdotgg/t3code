import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_OrchestrationV2 application event source", (it) => {
  it.effect("baselines current V1 project state in the shared event log", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:existing',
          'Existing project',
          '/work/existing',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-06-19T00:00:00.000Z',
          '2026-06-20T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations();

      const events = yield* sql<{
        readonly aggregate_kind: string;
        readonly stream_id: string;
        readonly event_type: string;
        readonly application_event_version: number;
      }>`
        SELECT aggregate_kind, stream_id, event_type, application_event_version
        FROM orchestration_events
        WHERE stream_id = 'project:existing'
        ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(events, [
        {
          aggregate_kind: "project",
          stream_id: "project:existing",
          event_type: "project.created",
          application_event_version: 2,
        },
      ]);
    }),
  );
});
