import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "054_ProjectionThreadIssues",
  (it) => {
    it.effect("adds a bounded issue link column with an empty default", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 53 });
        yield* runMigrations({ toMigrationInclusive: 54 });
        const columns = yield* sql<{
          readonly name: string;
          readonly notnull: number;
          readonly dflt_value: string | null;
        }>`PRAGMA table_info(projection_threads)`;
        const column = columns.find((entry) => entry.name === "issue_links_json");
        assert.equal(column?.notnull, 1);
        assert.equal(column?.dflt_value, "'[]'");
      }),
    );
  },
);
