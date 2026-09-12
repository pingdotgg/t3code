import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

interface PullRequestRow {
  readonly threadId: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly source: string;
  readonly linkedAt: string;
  readonly snapshotJson: string | null;
  readonly stackJson: string | null;
}

layer("050_ProjectionThreadPullRequests", (it) => {
  it.effect("creates the link table and backfills legacy single links", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '[]',
          '2026-03-01T00:00:00.000Z',
          '2026-03-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          linked_pull_request_json,
          created_at,
          updated_at
        )
        VALUES
          (
            'thread-github',
            'project-1',
            'GitHub link',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            '{"projectId":"project-1","repository":"PingDotGG/T3Code","number":42,"url":"https://GitHub.com/pingdotgg/t3code/pull/42"}',
            '2026-03-01T00:00:01.000Z',
            '2026-03-02T00:00:00.000Z'
          ),
          (
            'thread-bad-url',
            'project-1',
            'Unparseable URL',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            '{"projectId":"project-1","repository":"acme/widgets","number":7,"url":"not a url"}',
            '2026-03-01T00:00:02.000Z',
            '2026-03-03T00:00:00.000Z'
          ),
          (
            'thread-malformed',
            'project-1',
            'Malformed JSON',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            '{"repository":"acme/widgets"}',
            '2026-03-01T00:00:03.000Z',
            '2026-03-04T00:00:00.000Z'
          ),
          (
            'thread-unlinked',
            'project-1',
            'No link',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            NULL,
            '2026-03-01T00:00:04.000Z',
            '2026-03-05T00:00:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const rows = yield* sql<PullRequestRow>`
        SELECT
          thread_id AS "threadId",
          host,
          repository,
          number,
          url,
          source,
          linked_at AS "linkedAt",
          snapshot_json AS "snapshotJson",
          stack_json AS "stackJson"
        FROM projection_thread_pull_requests
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-bad-url",
          host: "unknown",
          repository: "acme/widgets",
          number: 7,
          url: "not a url",
          source: "manual",
          linkedAt: "2026-03-03T00:00:00.000Z",
          snapshotJson: null,
          stackJson: null,
        },
        {
          threadId: "thread-github",
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 42,
          url: "https://GitHub.com/pingdotgg/t3code/pull/42",
          source: "manual",
          linkedAt: "2026-03-02T00:00:00.000Z",
          snapshotJson: null,
          stackJson: null,
        },
      ]);

      // The legacy column stays so a rollback keeps its data.
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "linked_pull_request_json"));

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_pull_requests)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_projection_thread_pull_requests_pr"));
    }),
  );
});

it.layer(Layer.fresh(NodeSqliteClient.layerMemory()))("050 Azure legacy links", (it) => {
  it.effect("keeps legacy Azure repositories distinct across organizations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      for (const organization of ["org-a", "org-b"]) {
        yield* sql`
          INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, linked_pull_request_json, created_at, updated_at)
          VALUES (${organization}, ${organization}, 'Azure', '{"instanceId":"codex","model":"gpt-5.4"}',
            ${encodeJson({ projectId: organization, repository: "web", number: 7, url: `https://dev.azure.com/${organization}/project/_git/web/pullrequest/7` })},
            '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')
        `;
      }
      yield* runMigrations({ toMigrationInclusive: 50 });
      const rows =
        yield* sql`SELECT host, repository, number FROM projection_thread_pull_requests ORDER BY repository`;
      assert.deepStrictEqual(rows, [
        { host: "dev.azure.com", repository: "org-a/project/_git/web", number: 7 },
        { host: "dev.azure.com", repository: "org-b/project/_git/web", number: 7 },
      ]);
    }),
  );
});
