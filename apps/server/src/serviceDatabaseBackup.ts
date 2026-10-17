// @effect-diagnostics nodeBuiltinImport:off -- The standalone launcher uses Node built-ins only.
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

function openWalReader(databasePath: string) {
  let source: NodeSqlite.DatabaseSync | undefined;
  try {
    source = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    source.exec("PRAGMA busy_timeout = 5000; BEGIN");
    source.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    if (source.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") return source;
  } catch {
    // Fall back to the stopped copy.
  }
  source?.close();
  return undefined;
}

/**
 * Pin WAL frames with a read transaction until shutdown, then overlay the final
 * WAL on the online snapshot so rollback keeps writes made during the copy.
 */
export async function prepareServiceDatabaseBackup(databasePath: string, stagingDir: string) {
  const source = openWalReader(databasePath);
  if (source === undefined) return undefined;
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    const destination = NodePath.join(stagingDir, "database");
    await NodeSqlite.backup(source, destination, { rate: 256 });
    // Enable WAL before installing it; do not open the destination again before restore.
    const snapshot = new NodeSqlite.DatabaseSync(destination);
    try {
      snapshot.exec("PRAGMA journal_mode = WAL");
    } finally {
      snapshot.close();
    }
    const file = await NodeFSP.open(destination, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    return {
      async finish() {
        try {
          await NodeFSP.copyFile(`${databasePath}-wal`, NodePath.join(stagingDir, "database-wal"));
          const wal = await NodeFSP.open(NodePath.join(stagingDir, "database-wal"), "r+");
          try {
            await wal.sync();
          } finally {
            await wal.close();
          }
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        }
      },
      close() {
        source.close();
      },
    };
  } catch (cause) {
    source.close();
    await NodeFSP.rm(stagingDir, { recursive: true, force: true });
    throw cause;
  }
}
