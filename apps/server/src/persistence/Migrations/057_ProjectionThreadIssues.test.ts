import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import IssueLinks from "./057_ProjectionThreadIssues.ts";
import WorkItemLinks from "./058_WorkItemLinks.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("adds an issue link column with an empty default", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* runMigrations({ toMigrationInclusive: 57 });
    const columns = yield* sql<{
      readonly name: string;
      readonly notnull: number;
      readonly dflt_value: string | null;
    }>`PRAGMA table_info(projection_threads)`;
    const column = columns.find((entry) => entry.name === "issue_links_json");
    assert.equal(column?.notnull, 1);
    assert.equal(column?.dflt_value, "'[]'");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
it.effect("upgrades the issue preview ledger without losing saved links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 53 });
    yield* IssueLinks;
    yield* WorkItemLinks;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (54, 'ProjectionThreadIssues'), (55, 'WorkItemLinks')`;
    yield* sql`INSERT INTO work_item_links VALUES
          ('github', 'issue-url', 'team/repo', 1, 'Issue',
           'github', 'pr-url', 'team/repo', 2, 'Pull request')`;
    yield* runMigrations();
    const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 54 ORDER BY migration_id`;
    assert.deepEqual(history, [
      { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
      { migration_id: 55, name: "OrchestrationV2" },
      { migration_id: 56, name: "RemoveRedundantProjectionIndexes" },
      { migration_id: 57, name: "ProjectionThreadIssues" },
      { migration_id: 58, name: "WorkItemLinks" },
    ]);
    const links = yield* sql<{
      readonly issue_title: string;
    }>`SELECT issue_title FROM work_item_links`;
    assert.deepEqual(links, [{ issue_title: "Issue" }]);
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_threads'`;
    assert.equal(tables.length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
