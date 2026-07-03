import type { PluginId } from "@t3tools/contracts/plugin";
import type { PluginMigration } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export class PluginMigrationDowngradeError extends Schema.TaggedErrorClass<PluginMigrationDowngradeError>()(
  "PluginMigrationDowngradeError",
  {
    pluginId: Schema.String,
    recordedHead: Schema.Number,
    providedHead: Schema.Number,
  },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} has migration head ${this.recordedHead}, but only migrations through ${this.providedHead} were provided.`;
  }
}

export class PluginMigrationViolation extends Schema.TaggedErrorClass<PluginMigrationViolation>()(
  "PluginMigrationViolation",
  {
    pluginId: Schema.String,
    version: Schema.Number,
    objectName: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} migration ${this.version} violated database namespace rules for ${this.objectName}: ${this.detail}`;
  }
}

export class PluginMigrationOrderError extends Schema.TaggedErrorClass<PluginMigrationOrderError>()(
  "PluginMigrationOrderError",
  { pluginId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} migration list is invalid: ${this.detail}`;
  }
}

export class PluginMigrationExecutionError extends Schema.TaggedErrorClass<PluginMigrationExecutionError>()(
  "PluginMigrationExecutionError",
  {
    pluginId: Schema.String,
    version: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} migration ${this.version} failed.`;
  }
}

export type PluginMigratorError =
  | PluginMigrationDowngradeError
  | PluginMigrationViolation
  | PluginMigrationOrderError
  | PluginMigrationExecutionError
  | SqlError;

interface SqliteMasterObject {
  readonly name: string;
  readonly type: string;
  readonly sql: string | null;
}

export class PluginMigrator extends Context.Service<
  PluginMigrator,
  {
    readonly run: (
      pluginId: PluginId,
      migrations: ReadonlyArray<PluginMigration>,
    ) => Effect.Effect<void, PluginMigratorError>;
  }
>()("t3/plugins/PluginMigrator") {}

// The DB namespace a plugin's migrations are confined to. Exported so the
// installer's id-collision guard checks the SAME prefix the gate enforces.
export const pluginSqlPrefix = (pluginId: string) => `p_${pluginId.replaceAll("-", "_")}_`;

const sqliteMasterSnapshot = (sql: SqlClient.SqlClient) =>
  sql<SqliteMasterObject>`
    SELECT name, type, sql
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `;

const objectKey = (entry: SqliteMasterObject) => `${entry.type}:${entry.name}`;

const changedObjects = (
  before: ReadonlyArray<SqliteMasterObject>,
  after: ReadonlyArray<SqliteMasterObject>,
) => {
  const beforeByKey = new Map(before.map((entry) => [objectKey(entry), entry]));
  return after.filter((entry) => beforeByKey.get(objectKey(entry))?.sql !== entry.sql);
};

const removedObjects = (
  before: ReadonlyArray<SqliteMasterObject>,
  after: ReadonlyArray<SqliteMasterObject>,
) => {
  const afterKeys = new Set(after.map(objectKey));
  return before.filter((entry) => !afterKeys.has(objectKey(entry)));
};

const validateMigrationObjects = (input: {
  readonly pluginId: PluginId;
  readonly version: number;
  readonly prefix: string;
  readonly before: ReadonlyArray<SqliteMasterObject>;
  readonly after: ReadonlyArray<SqliteMasterObject>;
}) =>
  Effect.gen(function* () {
    const preMigrationCoreTables = input.before
      .filter((entry) => entry.type === "table" && !entry.name.startsWith(input.prefix))
      .map((entry) => entry.name);

    // Dropping (or renaming away) an object the plugin does not own is a
    // violation: a dropped object never appears in the after-snapshot, so it
    // must be detected from the before side.
    for (const entry of removedObjects(input.before, input.after)) {
      if (!entry.name.startsWith(input.prefix)) {
        return yield* new PluginMigrationViolation({
          pluginId: input.pluginId,
          version: input.version,
          objectName: entry.name,
          detail: "migration removed an object outside the plugin namespace",
        });
      }
    }

    for (const entry of changedObjects(input.before, input.after)) {
      if (!entry.name.startsWith(input.prefix)) {
        return yield* new PluginMigrationViolation({
          pluginId: input.pluginId,
          version: input.version,
          objectName: entry.name,
          detail: `object name must start with ${input.prefix}`,
        });
      }
      if (entry.type !== "trigger" && entry.type !== "view") continue;
      const body = entry.sql ?? "";
      for (const tableName of preMigrationCoreTables) {
        if (
          new RegExp(`\\b${tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body)
        ) {
          return yield* new PluginMigrationViolation({
            pluginId: input.pluginId,
            version: input.version,
            objectName: entry.name,
            detail: `trigger/view body references core table ${tableName}`,
          });
        }
      }
    }
  });

const validateMigrationList = (pluginId: PluginId, migrations: ReadonlyArray<PluginMigration>) =>
  Effect.gen(function* () {
    const versions = new Set<number>();
    for (const migration of migrations) {
      if (!Number.isInteger(migration.version) || migration.version <= 0) {
        return yield* new PluginMigrationOrderError({
          pluginId,
          detail: `version ${migration.version} must be a positive integer`,
        });
      }
      if (versions.has(migration.version)) {
        return yield* new PluginMigrationOrderError({
          pluginId,
          detail: `duplicate version ${migration.version}`,
        });
      }
      versions.add(migration.version);
    }
  });

export const make = Effect.fn("PluginMigrator.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const run: PluginMigrator["Service"]["run"] = (pluginId, migrations) =>
    Effect.gen(function* () {
      // No migrations means nothing to run — not a downgrade (a plugin may
      // legitimately ship no migrations even after earlier versions did).
      if (migrations.length === 0) return;
      yield* validateMigrationList(pluginId, migrations);
      const sorted = Array.from(migrations).sort((left, right) => left.version - right.version);
      const providedHead = sorted.at(-1)?.version ?? 0;
      const rows = yield* sql<{ readonly version: number | null }>`
        SELECT MAX(version) AS version
        FROM plugin_migrations
        WHERE plugin_id = ${pluginId}
      `;
      const recordedHead = rows[0]?.version ?? 0;
      if (recordedHead > providedHead) {
        return yield* new PluginMigrationDowngradeError({
          pluginId,
          recordedHead,
          providedHead,
        });
      }

      const prefix = pluginSqlPrefix(pluginId);
      for (const migration of sorted) {
        if (migration.version <= recordedHead) continue;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const before = yield* sqliteMasterSnapshot(sql);
            const tempBefore = yield* sql<{ readonly name: string }>`
              SELECT name FROM sqlite_temp_master
            `.pipe(Effect.orElseSucceed(() => []));
            yield* migration.up.pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.mapError(
                (cause) =>
                  new PluginMigrationExecutionError({
                    pluginId,
                    version: migration.version,
                    cause,
                  }),
              ),
            );
            const after = yield* sqliteMasterSnapshot(sql);
            // ATTACH and TEMP objects live outside the main sqlite_master
            // snapshot, so the diff gate cannot see them — forbid them
            // outright rather than pretend they are covered.
            // database_list always reports "main" (and "temp" once the temp
            // schema exists); anything else is an ATTACHed database.
            const databases = yield* sql<{ readonly name: string }>`PRAGMA database_list`;
            const attached = databases.find(
              (database) => database.name !== "main" && database.name !== "temp",
            );
            if (attached) {
              // Best-effort DETACH so a rogue attach cannot persist on the
              // shared connection past this violation.
              yield* sql
                .unsafe(`DETACH DATABASE "${attached.name.replaceAll('"', '""')}"`)
                .unprepared.pipe(Effect.ignore);
              return yield* new PluginMigrationViolation({
                pluginId,
                version: migration.version,
                objectName: attached.name,
                detail: "ATTACH DATABASE is not permitted in plugin migrations",
              });
            }
            const tempAfter = yield* sql<{ readonly name: string }>`
              SELECT name FROM sqlite_temp_master
            `.pipe(Effect.orElseSucceed(() => []));
            const tempBeforeNames = new Set(tempBefore.map((row) => row.name));
            const newTempObject = tempAfter.find((row) => !tempBeforeNames.has(row.name));
            if (newTempObject) {
              return yield* new PluginMigrationViolation({
                pluginId,
                version: migration.version,
                objectName: newTempObject.name,
                detail: "TEMP objects are not permitted in plugin migrations",
              });
            }
            yield* validateMigrationObjects({
              pluginId,
              version: migration.version,
              prefix,
              before,
              after,
            });
            yield* sql`
              INSERT INTO plugin_migrations (plugin_id, version, name, applied_at)
              VALUES (
                ${pluginId},
                ${migration.version},
                ${migration.name},
                ${DateTime.formatIso(yield* DateTime.now)}
              )
            `;
          }),
        );
      }
    });

  return PluginMigrator.of({ run });
});

export const layer = Layer.effect(PluginMigrator, make());
