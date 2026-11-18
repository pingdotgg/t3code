// @effect-diagnostics nodeBuiltinImport:off
// The service launcher shares this and runs without an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const BTRFS_SUPER_MAGIC = 0x9123683e;
const GIB = 1024 ** 3;

async function onBtrfs(target: string): Promise<boolean> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Shared with the standalone launcher.
  if (process.platform !== "linux") return false;
  const stats = await NodeFSP.statfs(target).catch(() => undefined);
  return stats?.type === BTRFS_SUPER_MAGIC;
}

const run = (command: string, args: ReadonlyArray<string>) =>
  new Promise<string | undefined>((resolve) => {
    NodeChildProcess.execFile(command, args, (error, stdout) =>
      resolve(error === null ? stdout : undefined),
    );
  });

/**
 * SQLite rewrites pages in place, which fragments copy-on-write files on btrfs. Files created
 * in a No_COW directory inherit the flag, as systemd-journald does for its journals. Node has no
 * ioctl, so this runs chattr. Btrfs refuses reflinks between No_COW and copy-on-write files.
 */
export async function markNoCopyOnWrite(directory: string): Promise<void> {
  if (await onBtrfs(directory)) await run("chattr", ["+C", directory]);
}

export async function isNoCopyOnWrite(file: string): Promise<boolean> {
  if (!(await onBtrfs(file))) return false;
  // lsattr skips symlinks; its first field is the flag string, e.g. "---------------C------".
  const output = await run("lsattr", ["-d", await NodeFSP.realpath(file).catch(() => file)]);
  return output?.trimStart().split(/\s/, 1)[0]?.includes("C") ?? false;
}

export interface NoCopyOnWriteAttributes {
  readonly supported: (path: string) => Promise<boolean>;
  readonly mark: (path: string) => Promise<void>;
  readonly isMarked: (path: string) => Promise<boolean>;
}

const btrfsAttributes: NoCopyOnWriteAttributes = {
  supported: onBtrfs,
  mark: markNoCopyOnWrite,
  isMarked: isNoCopyOnWrite,
};

const rewritePath = (dbPath: string) =>
  NodePath.join(NodePath.dirname(dbPath), `.${NodePath.basename(dbPath)}.no-cow`);

/**
 * Btrfs sets No_COW only on empty files, so a database created before its folder was marked
 * stays copy-on-write until it is rewritten. The folder is marked only beside a No_COW (or not
 * yet created) database, so the WAL and the update backups clone together with it.
 * Call only while owning the T3 home and before anything opens the database.
 */
export async function needsNoCopyOnWriteRewrite(
  dbPath: string,
  attributes: NoCopyOnWriteAttributes = btrfsAttributes,
): Promise<boolean> {
  const directory = NodePath.dirname(dbPath);
  if (!(await attributes.supported(directory))) return false;
  await NodeFSP.rm(rewritePath(dbPath), { force: true });
  const stats = await NodeFSP.lstat(dbPath).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (stats !== undefined && !stats.isFile()) return false;
  if (stats !== undefined && !(await attributes.isMarked(dbPath))) return true;
  await attributes.mark(directory);
  return false;
}

/**
 * Copies the database into a new No_COW file and renames it over the original. Any failure
 * leaves the original in place. An exclusive lock refuses the rewrite while another process has
 * the database open and holds others off until the rename. `lockedAfterRenameMs` must outlast
 * their busy timeout, so a process that opened the old file meanwhile fails instead of writing to it.
 */
export async function rewriteNoCopyOnWrite(
  dbPath: string,
  lockedAfterRenameMs: number,
  attributes: NoCopyOnWriteAttributes = btrfsAttributes,
): Promise<void> {
  const directory = NodePath.dirname(dbPath);
  const copyPath = rewritePath(dbPath);
  const { size, mode } = await NodeFSP.stat(dbPath);
  const { bavail, bsize } = await NodeFSP.statfs(directory);
  // Btrfs does not compress No_COW files; the margin covers the WAL and the server's next writes.
  if (bavail * bsize < size + GIB) {
    throw new Error(`Not enough free disk space to rewrite the ${size}-byte database.`);
  }
  // The launcher imports this module and treats node:sqlite as optional.
  const NodeSqlite = await import("node:sqlite");
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    // DELETE folds the WAL into the file. Closing in WAL mode would delete the new file's WAL.
    database.exec(`
      PRAGMA busy_timeout = 0;
      PRAGMA locking_mode = EXCLUSIVE;
      BEGIN EXCLUSIVE;
      COMMIT;
      PRAGMA journal_mode = DELETE;
    `);
    await NodeFSP.rm(`${dbPath}-shm`, { force: true });
    await (await NodeFSP.open(copyPath, "wx", mode & 0o777)).close();
    await attributes.mark(copyPath);
    if (!(await attributes.isMarked(copyPath))) throw new Error("chattr +C did not apply.");
    // A child process copies: closing a descriptor this process opens on the database drops its lock.
    // cp writes into the existing No_COW inode; btrfs refuses to reflink it, so the data is copied.
    await new Promise<void>((resolve, reject) =>
      NodeChildProcess.execFile("cp", [dbPath, copyPath], (error) =>
        error === null ? resolve() : reject(error),
      ),
    );
    await syncPath(copyPath, "r+");
    await NodeFSP.rename(copyPath, dbPath);
    await syncPath(directory, "r");
    await NodeTimersPromises.setTimeout(lockedAfterRenameMs);
  } finally {
    database.close();
    await NodeFSP.rm(copyPath, { force: true });
  }
  await attributes.mark(directory);
}

async function syncPath(path: string, flags: "r" | "r+"): Promise<void> {
  const handle = await NodeFSP.open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
