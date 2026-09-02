import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ClearImplicitProjectModelDefaults", (it) => {
  it.effect("clears creation-only Codex seeds and preserves later default updates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at,
          deleted_at,
          default_model_selection_json
        ) VALUES
          (
            'auto-sol',
            'Auto Sol',
            '/tmp/auto-sol',
            '[]',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL,
            '{"instanceId":"codex","model":"gpt-5.6-sol"}'
          ),
          (
            'auto-5-4',
            'Auto 5.4',
            '/tmp/auto-5-4',
            '[]',
            '2026-01-02T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            NULL,
            '{"instanceId":"codex","model":"gpt-5.4"}'
          ),
          (
            'renamed-project',
            'Renamed project',
            '/tmp/renamed-project',
            '[]',
            '2026-01-03T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            '{"instanceId":"codex","model":"gpt-5.6-sol"}'
          ),
          (
            'explicit-meta',
            'Explicit metadata update',
            '/tmp/explicit-meta',
            '[]',
            '2026-01-05T00:00:00.000Z',
            '2026-01-06T00:00:00.000Z',
            NULL,
            '{"instanceId":"codex","model":"gpt-5.6-sol"}'
          ),
          (
            'explicit-reset',
            'Explicit reset',
            '/tmp/explicit-reset',
            '[]',
            '2026-01-07T00:00:00.000Z',
            '2026-01-08T00:00:00.000Z',
            NULL,
            NULL
          ),
          (
            'explicit-options',
            'Explicit options',
            '/tmp/explicit-options',
            '[]',
            '2026-01-09T00:00:00.000Z',
            '2026-01-09T00:00:00.000Z',
            NULL,
            '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}'
          ),
          (
            'other-provider',
            'Other provider',
            '/tmp/other-provider',
            '[]',
            '2026-01-10T00:00:00.000Z',
            '2026-01-10T00:00:00.000Z',
            NULL,
            '{"instanceId":"claudeAgent","model":"claude-opus-4-8"}'
          )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        ) VALUES
          (
            'event-auto-sol',
            'project',
            'auto-sol',
            0,
            'project.created',
            '2026-01-01T00:00:00.000Z',
            'command-auto-sol',
            NULL,
            NULL,
            'client',
            '{"projectId":"auto-sol","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}',
            '{}'
          ),
          (
            'event-auto-5-4',
            'project',
            'auto-5-4',
            0,
            'project.created',
            '2026-01-02T00:00:00.000Z',
            'command-auto-5-4',
            NULL,
            NULL,
            'client',
            '{"projectId":"auto-5-4","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.4"}}',
            '{}'
          ),
          (
            'event-renamed-created',
            'project',
            'renamed-project',
            0,
            'project.created',
            '2026-01-03T00:00:00.000Z',
            'command-renamed-created',
            NULL,
            NULL,
            'client',
            '{"projectId":"renamed-project","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}',
            '{}'
          ),
          (
            'event-explicit-meta-created',
            'project',
            'explicit-meta',
            0,
            'project.created',
            '2026-01-05T00:00:00.000Z',
            'command-explicit-meta-created',
            NULL,
            NULL,
            'client',
            '{"projectId":"explicit-meta","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}',
            '{}'
          ),
          (
            'event-explicit-reset-created',
            'project',
            'explicit-reset',
            0,
            'project.created',
            '2026-01-07T00:00:00.000Z',
            'command-explicit-reset-created',
            NULL,
            NULL,
            'client',
            '{"projectId":"explicit-reset","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}',
            '{}'
          ),
          (
            'event-explicit-options',
            'project',
            'explicit-options',
            0,
            'project.created',
            '2026-01-09T00:00:00.000Z',
            'command-explicit-options',
            NULL,
            NULL,
            'client',
            '{"projectId":"explicit-options","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}}',
            '{}'
          ),
          (
            'event-other-provider',
            'project',
            'other-provider',
            0,
            'project.created',
            '2026-01-10T00:00:00.000Z',
            'command-other-provider',
            NULL,
            NULL,
            'client',
            '{"projectId":"other-provider","defaultModelSelection":{"instanceId":"claudeAgent","model":"claude-opus-4-8"}}',
            '{}'
          ),
          (
            'event-renamed-meta',
            'project',
            'renamed-project',
            1,
            'project.meta-updated',
            '2026-01-04T00:00:00.000Z',
            'command-renamed-meta',
            NULL,
            NULL,
            'client',
            '{"projectId":"renamed-project","title":"Renamed project"}',
            '{}'
          ),
          (
            'event-explicit-meta-updated',
            'project',
            'explicit-meta',
            1,
            'project.meta-updated',
            '2026-01-06T00:00:00.000Z',
            'command-explicit-meta-updated',
            NULL,
            NULL,
            'client',
            '{"projectId":"explicit-meta","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}',
            '{}'
          ),
          (
            'event-explicit-reset-meta',
            'project',
            'explicit-reset',
            1,
            'project.meta-updated',
            '2026-01-08T00:00:00.000Z',
            'command-explicit-reset-meta',
            NULL,
            NULL,
            'client',
            '{"projectId":"explicit-reset","defaultModelSelection":null}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const projects = yield* sql<{
        readonly projectId: string;
        readonly defaultModelSelection: string | null;
      }>`
        SELECT
          project_id AS "projectId",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        ORDER BY project_id
      `;
      assert.deepStrictEqual(projects, [
        { projectId: "auto-5-4", defaultModelSelection: null },
        { projectId: "auto-sol", defaultModelSelection: null },
        {
          projectId: "explicit-meta",
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5.6-sol"}',
        },
        {
          projectId: "explicit-options",
          defaultModelSelection:
            '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}',
        },
        { projectId: "explicit-reset", defaultModelSelection: null },
        { projectId: "other-provider", defaultModelSelection: null },
        { projectId: "renamed-project", defaultModelSelection: null },
      ]);

      const createdEvents = yield* sql<{
        readonly streamId: string;
        readonly defaultModelSelection: string | null;
      }>`
        SELECT
          stream_id AS "streamId",
          json_extract(payload_json, '$.defaultModelSelection') AS "defaultModelSelection"
        FROM orchestration_events
        WHERE event_type = 'project.created'
        ORDER BY stream_id
      `;
      assert.deepStrictEqual(createdEvents, [
        { streamId: "auto-5-4", defaultModelSelection: null },
        { streamId: "auto-sol", defaultModelSelection: null },
        {
          streamId: "explicit-meta",
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5.6-sol"}',
        },
        {
          streamId: "explicit-options",
          defaultModelSelection:
            '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}',
        },
        {
          streamId: "explicit-reset",
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5.6-sol"}',
        },
        { streamId: "other-provider", defaultModelSelection: null },
        { streamId: "renamed-project", defaultModelSelection: null },
      ]);
    }),
  );
});
