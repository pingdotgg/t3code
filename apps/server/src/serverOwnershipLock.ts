// @effect-diagnostics nodeBuiltinImport:off
// Shared with the standalone service launcher. Keep imports limited to native modules.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Never unlink this file. SQLite releases its OS lock when the holder exits. */
export async function acquireServerOwnershipLock(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true });
  const stateDir = await NodeFSP.realpath(directory);
  const lockPath = NodePath.join(stateDir, "server-owner.sqlite");
  const db = process.versions.bun
    ? new (await import("bun:sqlite")).Database(lockPath)
    : new (await import("node:sqlite")).DatabaseSync(lockPath);
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (cause) {
    db.close();
    throw cause;
  }
  return { stateDir, close: () => db.close() };
}
