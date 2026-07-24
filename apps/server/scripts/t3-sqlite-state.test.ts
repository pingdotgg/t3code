import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../src/config.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { runSqliteState, type SqliteStateDatabase } from "./t3-sqlite-state.ts";

const createFixtureDatabase = Effect.fn("createSqliteStateFixtureDatabase")(function* (
  baseDir: string,
  database: SqliteStateDatabase = "state",
) {
  const fs = yield* FileSystem.FileSystem;
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
    baseDirIsExplicit: true,
  });
  const databasePath = database === "archive" ? derivedPaths.archiveDbPath : derivedPaths.dbPath;
  yield* fs.makeDirectory(derivedPaths.stateDir, { recursive: true });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE fixtures (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;
    yield* sql`INSERT INTO fixtures (id, label) VALUES (1, ${database})`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
});

it.layer(NodeServices.layer)("t3-sqlite-state", (it) => {
  it.effect("reports each invalid SQL source with a specific error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-input-" });

      const multipleSources = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "SELECT 1",
        file: "fixture.sql",
      }).pipe(Effect.flip);
      assert.equal(multipleSources._tag, "SqliteStateMultipleSqlSourcesError");
      assert.equal(multipleSources.message, "Provide only one of --sql or --file.");

      const missingSource = yield* runSqliteState({ operation: "query", baseDir }).pipe(
        Effect.flip,
      );
      assert.equal(missingSource._tag, "SqliteStateMissingSqlSourceError");
      assert.equal(missingSource.message, "Provide one of --sql or --file.");

      const emptySql = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "   ",
      }).pipe(Effect.flip);
      assert.equal(emptySql._tag, "SqliteStateEmptySqlError");
      assert.equal(emptySql.message, "SQL input is empty.");
    }),
  );

  it.effect("queries an isolated database through Effect SQL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-query-" });
      yield* createFixtureDatabase(baseDir);

      const result = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "SELECT id, label FROM fixtures",
      });

      assert.equal(result.operation, "query");
      if (result.operation === "query") {
        assert.deepStrictEqual(result.rows, [{ id: 1, label: "state" }]);
      }
    }),
  );

  it.effect("selects the cold archive database through shared server paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-archive-query-" });
      yield* createFixtureDatabase(baseDir);
      yield* createFixtureDatabase(baseDir, "archive");

      const result = yield* runSqliteState({
        operation: "query",
        baseDir,
        database: "archive",
        sql: "SELECT id, label FROM fixtures",
      });

      assert.equal(result.database, path.join(baseDir, "userdata", "archive.sqlite"));
      assert.equal(result.operation, "query");
      if (result.operation === "query") {
        assert.deepStrictEqual(result.rows, [{ id: 1, label: "archive" }]);
      }
    }),
  );

  it.effect("backs up isolated state before writes and refuses the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-exec-" });
      yield* createFixtureDatabase(baseDir);

      const mutation = yield* runSqliteState({
        operation: "exec",
        baseDir,
        sql: "INSERT INTO fixtures (id, label) VALUES (2, 'seeded')",
      });
      assert.equal(mutation.operation, "exec");
      if (mutation.operation === "exec") {
        assert.equal((yield* fs.stat(mutation.backup)).mode & 0o777, 0o600);
      }

      const error = yield* runSqliteState(
        {
          operation: "exec",
          baseDir,
          sql: "DELETE FROM fixtures",
        },
        { sharedHome: baseDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "SqliteStateSharedHomeMutationError");

      const aliasParent = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-sqlite-state-alias-",
      });
      const aliasBaseDir = path.join(aliasParent, "shared-home-alias");
      yield* fs.symlink(baseDir, aliasBaseDir);
      const aliasError = yield* runSqliteState(
        {
          operation: "exec",
          baseDir: aliasBaseDir,
          sql: "DELETE FROM fixtures",
        },
        { sharedHome: baseDir },
      ).pipe(Effect.flip);
      assert.equal(aliasError._tag, "SqliteStateSharedHomeMutationError");
    }),
  );
});
