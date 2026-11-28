import { assert, it } from "@effect/vitest";
import { IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as IssueTrackerBindings from "../IssueTrackerBindings.ts";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "103_IssueTrackerAdditionalScopes",
  (it) => {
    it.effect("keeps a one-team binding and saves and replaces extra teams", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 102 });
        yield* sql`INSERT INTO issue_tracker_bindings VALUES ('web', 'linear', 'ENG', '2026-11-21')`;
        yield* runMigrations();
        const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository.pipe(
          Effect.provide(IssueTrackerBindings.layer),
        );
        const projectId = ProjectId.make("web");
        const binding = { tracker: IssueTrackerKind.make("linear"), scope: "ENG" };
        const read = () => bindings.list(projectId).pipe(Effect.map((rows) => rows.get(projectId)));
        assert.deepStrictEqual(yield* read(), binding);
        const multi = { ...binding, additionalScopes: ["OPS", "DOCS"] };
        yield* bindings.set({ projectId, binding: multi, updatedAt: "2026-11-21" });
        assert.deepStrictEqual(yield* read(), multi);
        yield* bindings.set({ projectId, binding, updatedAt: "2026-11-21" });
        assert.deepStrictEqual(yield* read(), binding);
        yield* sql`
          INSERT INTO issue_tracker_bindings (project_id, tracker, scope, updated_at, additional_scopes)
          VALUES ('other', 'linear', 'OPS', '2026-11-21', 'invalid')
        `;
        assert.deepStrictEqual(yield* read(), binding);
        assert.strictEqual((yield* Effect.result(bindings.list()))._tag, "Failure");
      }),
    );
  },
);
