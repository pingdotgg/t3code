import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateSnoozedThroughTurn from "./055_ProjectionThreadsSnoozedThroughTurn.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "055_ProjectionThreadsSnoozedThroughTurn",
  (it) => {
    it.effect("repairs both sides of the fork migration collision", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        yield* runMigrations({ toMigrationInclusive: 55 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        assert.includeMembers(
          columns.map((column) => column.name),
          ["auto_settle_disabled_at", "snoozed_through_turn_id"],
        );

        const viewedTables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'pull_request_files_viewed'
        `;
        assert.deepEqual(viewedTables, [{ name: "pull_request_files_viewed" }]);

        yield* migrateSnoozedThroughTurn;
      }),
    );
  },
);
