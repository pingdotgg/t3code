// @effect-diagnostics nodeBuiltinImport:off - read synchronously by the preflight subprocess and at startup.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { migrationManifest } from "./Migrations.ts";

export const BUILD_MIGRATION_HEAD = Math.max(...migrationManifest.map(([id]) => id));

/** Migrations the database records, read-only. A missing or new database records none; one that
 * exists but cannot be read is null, since its history is unknown. */
export function recordedMigrations(
  databasePath: string,
): ReadonlyArray<{ readonly id: number; readonly name: string }> | null {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return NodeFS.existsSync(databasePath) ? null : [];
  }
  try {
    const hasTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get();
    if (hasTable === undefined) return [];
    return db
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all()
      .map((row) => ({ id: Number(row.migration_id), name: String(row.name) }));
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // A read-only handle has nothing to flush; the result above already stands.
    }
  }
}

/** Highest migration the database holds once this build's startup migrations have run. A newer
 * build may have recorded more than this build knows. Undefined when the database is unreadable. */
export function databaseMigrationHead(databasePath: string): number | undefined {
  const recorded = recordedMigrations(databasePath);
  return recorded === null
    ? undefined
    : Math.max(BUILD_MIGRATION_HEAD, ...recorded.map(({ id }) => id));
}
