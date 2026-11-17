// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";

import { withDulliOnPi } from "./dulliSettings.ts";

const decodeSettings = Schema.decodeEffect(fromLenientJson(Schema.Unknown));
const encodeSettings = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

// SQLITE_CORRUPT and SQLITE_NOTADB, as Sqlite.ts reports them when it opens the database.
const isDamagedSqlite = (cause: unknown) =>
  Predicate.isObject(cause) &&
  typeof cause.errcode === "number" &&
  [11, 26].includes(cause.errcode & 0xff);

export const backupBeforeDulliUpgrade = Effect.fn("DulliUpgrade.backupBeforeUpgrade")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(dbPath))) return;
  const backupPath = `${dbPath}.before-dulli-upgrade`;
  if (yield* fs.exists(backupPath)) return;
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: path.dirname(dbPath),
    prefix: ".dulli-upgrade-",
  });
  const snapshotPath = path.join(directory, "snapshot.sqlite");
  const backedUp = yield* Effect.tryPromise({
    try: async () => {
      const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        database.exec("BEGIN");
        const tables = new Set(
          database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((row) => row.name),
        );
        if (!tables.has("dulli_sql_migrations") && !tables.has("dulli_fork_migrations"))
          return false;
        if (
          tables.has("dulli_sql_migrations") &&
          database.prepare("SELECT 1 FROM dulli_sql_migrations WHERE migration_id = 5").get()
        )
          return false;
        await NodeSqlite.backup(database, snapshotPath);
        return true;
      } finally {
        database.close();
      }
    },
    catch: (cause) =>
      new Migrator.MigrationError({
        kind: "Failed",
        message:
          "Could not back up the database before moving Dulli threads to Pi; startup will retry.",
        cause,
      }),
  }).pipe(
    // Nothing to back up; opening the database reports the damage and where the file is.
    Effect.catchIf(
      (error) => isDamagedSqlite(error.cause),
      () => Effect.succeed(false),
    ),
  );
  if (!backedUp) return;
  yield* fs.chmod(snapshotPath, 0o600);
  yield* fs.link(snapshotPath, backupPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "AlreadyExists",
      () => Effect.void,
    ),
  );
  yield* Effect.log("Saved database backup before moving Dulli threads to Pi", { backupPath });
}, Effect.scoped);

export const finishDulliUpgrade = Effect.fn("DulliUpgrade.finishUpgrade")(
  function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settingsPath = path.join(path.dirname(dbPath), "settings.json");
    const settingsBackupPath = `${settingsPath}.before-dulli-upgrade`;
    // An old-fork database whose settings were never converted may still rely on the unconfigured
    // default "dulli" instance. After the first conversion the user owns that entry.
    const addDefaultInstance =
      (yield* fs.exists(`${dbPath}.before-dulli-upgrade`)) &&
      !(yield* fs.exists(settingsBackupPath));
    const raw = (yield* fs.exists(settingsPath))
      ? yield* fs.readFileString(settingsPath)
      : undefined;
    if (raw === undefined && !addDefaultInstance) return;
    const parsed =
      raw === undefined ? Option.some<unknown>({}) : yield* decodeSettings(raw).pipe(Effect.option);
    if (parsed._tag === "None") return;
    const movedJson = yield* encodeSettings(withDulliOnPi(parsed.value, { addDefaultInstance }));
    if (movedJson === (yield* encodeSettings(parsed.value))) return;
    yield* fs.writeFileString(settingsBackupPath, raw ?? "{}\n", { flag: "wx", mode: 0o600 }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    );
    yield* writeFileStringAtomically({ filePath: settingsPath, contents: `${movedJson}\n` });
  },
  (effect) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new Migrator.MigrationError({
            kind: "Failed",
            message: "Could not move Dulli settings to Pi; startup will retry the upgrade.",
            cause,
          }),
      ),
    ),
);
