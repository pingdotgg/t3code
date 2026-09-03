import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { snapshotCookieDatabase } from "./CookieDatabase.ts";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("snapshotCookieDatabase", () => {
  it.effect("includes committed WAL data in one consistent database", () =>
    runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cookie-source-",
        });
        const source = path.join(sourceDirectory, "Cookies");
        const snapshot = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`PRAGMA wal_autocheckpoint = 0`;
          yield* sql`CREATE TABLE cookies(name TEXT NOT NULL)`;
          yield* sql`INSERT INTO cookies(name) VALUES (${"committed-in-wal"})`;
          expect(yield* fileSystem.exists(`${source}-wal`)).toBe(true);
          return yield* snapshotCookieDatabase(source);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: source })));
        const rows = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly name: string }>`SELECT name FROM cookies`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshot, readonly: true })));
        expect(rows).toEqual([{ name: "committed-in-wal" }]);
      }),
    ),
  );

  it.effect("propagates snapshot failures and removes its temporary directory", () =>
    runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cookie-invalid-source-",
        });
        const source = path.join(sourceDirectory, "Cookies");
        yield* fileSystem.writeFileString(source, "not a sqlite database");
        const prefix = `t3code-cookie-failed-${process.pid}-`;
        const error = yield* snapshotCookieDatabase(source, prefix).pipe(
          Effect.scoped,
          Effect.flip,
        );
        expect(error._tag).toBe("SqlError");
        const temporaryEntries = yield* fileSystem.readDirectory(path.dirname(sourceDirectory));
        expect(temporaryEntries.some((entry) => entry.startsWith(prefix))).toBe(false);
      }),
    ),
  );

  it.effect("removes a successful snapshot when its scope closes", () =>
    runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-cookie-cleanup-source-",
        });
        const source = path.join(sourceDirectory, "Cookies");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE cookies(name TEXT NOT NULL)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: source })));
        const snapshot = yield* snapshotCookieDatabase(source).pipe(Effect.scoped);
        expect(yield* fileSystem.exists(snapshot)).toBe(false);
      }),
    ),
  );
});
