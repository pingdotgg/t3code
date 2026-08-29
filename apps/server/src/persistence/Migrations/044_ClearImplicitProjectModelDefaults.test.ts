import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const createdAt = "2026-01-01T00:00:00.000Z";

layer("044_ClearImplicitProjectModelDefaults", (it) => {
  it.effect("clears only the known implicit creation default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });

      const insertProject = (projectId: string, defaultModelSelection: string) => sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES (
          ${projectId}, ${projectId}, ${`/tmp/${projectId}`}, ${defaultModelSelection},
          '[]', ${createdAt}, ${createdAt}
        )
      `;
      const insertEvent = (
        eventId: string,
        streamId: string,
        streamVersion: number,
        eventType: string,
        payload: string,
      ) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          ${eventId}, 'project', ${streamId}, ${streamVersion}, ${eventType},
          ${createdAt}, 'user', ${payload}, '{}'
        )
      `;

      const generated = '{"instanceId":"codex","model":"gpt-5.4"}';
      const explicit = '{"instanceId":"claudeAgent","model":"claude-sonnet-5"}';
      const callerSupplied = '{"instanceId":"codex","model":"gpt-5-codex"}';
      yield* insertProject("implicit", generated);
      yield* insertEvent(
        "created-implicit",
        "implicit",
        1,
        "project.created",
        `{"defaultModelSelection":${generated}}`,
      );
      yield* insertEvent(
        "renamed-implicit",
        "implicit",
        2,
        "project.meta-updated",
        '{"title":"Renamed"}',
      );

      yield* insertProject("explicit", explicit);
      yield* insertEvent(
        "created-explicit",
        "explicit",
        1,
        "project.created",
        `{"defaultModelSelection":${generated}}`,
      );
      yield* insertEvent(
        "updated-explicit",
        "explicit",
        2,
        "project.meta-updated",
        `{"defaultModelSelection":${explicit}}`,
      );

      yield* insertProject("caller-supplied", callerSupplied);
      yield* insertEvent(
        "created-caller-supplied",
        "caller-supplied",
        1,
        "project.created",
        `{"defaultModelSelection":${callerSupplied}}`,
      );

      yield* runMigrations({ toMigrationInclusive: 44 });

      const projects = yield* sql<{
        readonly projectId: string;
        readonly defaultModelSelection: string | null;
      }>`
        SELECT project_id AS "projectId",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        ORDER BY project_id
      `;
      assert.deepStrictEqual(projects, [
        { projectId: "caller-supplied", defaultModelSelection: callerSupplied },
        { projectId: "explicit", defaultModelSelection: explicit },
        { projectId: "implicit", defaultModelSelection: null },
      ]);

      const rewritten = yield* sql<{ readonly rewrittenCount: number }>`
        SELECT COUNT(*) AS "rewrittenCount"
        FROM orchestration_events
        WHERE event_type = 'project.created'
          AND json_type(payload_json, '$.defaultModelSelection') = 'null'
      `;
      assert.equal(rewritten[0]?.rewrittenCount, 2);
    }),
  );
});
