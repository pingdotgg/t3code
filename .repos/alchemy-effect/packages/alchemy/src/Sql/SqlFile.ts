import crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface SqlFile {
  id: string;
  sql: string;
  hash: string;
}

/**
 * Recursively list `.sql` files under `directory`, sorted by their numeric
 * prefix (e.g. `0001_init.sql`) and then by name.
 */
export const listSqlFiles = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(directory, { recursive: true });

    const sqlFiles = entries
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => {
        const aNum = getPrefix(a);
        const bNum = getPrefix(b);
        if (aNum !== null && bNum !== null) return aNum - bNum;
        if (aNum !== null) return -1;
        if (bNum !== null) return 1;
        return a.localeCompare(b);
      });

    return yield* Effect.all(sqlFiles.map((id) => readSqlFile(directory, id)));
  });

/**
 * Read a single `.sql` file relative to `directory` and compute its content
 * hash. The `sql` field is marked non-enumerable so it isn't serialized into
 * resource state.
 */
export const readSqlFile = (directory: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* fs.readFileString(path.resolve(directory, name));
    const hash = crypto.createHash("sha256").update(sql).digest("hex");
    const file: SqlFile = { id: name, sql, hash };
    Object.defineProperty(file, "sql", { enumerable: false });
    return file;
  });

export const hashMigrations = (migrationsDir: string) =>
  listSqlFiles(migrationsDir).pipe(
    Effect.map((files) => {
      const hashes: Record<string, string> = {};
      for (const file of files) hashes[file.id] = file.hash;
      return hashes;
    }),
  );

export const hashImports = (
  importFiles: ReadonlyArray<string>,
  rootDir: string,
) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = {};
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      hashes[filePath] = file.hash;
    }
    return hashes;
  });

const getPrefix = (name: string): number | null => {
  const prefix = name.split("_")[0];
  const num = Number.parseInt(prefix, 10);
  return Number.isNaN(num) ? null : num;
};
