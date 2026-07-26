import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ProjectionThreadsAutoReviewPhase", (it) => {
  it.effect("adds nullable auto_review_phase column idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* runMigrations({ toMigrationInclusive: 38 });
      // The PRAGMA-guarded ALTER must be safe to evaluate again on a database
      // that already carries the column.
      yield* runMigrations({ toMigrationInclusive: 38 });

      const columns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(projection_threads)
      `;
      const phaseColumn = columns.find((column) => column.name === "auto_review_phase");
      assert.ok(phaseColumn, "expected auto_review_phase column");
      assert.strictEqual(phaseColumn.notnull, 0);
    }),
  );
});
