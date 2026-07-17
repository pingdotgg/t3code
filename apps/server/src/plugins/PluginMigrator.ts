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
  /** For an index or trigger: the table it is anchored to. */
  readonly tbl_name: string;
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
    SELECT name, type, tbl_name, sql
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
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

// Strip single-quoted string literals ('...', with '' as an escaped quote) and
// comments (-- to end of line, /* */ block) from a SQL body so the core-table
// word-scan below only sees real identifiers, not table names mentioned inside a
// RAISE message or a `-- mirrors the users feed` comment. Quoted IDENTIFIERS —
// double-quoted "...", square-bracket [...], and backtick `...` — CAN be genuine
// table references, so they are copied through intact; a stray `'` inside one
// (e.g. `[owner's data]`) must not flip string-literal state and truncate the
// rest of the body. Deliberately a dumb single-pass lexer, not a SQL parser:
// unterminated literals/comments are consumed to the end of the body.
const stripSqlLiteralsAndComments = (sql: string): string => {
  let out = "";
  let index = 0;
  const length = sql.length;

  const copyQuotedIdentifier = (open: string, close: string, escapeDoubled: boolean) => {
    out += open;
    index++;
    while (index < length) {
      out += sql[index];
      if (sql[index] === close) {
        if (escapeDoubled && sql[index + 1] === close) {
          out += sql[index + 1];
          index += 2;
          continue;
        }
        index++;
        break;
      }
      index++;
    }
  };

  while (index < length) {
    const char = sql[index];
    if (char === "'") {
      index++;
      while (index < length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      out += " ";
      continue;
    }
    if (char === '"') {
      copyQuotedIdentifier('"', '"', true);
      continue;
    }
    if (char === "[") {
      // SQL Server / SQLite bracket identifiers: `]` ends; `]]` is an escaped `]`.
      copyQuotedIdentifier("[", "]", true);
      continue;
    }
    if (char === "`") {
      // MySQL-style backtick identifiers; doubled `` is the escape form.
      copyQuotedIdentifier("`", "`", true);
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < length && sql[index] !== "\n") index++;
      out += " ";
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < length && !(sql[index] === "*" && sql[index + 1] === "/")) index++;
      index += 2;
      out += " ";
      continue;
    }
    out += char;
    index++;
  }
  return out;
};

// This gate is SCHEMA-OBJECT confinement, not a data-mutation sandbox. It only
// diffs sqlite_master, so it constrains which tables/indexes/triggers/views a
// migration may create, alter, or drop (to the plugin's `p_<id>_*` namespace) —
// it deliberately does NOT restrict INSERT/UPDATE/DELETE against core tables.
// Plugins run in-process under a full-trust model (they can reach the SqlClient
// and much else directly), so the prefix rule is a well-behaved-plugin
// convention that keeps schemas from colliding, not a security boundary against
// a malicious plugin. Do not mistake it for one.
//
// Because the diff compares schema DEFINITIONS and not row data, it likewise
// does NOT detect data destruction: a migration that does
// `DROP TABLE core_table; CREATE TABLE core_table (...)` with the identical SQL
// leaves an unchanged sqlite_master entry (no removed object, no changed `sql`)
// and passes, even though every row was deleted in between. This is consistent
// with the model above — a plugin can already `DELETE FROM core_table` through
// the SqlClient directly — so callers must NOT assume core data is protected
// merely because a migration was accepted here.
const validateMigrationObjects = (input: {
  readonly pluginId: PluginId;
  readonly version: number;
  readonly prefix: string;
  readonly before: ReadonlyArray<SqliteMasterObject>;
  readonly after: ReadonlyArray<SqliteMasterObject>;
}) =>
  Effect.gen(function* () {
    // Include core VIEWS, not just tables: a plugin trigger/view that references
    // a pre-existing core view can reach core tables through that view's
    // `INSTEAD OF` trigger, so a view name in a plugin body is as dangerous as a
    // table name and must be forbidden the same way.
    const preMigrationCoreObjects = input.before
      .filter(
        (entry) =>
          (entry.type === "table" || entry.type === "view") && !entry.name.startsWith(input.prefix),
      )
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
      // An index or trigger is ANCHORED to a table (sqlite_master.tbl_name), and
      // the anchor is where the damage happens: a plugin-prefixed
      // `CREATE UNIQUE INDEX p_<id>_x ON core_table(...)` passed the name check and
      // then `continue`d straight past everything else — altering a core table's
      // constraints while the migration recorded as successful. The anchor check is
      // structural, so it does not depend on parsing the SQL body.
      if (
        (entry.type === "index" || entry.type === "trigger") &&
        !entry.tbl_name.startsWith(input.prefix)
      ) {
        return yield* new PluginMigrationViolation({
          pluginId: input.pluginId,
          version: input.version,
          objectName: entry.name,
          detail: `${entry.type} is anchored to ${entry.tbl_name}, outside the plugin namespace`,
        });
      }
      if (entry.type !== "trigger" && entry.type !== "view") continue;
      const body = stripSqlLiteralsAndComments(entry.sql ?? "");
      for (const objectName of preMigrationCoreObjects) {
        if (
          new RegExp(`\\b${objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body)
        ) {
          return yield* new PluginMigrationViolation({
            pluginId: input.pluginId,
            version: input.version,
            objectName: entry.name,
            detail: `trigger/view body references core object ${objectName}`,
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
            const tempBefore = yield* sql<{ readonly name: string; readonly sql: string | null }>`
              SELECT name, sql FROM sqlite_temp_master
            `.pipe(Effect.orElseSucceed(() => []));
            // Snapshot attachments BEFORE the migration so pre-existing ATTACHes
            // on this shared SqlClient are not treated as migration violations
            // (and must never be DETACHed — that would break other code on the
            // connection). Only names ADDED (or pre-existing ones REMOVED) by
            // the migration are violations.
            const databasesBefore = yield* sql<{ readonly name: string }>`PRAGMA database_list`;
            const attachedBefore = new Set(
              databasesBefore
                .filter((database) => database.name !== "main" && database.name !== "temp")
                .map((database) => database.name),
            );
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
            const databasesAfter = yield* sql<{ readonly name: string }>`PRAGMA database_list`;
            const attachedAfter = databasesAfter.filter(
              (database) => database.name !== "main" && database.name !== "temp",
            );
            const attachedAfterNames = new Set(attachedAfter.map((database) => database.name));
            const newlyAttached = attachedAfter.filter(
              (database) => !attachedBefore.has(database.name),
            );
            const removedPreExisting = [...attachedBefore].filter(
              (name) => !attachedAfterNames.has(name),
            );
            if (newlyAttached.length > 0 || removedPreExisting.length > 0) {
              // Best-effort DETACH of only what THIS migration attached — never
              // touch pre-existing attachments that other code may rely on.
              yield* Effect.forEach(newlyAttached, (database) =>
                sql
                  .unsafe(`DETACH DATABASE "${database.name.replaceAll('"', '""')}"`)
                  .unprepared.pipe(Effect.ignore),
              );
              const objectName = newlyAttached[0]?.name ?? removedPreExisting[0] ?? "unknown";
              return yield* new PluginMigrationViolation({
                pluginId,
                version: migration.version,
                objectName,
                detail:
                  newlyAttached.length > 0
                    ? "ATTACH DATABASE is not permitted in plugin migrations"
                    : "DETACH DATABASE of a pre-existing attachment is not permitted in plugin migrations",
              });
            }
            const tempAfter = yield* sql<{ readonly name: string; readonly sql: string | null }>`
              SELECT name, sql FROM sqlite_temp_master
            `.pipe(Effect.orElseSucceed(() => []));
            // The TEMP schema is connection-scoped and this SqlClient is SHARED, so
            // a migration must not touch it AT ALL — not just refrain from adding.
            // Dropping or altering a pre-existing temp table/index/trigger would
            // silently corrupt temporary state other code on the connection relies
            // on, so reject additions, removals, AND redefinitions alike.
            const tempBeforeByName = new Map(tempBefore.map((row) => [row.name, row.sql]));
            const tempAfterByName = new Map(tempAfter.map((row) => [row.name, row.sql]));
            const changedTempObject =
              tempAfter.find(
                (row) =>
                  !tempBeforeByName.has(row.name) || tempBeforeByName.get(row.name) !== row.sql,
              ) ?? tempBefore.find((row) => !tempAfterByName.has(row.name));
            if (changedTempObject) {
              return yield* new PluginMigrationViolation({
                pluginId,
                version: migration.version,
                objectName: changedTempObject.name,
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
