import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqlite from "node:sqlite";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

it.layer(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "DatabaseMaintenance",
  (it) => {
    it.effect("releases doctor's SQLite lock before Windows removes the legacy database", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-windows-" });
        const legacy = path.join(directory, "state.sqlite");
        const current = path.join(directory, "statev2.sqlite");
        yield* fs.writeFileString(current, "keep current database");
        yield* Effect.sync(() => {
          using database = new NodeSqlite.DatabaseSync(legacy);
          database.exec("PRAGMA journal_mode = WAL; CREATE TABLE retained_data (value TEXT)");
          database.exec("INSERT INTO retained_data VALUES ('keep')");
        });
        const windowsFs = FileSystem.FileSystem.of({
          ...fs,
          remove: (file, options) =>
            Effect.gen(function* () {
              if (file === legacy) {
                // A real second SQLite connection detects doctor's exclusive lock on any OS.
                // Windows also refuses the unlink while that first connection remains open.
                yield* Effect.try({
                  try: () => {
                    using probe = new NodeSqlite.DatabaseSync(legacy);
                    probe.exec("PRAGMA busy_timeout = 0");
                    assert.deepEqual(probe.prepare("SELECT value FROM retained_data").all(), [
                      { value: "keep" },
                    ]);
                  },
                  catch: (cause) =>
                    new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "Busy",
                        module: "FileSystem",
                        method: "remove",
                        cause,
                      }),
                    ),
                });
              }
              yield* fs.remove(file, options);
            }),
        });
        yield* Effect.flatMap(DatabaseMaintenance.DatabaseMaintenance, (maintenance) =>
          maintenance.removeLegacyDatabase(current),
        ).pipe(
          Effect.provide(
            Layer.fresh(DatabaseMaintenance.layer).pipe(
              Layer.provide(Layer.succeed(FileSystem.FileSystem, windowsFs)),
            ),
          ),
          Effect.provideService(HostProcess.Platform, "win32"),
        );
        assert.isFalse(yield* fs.exists(legacy));
        assert.isFalse(yield* fs.exists(`${legacy}-wal`));
        assert.isFalse(yield* fs.exists(`${legacy}-shm`));
        assert.equal(yield* fs.readFileString(current), "keep current database");
      }).pipe(Effect.scoped),
    );

    it.effect("reports an unreadable database as an inspection failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-" }),
          "statev2.sqlite",
        );
        yield* fs.writeFileString(dbPath, "not a database");
        const failure = yield* Effect.flip(maintenance.inspect(dbPath));
        assert.equal(failure._tag, "DatabaseInspectError");
      }).pipe(Effect.scoped),
    );

    it.effect("preserves the legacy WAL if another Windows opener prevents deletion", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-race-" });
        const legacy = path.join(directory, "state.sqlite");
        const current = path.join(directory, "statev2.sqlite");
        yield* Effect.sync(() => {
          using database = new NodeSqlite.DatabaseSync(legacy);
          database.exec("PRAGMA journal_mode = WAL; CREATE TABLE retained_data (value TEXT)");
        });
        let competingDatabase: NodeSqlite.DatabaseSync | undefined;
        yield* Effect.addFinalizer(() => Effect.sync(() => competingDatabase?.close()));
        const busy = new PlatformError.PlatformError(
          new PlatformError.SystemError({ _tag: "Busy", module: "FileSystem", method: "remove" }),
        );
        const windowsFs = FileSystem.FileSystem.of({
          ...fs,
          remove: (file, options) =>
            file === legacy
              ? Effect.gen(function* () {
                  yield* Effect.sync(() => {
                    competingDatabase = new NodeSqlite.DatabaseSync(legacy);
                    competingDatabase.exec("PRAGMA busy_timeout = 0");
                    competingDatabase.exec("INSERT INTO retained_data VALUES ('committed in WAL')");
                  });
                  return yield* busy;
                })
              : fs.remove(file, options),
        });
        const failure = yield* Effect.flatMap(
          DatabaseMaintenance.DatabaseMaintenance,
          (maintenance) => maintenance.removeLegacyDatabase(current),
        ).pipe(
          Effect.provide(
            Layer.fresh(DatabaseMaintenance.layer).pipe(
              Layer.provide(Layer.succeed(FileSystem.FileSystem, windowsFs)),
            ),
          ),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.flip,
        );
        assert.equal(failure._tag, "LegacyDatabaseRemoveError");
        assert.isTrue(yield* fs.exists(legacy));
        assert.isAbove(Number((yield* fs.stat(`${legacy}-wal`)).size), 0);
        assert.isTrue(yield* fs.exists(`${legacy}-shm`));
        assert.deepEqual(competingDatabase?.prepare("SELECT value FROM retained_data").all(), [
          { value: "committed in WAL" },
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect.each([{ platform: "host" }, { platform: "win32" }] as const)(
      "reports and deletes only the legacy database on $platform",
      ({ platform }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
          const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-" });
          const dbPath = path.join(userdata, "statev2.sqlite");
          const legacy = path.join(userdata, "state.sqlite");
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE retained_data (value TEXT)`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);

          const openLegacy = NodeSqliteClient.layer({ filename: legacy });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA journal_mode = WAL`;
            yield* sql`CREATE TABLE v1_data (value TEXT)`;
          }).pipe(Effect.provide(openLegacy));
          assert.isAbove((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes ?? 0, 0);

          // A version before 0.1.0 still running against it keeps it.
          const refused = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`SELECT value FROM v1_data`;
            return yield* Effect.flip(maintenance.removeLegacyDatabase(dbPath));
          }).pipe(Effect.provide(openLegacy));
          assert.equal(refused._tag, "DatabaseInUseError");
          assert.isTrue(yield* fs.exists(legacy));

          yield* maintenance.removeLegacyDatabase(dbPath);
          assert.isFalse(yield* fs.exists(legacy));
          assert.isFalse(yield* fs.exists(`${legacy}-wal`));
          assert.isFalse(yield* fs.exists(`${legacy}-shm`));
          assert.isTrue(yield* fs.exists(dbPath));
          assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);
        }).pipe(
          (effect) =>
            platform === "host"
              ? effect
              : Effect.provideService(effect, HostProcess.Platform, platform),
          Effect.scoped,
        ),
    );

    it.effect("compacts an existing database offline only once its server has stopped", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compact-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        yield* Effect.flatMap(
          ProjectionMaintenance.ProjectionMaintenanceV2,
          (projections) => projections.rebuild,
        ).pipe(
          Effect.provide(
            ProjectionMaintenance.layer.pipe(
              Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
              Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA auto_vacuum = NONE`;
          yield* sql`VACUUM`;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
          yield* sql`CREATE TABLE discarded_data (value BLOB)`;
          yield* sql`INSERT INTO discarded_data VALUES (zeroblob(4194304))`;
          yield* sql`DROP TABLE discarded_data`;
          yield* sql`
            INSERT INTO orchestration_v2_projection_messages (
              message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
            )
            VALUES (
              'message-1', 'thread-1', NULL, NULL, 'user', 0,
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '{"text":"needle"}'
            )
          `;
          // An index that drifted from its rows, as a renumbering VACUUM would leave it.
          yield* sql`
            INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
            VALUES ('delete-all')
          `;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
          yield* sql`INSERT INTO orchestration_v2_legacy_imports (
            thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count
          ) VALUES ('imported', '2026-10-17', '2026-10-17', '2026-10-17', 0)`;
          yield* sql`WITH RECURSIVE history(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 51
          ) INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
          ) SELECT 'legacy-' || n, 'thread', 'imported', '2026-10-17', 0, 'accepted', 'legacy' FROM history`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        const sizeBefore = (yield* fs.stat(dbPath)).size;
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM retained_data`;
          return yield* maintenance.compact(dbPath).pipe(Effect.flip);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.equal((yield* fs.stat(dbPath)).size, sizeBefore);

        const clock = yield* Clock.Clock;
        const pauses: number[] = [];
        let activeNanos = 0n;
        const result = yield* maintenance.compact(dbPath).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            // Exceed the background budget whenever the compactor checks elapsed time.
            monotonicTimeNanos: Effect.sync(() => (activeNanos += 30_000_000n)),
            sleep: (duration) =>
              Effect.sync(() => {
                pauses.push(Duration.toMillis(duration));
              }),
          }),
        );
        assert.deepEqual(pauses, [], "offline doctor must not throttle compaction");
        assert.equal(result.deletedReceiptCount, 51);
        assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
          assert.deepEqual(
            yield* sql`
              SELECT messages.message_id AS "messageId"
              FROM orchestration_v2_message_search AS search
              INNER JOIN orchestration_v2_projection_messages AS messages
                ON messages.rowid = search.rowid
              WHERE orchestration_v2_message_search MATCH '"needle"'
            `,
            [{ messageId: "message-1" }],
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
      }).pipe(Effect.scoped),
    );
  },
);
