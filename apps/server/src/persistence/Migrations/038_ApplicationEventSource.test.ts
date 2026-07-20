import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ApplicationEventSource", (it) => {
  it.effect("moves V2 events and current project state behind one global sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* sql`
        INSERT INTO orchestration_v2_events (
          event_id,
          command_id,
          thread_id,
          run_id,
          node_id,
          provider,
          driver,
          provider_instance_id,
          raw_event_id,
          event_type,
          occurred_at,
          payload_json
        ) VALUES (
          'event:v2:existing',
          'command:v2:existing',
          'thread:v2:existing',
          NULL,
          NULL,
          'codex',
          'codex',
          'codex',
          NULL,
          'thread.created',
          '2026-06-20T00:00:00.000Z',
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_command_receipts (
          command_id,
          thread_id,
          command_type,
          accepted_at,
          result_sequence,
          status,
          error
        ) VALUES (
          'command:v2:existing',
          'thread:v2:existing',
          'thread.create',
          '2026-06-20T00:00:00.000Z',
          1,
          'accepted',
          NULL
        )
      `;
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

      yield* runMigrations({ toMigrationInclusive: 38 });

      const events = yield* sql<{
        readonly sequence: number;
        readonly aggregate_kind: string;
        readonly stream_id: string;
        readonly event_type: string;
        readonly application_event_version: number;
      }>`
        SELECT
          sequence,
          aggregate_kind,
          stream_id,
          event_type,
          application_event_version
        FROM orchestration_events
        WHERE application_event_version = 2
        ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(
        events.map((event) => [event.aggregate_kind, event.stream_id, event.event_type]),
        [
          ["thread", "thread:v2:existing", "thread.created"],
          ["project", "project:existing", "project.created"],
        ],
      );
      assert.ok(events[0]!.sequence < events[1]!.sequence);

      const receipts = yield* sql<{
        readonly aggregate_kind: string;
        readonly aggregate_id: string;
        readonly command_type: string;
        readonly result_sequence: number;
      }>`
        SELECT aggregate_kind, aggregate_id, command_type, result_sequence
        FROM orchestration_command_receipts
        WHERE command_id = 'command:v2:existing'
      `;
      assert.deepStrictEqual(receipts, [
        {
          aggregate_kind: "thread",
          aggregate_id: "thread:v2:existing",
          command_type: "thread.create",
          result_sequence: events[0]!.sequence,
        },
      ]);
    }),
  );
});
