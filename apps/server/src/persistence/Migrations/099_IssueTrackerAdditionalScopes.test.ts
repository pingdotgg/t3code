import { assert, it } from "@effect/vitest";
import { IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as IssueTrackerBindings from "../IssueTrackerBindings.ts";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "099_IssueTrackerAdditionalScopes",
  (it) => {
    it.effect(
      "preserves existing bindings and persists, replaces, and removes additional teams",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 98 });
          yield* sql`INSERT INTO issue_tracker_bindings VALUES ('web', 'linear', 'ENG', '2026-11-17')`;
          yield* runMigrations();
          const repository = yield* IssueTrackerBindings.IssueTrackerBindingsRepository.pipe(
            Effect.provide(IssueTrackerBindings.layer),
          );
          const projectId = ProjectId.make("web");
          const binding = { tracker: IssueTrackerKind.make("linear"), scope: "ENG" };
          assert.deepStrictEqual((yield* repository.list).get(projectId), binding);
          yield* repository.set({
            projectId,
            binding: { ...binding, additionalScopes: ["OPS"] },
            updatedAt: "2026-11-17",
          });
          assert.deepStrictEqual((yield* repository.list).get(projectId), {
            ...binding,
            additionalScopes: ["OPS"],
          });
          yield* repository.set({ projectId, binding, updatedAt: "2026-11-17" });
          assert.deepStrictEqual((yield* repository.list).get(projectId), binding);
          yield* repository.set({ projectId, binding: null, updatedAt: "2026-11-17" });
          assert.strictEqual((yield* repository.list).size, 0);
        }),
    );
  },
);
