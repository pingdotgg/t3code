import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as crypto from "node:crypto";
import { listSqlFiles, splitSqlStatements } from "../SqlFile.ts";
import { detectLayout } from "./Detect.ts";
import { MigrationError, type MigrationRecord } from "./Format.ts";
import { DRIZZLE_DIR_PATTERN, timestampPrefixMillis } from "./Utils.ts";

export {
  DRIZZLE_DIR_PATTERN,
  inlineSqlParams,
  quoteIdentifier,
  sqlLiteral,
  timestampPrefixMillis,
} from "./Utils.ts";

/** Map filesystem failures into the migration error channel. */
export const mapPlatformError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  context: string,
): Effect.Effect<A, MigrationError, R> =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new MigrationError({
          message: `${context}: ${String(cause)}`,
          cause,
        }),
    ),
  );

const sha256 = (content: string) =>
  Effect.sync(() => crypto.createHash("sha256").update(content).digest("hex"));

/**
 * Read a drizzle-v1-layout directory (`{ts}_{name}/migration.sql`) into
 * records keyed the way drizzle keys them: `name` = the directory name,
 * sorted by name (drizzle's own sort), hash = sha256 of `migration.sql`.
 */
export const readDrizzleDirRecords = (dir: string) =>
  mapPlatformError(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const entries = yield* fs.readDirectory(dir);
      const names: string[] = [];
      for (const entry of entries) {
        if (!DRIZZLE_DIR_PATTERN.test(entry)) continue;
        const sqlPath = path.join(dir, entry, "migration.sql");
        if (yield* fs.exists(sqlPath)) names.push(entry);
      }
      names.sort((a, b) => a.localeCompare(b));
      const records: MigrationRecord[] = [];
      for (const name of names) {
        const sql = yield* fs.readFileString(
          path.join(dir, name, "migration.sql"),
        );
        records.push({
          name,
          hash: yield* sha256(sql),
          createdAtMillis: timestampPrefixMillis(name),
          sql,
          statements: splitSqlStatements(sql),
        });
      }
      return records;
    }),
    `Failed to read drizzle migrations from ${dir}`,
  );

/**
 * Read a flat directory of `.sql` files into records keyed by relative file
 * path — the convention wrangler and legacy Alchemy state share. Nested
 * `dir/migration.sql` paths are included (via `listSqlFiles`'s recursive
 * listing) so legacy state written against drizzle-layout dirs keeps
 * resolving.
 */
export const readFlatRecords = (dir: string) =>
  mapPlatformError(
    listSqlFiles(dir).pipe(
      Effect.map((files) =>
        files.map((file): MigrationRecord => ({
          name: file.id,
          hash: file.hash,
          createdAtMillis: timestampPrefixMillis(file.id),
          sql: file.sql,
          statements: splitSqlStatements(file.sql),
        })),
      ),
    ),
    `Failed to read migrations from ${dir}`,
  );

/** Read migration records using the directory's detected layout. */
export const readMigrationRecords = (dir: string) =>
  detectLayout(dir).pipe(
    Effect.flatMap((layout) =>
      layout === "flat" ? readFlatRecords(dir) : readDrizzleDirRecords(dir),
    ),
  );
