import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { IssueTrackerKind, ProjectId } from "@t3tools/contracts";

import { runMigrations } from "../Migrations.ts";
import * as IssueTrackerBindings from "../IssueTrackerBindings.ts";

it.effect("keeps existing tracker bindings and stores each new binding's verified host", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 63 });
    yield* sql`INSERT INTO issue_tracker_bindings (project_id, tracker, scope, updated_at)
      VALUES ('old-project', 'linear', 'ENG', '2026-10-14T00:00:00Z')`;
    yield* runMigrations();
    yield* sql`INSERT INTO issue_tracker_bindings (project_id, tracker, scope, host, updated_at)
      VALUES ('new-project', 'jira', 'ENG', 'example.atlassian.net', '2026-10-14T00:00:00Z')`;
    const rows = yield* sql<{ readonly projectId: string; readonly host: string | null }>`
      SELECT project_id AS "projectId", host FROM issue_tracker_bindings ORDER BY project_id`;
    assert.deepEqual(rows, [
      { projectId: "new-project", host: "example.atlassian.net" },
      { projectId: "old-project", host: null },
    ]);
    yield* Effect.gen(function* () {
      const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository;
      const saved = {
        tracker: IssueTrackerKind.make("jira"),
        scope: "OPS",
        host: "second.atlassian.net",
      };
      yield* bindings.set({
        projectId: ProjectId.make("new-project"),
        binding: saved,
        updatedAt: "2026-10-14T01:00:00Z",
      });
      const stored = yield* bindings.list;
      assert.deepEqual(stored.get(ProjectId.make("new-project")), saved);
      assert.deepEqual(stored.get(ProjectId.make("old-project")), {
        tracker: IssueTrackerKind.make("linear"),
        scope: "ENG",
      });
    }).pipe(Effect.provide(IssueTrackerBindings.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
