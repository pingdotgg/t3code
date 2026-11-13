import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("087_ProjectionProjectsCustomTitle", (it) => {
  it.effect("marks projects with a recorded title update as renamed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 86 });
      for (const projectId of ["renamed", "untouched"]) {
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${projectId}, 'repo', ${"/tmp/" + projectId}, '[]', '2026-10-01', '2026-10-01')
        `;
        yield* sql`
          INSERT INTO orchestration_events
            (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
             actor_kind, payload_json, metadata_json, application_event_version)
          VALUES (${projectId}, 'project', ${projectId}, 1, 'project.meta-updated', '2026-10-01',
            'client', ${JSON.stringify(projectId === "renamed" ? { title: "repo" } : { autoPull: true })}, '{}', 2)
        `;
      }
      // Builds of this change before renumbering already added the column.
      yield* sql`ALTER TABLE projection_projects ADD COLUMN has_custom_title INTEGER NOT NULL DEFAULT 0`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT project_id, has_custom_title FROM projection_projects ORDER BY project_id`,
        [
          { project_id: "renamed", has_custom_title: 1 },
          { project_id: "untouched", has_custom_title: 0 },
        ],
      );
    }),
  );
});
