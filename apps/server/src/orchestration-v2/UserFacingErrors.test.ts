import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

describe("userFacingDispatchErrorMessage", () => {
  it.effect("explains a real database open failure through dispatch and persistence wrappers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-database-error-" });
      const cause = yield* Effect.void.pipe(
        Effect.provide(
          NodeSqliteClient.layer({ filename: path.join(directory, "missing", "state.sqlite") }),
        ),
        Effect.flip,
      );
      const message = userFacingDispatchErrorMessage({
        message: "Failed to dispatch orchestration command message.dispatch (command-1).",
        cause: toPersistenceSqlError("OrchestrationEventStore.append:query")(cause),
      });

      assert.include(message, "server could not open a database file (SQLITE_CANTOPEN)");
      assert.include(message, "machine running the server");
      assert.include(message, "free disk space");
      assert.include(message, "data and temporary directories exist and are writable");
      assert.include(message, "then retry");
      assert.notInclude(message, directory);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("explains a full database and allows a retry after capacity is restored", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries (payload BLOB)`;
      yield* sql`PRAGMA max_page_count = 2`;
      const cause = yield* sql`INSERT INTO entries VALUES (zeroblob(16384))`.pipe(Effect.flip);
      const message = userFacingDispatchErrorMessage({ cause });

      assert.include(message, "database or disk is full (SQLITE_FULL)");
      assert.include(message, "Free space on the machine running the server, then retry");
      assert.include(message, "database size limit");

      yield* sql`PRAGMA max_page_count = 100`;
      yield* sql`INSERT INTO entries VALUES (zeroblob(16384))`;
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`;
      assert.equal(rows[0]?.count, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("gives server permission guidance for a real read-only failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries (payload TEXT)`;
      yield* sql`PRAGMA query_only = ON`;
      const cause = yield* sql`INSERT INTO entries VALUES ('private-message')`.pipe(Effect.flip);
      const message = userFacingDispatchErrorMessage(cause);

      assert.include(message, "server database is read-only (SQLITE_READONLY)");
      assert.include(message, "data directory is writable");
      assert.notInclude(message, "private-message");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it("keeps unknown SQL failures contextual without exposing driver text or parameters", () => {
    const cause = Object.assign(new Error("private-query-data"), { errcode: 1 });
    const error = new SqlError({ reason: classifySqliteError(cause) });
    const message = userFacingDispatchErrorMessage({
      cause: toPersistenceSqlError("OrchestrationEventStore.append:query")(error),
    });

    assert.include(message, "server could not complete this database request");
    assert.include(message, "server logs");
    assert.notInclude(message, "private-query-data");
  });
});
