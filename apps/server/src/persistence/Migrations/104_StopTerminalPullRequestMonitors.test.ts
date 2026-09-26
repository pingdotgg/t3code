import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("104_StopTerminalPullRequestMonitors", (it) => {
  it.effect("stops enabled monitors whose latest snapshot is terminal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 103 });

      for (const [id, state] of [
        ["closed-monitor", "closed"],
        ["merged-monitor", "merged"],
        ["open-monitor", "open"],
      ] as const) {
        yield* sql`
            INSERT INTO pull_request_monitors (
              monitor_id, canonical_key, provider, host, repository, number, project_id,
              status, enabled, poll_failure_count, created_at, updated_at, next_poll_at
            ) VALUES (
              ${id}, ${`github:github.com:acme/app:${id}`}, 'github', 'github.com', 'acme/app',
              1, 'project', 'monitoring', 1, 0, '2026-09-25T00:00:00.000Z',
              '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z'
            )
          `;
        yield* sql`
            INSERT INTO pull_request_monitor_snapshots (
              snapshot_id, monitor_id, source_revision, head_sha, fetched_at,
              snapshot_json, readiness_json, events_json
            ) VALUES (
              ${`snapshot-${id}`}, ${id}, 'revision', 'head',
              '2026-09-25T00:00:00.000Z', ${JSON.stringify({ state })}, '{}', '[]'
            )
          `;
      }

      yield* runMigrations({ toMigrationInclusive: 104 });

      const rows = yield* sql<{
        readonly id: string;
        readonly status: string;
        readonly enabled: number;
        readonly nextPollAt: string | null;
      }>`
          SELECT monitor_id AS id, status, enabled, next_poll_at AS "nextPollAt"
          FROM pull_request_monitors
          ORDER BY monitor_id
        `;

      assert.deepStrictEqual(rows, [
        { id: "closed-monitor", status: "terminal", enabled: 0, nextPollAt: null },
        { id: "merged-monitor", status: "terminal", enabled: 0, nextPollAt: null },
        {
          id: "open-monitor",
          status: "monitoring",
          enabled: 1,
          nextPollAt: "2026-09-25T00:00:00.000Z",
        },
      ]);
    }),
  );
});
