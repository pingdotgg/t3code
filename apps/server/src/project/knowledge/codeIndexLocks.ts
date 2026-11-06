// @effect-diagnostics nodeBuiltinImport:off - native SQLite lock handles; every call is a bounded synchronous filesystem step, and test processes load this module without the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  INDEX_DIRECTORY,
  PUBLISHED_FILE,
  clearCheckoutSources,
  generationDirectory,
  listGenerations,
  readPublishedGeneration,
} from "./codeIndexLayout.ts";

/**
 * Servers sharing a data directory share a checkout's index, so its builder and readers coordinate
 * through SQLite's file locks (fcntl on POSIX, LockFileEx on Windows) on empty lock databases. The kernel
 * drops those locks when their process exits, however it exits, so a crashed server leaves no
 * record for a PID check to judge, and a recycled PID holds nothing.
 */
const BUILD_LOCK = "build.lock";
// Held alongside the build lock. Only builders touch the build lock, so a query's probe goes here.
const BUILDING_LOCK = "building.lock";
// In each generation: readers hold it shared, and a deleter must take it exclusively.
const READERS_LOCK = "readers.lock";
// Waits out the momentary locks of probes and failed deletion attempts, never a build or a read.
const MOMENTARY_LOCK_WAIT_MS = 1_000;
const isBuildLockFile = (name: string) => name === BUILD_LOCK || name === BUILDING_LOCK;

const SQLITE_BUSY = 5;
const SQLITE_CANTOPEN = 14;
const sqliteCode = (cause: unknown) =>
  cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number"
    ? cause.errcode & 0xff
    : undefined;

const fileIdentity = (path: string) =>
  NodeFS.statSync(path, { bigint: true, throwIfNoEntry: false })?.ino;

/** The connection holding `path`'s exclusive lock, or null while another connection holds a lock. */
function lockExclusive(
  path: string,
  waitMs: number,
  onOpened?: () => void,
): NodeSqlite.DatabaseSync | null {
  const database = new NodeSqlite.DatabaseSync(path);
  try {
    const opened = fileIdentity(path);
    onOpened?.();
    // Defensive SQLite ignores OFF; MEMORY avoids an open journal that Windows cannot delete.
    database.exec(
      `PRAGMA busy_timeout = ${waitMs}; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;`,
    );
    // A removal can delete this file before the lock lands, and a lock on it then excludes nobody.
    if (opened === undefined || fileIdentity(path) !== opened) {
      database.close();
      return null;
    }
    return database;
  } catch (cause) {
    database.close();
    if (sqliteCode(cause) === SQLITE_BUSY) return null;
    throw cause;
  }
}

/**
 * A shared lock on `path`: null while an exclusive holder keeps it, "missing" when the file
 * cannot be opened. A reader creates the file and waits out momentary locks; a probe does neither.
 */
function lockShared(path: string, role: "reader" | "probe") {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(path, { readOnly: role === "probe" });
  } catch (cause) {
    if (sqliteCode(cause) === SQLITE_CANTOPEN) return "missing" as const;
    throw cause;
  }
  try {
    database.exec(
      `PRAGMA busy_timeout = ${role === "reader" ? MOMENTARY_LOCK_WAIT_MS : 0}; BEGIN; SELECT count(*) FROM sqlite_master;`,
    );
    return database;
  } catch (cause) {
    database.close();
    if (sqliteCode(cause) === SQLITE_BUSY) return null;
    throw cause;
  }
}

/** Takes the index root's build lock and returns its release, or null while another builder holds it. */
export function tryLockBuild(
  indexRoot: string,
  onBuildLockOpened?: () => void,
): (() => void) | null {
  const control = NodePath.join(indexRoot, INDEX_DIRECTORY);
  NodeFS.mkdirSync(control, { recursive: true });
  const build = lockExclusive(NodePath.join(control, BUILD_LOCK), 0, onBuildLockOpened);
  if (build === null) return null;
  try {
    const building = lockExclusive(NodePath.join(control, BUILDING_LOCK), MOMENTARY_LOCK_WAIT_MS);
    if (building === null) throw new Error("building-lock-unavailable");
    return () => {
      building.close();
      build.close();
    };
  } catch (cause) {
    build.close();
    throw cause;
  }
}

const closeLock = (lock: ReturnType<typeof lockShared>) => {
  if (lock !== null && lock !== "missing") lock.close();
};

/** Whether any process, this one included, is building the index now. */
export function isBuildRunning(indexRoot: string): boolean {
  try {
    const probe = lockShared(NodePath.join(indexRoot, INDEX_DIRECTORY, BUILDING_LOCK), "probe");
    closeLock(probe);
    return probe === null;
  } catch {
    return false;
  }
}

/**
 * Deletes `generation` unless a reader in any process holds it. Its last reader deletes it
 * instead. Callers ensure no build writes it: the builder holds the build lock, and a reader
 * removes only generations older than the published one.
 */
export function removeGenerationUnlessRead(indexRoot: string, generation: number): void {
  const directory = NodePath.join(indexRoot, generationDirectory(generation));
  let lock: NodeSqlite.DatabaseSync | null;
  try {
    lock = lockExclusive(NodePath.join(directory, READERS_LOCK), 0);
  } catch (cause) {
    if (sqliteCode(cause) === SQLITE_CANTOPEN) return;
    throw cause;
  }
  if (lock === null) return;
  try {
    // Windows cannot delete the open lock file, so it goes after the lock is released.
    for (const entry of NodeFS.readdirSync(directory)) {
      if (entry !== READERS_LOCK) {
        NodeFS.rmSync(NodePath.join(directory, entry), { recursive: true, force: true });
      }
    }
  } finally {
    lock.close();
  }
  NodeFS.rmSync(directory, { recursive: true, force: true });
}

function clearControlFiles(control: string): void {
  for (const name of NodeFS.readdirSync(control)) {
    if (isBuildLockFile(name)) continue;
    NodeFS.rmSync(NodePath.join(control, name), { recursive: true, force: true });
  }
}

/** False while a process holds one open: Windows refuses to delete an open file. */
function removeBuildLockFiles(control: string): boolean {
  try {
    for (const name of [BUILDING_LOCK, BUILD_LOCK]) {
      NodeFS.rmSync(NodePath.join(control, name), { force: true });
    }
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return false;
    throw cause;
  }
}

const removeIfEmpty = (directory: string) => {
  try {
    NodeFS.rmdirSync(directory);
  } catch {
    // What remains is in use or the user's; a later sweep retries.
  }
};

/**
 * Runs `clear` under the build lock, then removes the lock files and their folder. The files go
 * while held where the OS allows it: a later builder gets a new file, and an earlier one that had
 * only opened its file finds it gone. Elsewhere they go on release, which an open file refuses.
 */
function clearUnderBuildLock(root: string, clear: (control: string) => void): void {
  const control = NodePath.join(root, INDEX_DIRECTORY);
  const release = tryLockBuild(root);
  if (release === null) return;
  let removed = false;
  try {
    clear(control);
    removed = removeBuildLockFiles(control);
  } finally {
    release();
  }
  if (!removed) removeBuildLockFiles(control);
  removeIfEmpty(control);
}

/**
 * Removes one index root: the published pointer first, so new readers see "unindexed", then every
 * generation a reader is not pinning, then the checkout's links. A build elsewhere leaves it all
 * for the next sweep.
 *
 * Nothing here may remove recursively from the root: its entries are links into a user's checkout.
 */
export function removeIndexRoot(indexRoot: string): void {
  if (!NodeFS.existsSync(indexRoot)) return;
  clearUnderBuildLock(indexRoot, (control) => {
    NodeFS.rmSync(NodePath.join(control, PUBLISHED_FILE), { force: true });
    for (const generation of listGenerations(indexRoot)) {
      removeGenerationUnlessRead(indexRoot, generation);
    }
    clearCheckoutSources(indexRoot);
    clearControlFiles(control);
  });
  removeIfEmpty(indexRoot);
}

// Files an older T3 left in a checkout when the index lived beside its sources.
const LEGACY_CONTROL_MARKERS = [
  PUBLISHED_FILE,
  BUILD_LOCK,
  BUILDING_LOCK,
  "codegraph.db",
  "t3-index.json",
];
const LEGACY_GENERATION_MARKERS = ["t3-index.json", "codegraph.db"];
// Everything T3 and the SDK wrote to an old index folder; anything else there is the user's.
const LEGACY_INDEX_FILES = [
  ...LEGACY_CONTROL_MARKERS,
  READERS_LOCK,
  ".gitignore",
  "codegraph.db-shm",
  "codegraph.db-wal",
  "codegraph.lock",
  "daemon.pid",
  "rebuild.pid",
  "writer.pid",
];

const isRealDirectory = (path: string): boolean => {
  try {
    return NodeFS.lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Legacy lock paths are checkout-controlled, so none may follow a link or share an outside inode. */
function isT3Directory(
  path: string,
  names: ReadonlyArray<string>,
  allowed?: ReadonlyArray<string>,
): boolean {
  if (!isRealDirectory(path)) return false;
  try {
    const entries = NodeFS.readdirSync(path);
    return (
      entries.some((name) => names.includes(name)) &&
      (allowed === undefined || entries.every((name) => allowed.includes(name))) &&
      entries.every((name) => {
        const entry = NodeFS.lstatSync(NodePath.join(path, name));
        return entry.isDirectory() || (entry.isFile() && entry.nlink === 1);
      })
    );
  } catch {
    return false;
  }
}

/**
 * The folders an older T3 left inside a checkout, when they are provably T3's. Anything else that
 * happens to share a name belongs to the user.
 */
function legacyIndexFolders(
  checkoutPath: string,
): { readonly generations: ReadonlyArray<number> } | null {
  const control = NodePath.join(checkoutPath, INDEX_DIRECTORY);
  let exists: boolean;
  try {
    exists = NodeFS.lstatSync(control, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return null;
  }
  if (exists && !isT3Directory(control, LEGACY_CONTROL_MARKERS)) return null;
  const generations = listGenerations(checkoutPath).filter((generation) =>
    isT3Directory(
      NodePath.join(checkoutPath, generationDirectory(generation)),
      LEGACY_GENERATION_MARKERS,
      LEGACY_INDEX_FILES,
    ),
  );
  return exists || generations.length > 0 ? { generations } : null;
}

/** Whether a checkout still holds the folders an older T3 kept inside it, without throwing. */
export function hasLegacyIndexFiles(checkoutPath: string): boolean {
  try {
    return legacyIndexFolders(checkoutPath) !== null;
  } catch {
    return false;
  }
}

/** Removes the index folders an older T3 left inside a checkout, and nothing else there. */
export function removeLegacyIndexFromCheckout(checkoutPath: string): void {
  const legacy = legacyIndexFolders(checkoutPath);
  if (legacy === null) return;
  // An older server may still be building; it finishes and this runs on a later sweep.
  clearUnderBuildLock(checkoutPath, (control) => {
    NodeFS.rmSync(NodePath.join(control, PUBLISHED_FILE), { force: true });
    for (const generation of legacy.generations) {
      removeGenerationUnlessRead(checkoutPath, generation);
    }
    for (const name of LEGACY_INDEX_FILES) {
      if (!isBuildLockFile(name)) NodeFS.rmSync(NodePath.join(control, name), { force: true });
    }
  });
}

export interface GenerationPin {
  readonly generation: number | null;
  readonly release: () => void;
}

const unpinned = (generation: number | null): GenerationPin => ({
  generation,
  release: () => undefined,
});

/**
 * Holds the published generation for a read until `release`. The pointer is read again once the
 * lock is held: a generation is deleted only after it stops being published, and never published
 * again, so a pin that still finds it published holds a lock its deleter has to wait for.
 */
export function pinPublishedGeneration(indexRoot: string): GenerationPin {
  let generation = readPublishedGeneration(indexRoot);
  while (generation !== null) {
    const name = generationDirectory(generation);
    const lock = lockShared(NodePath.join(indexRoot, name, READERS_LOCK), "reader");
    let current: number | null;
    try {
      current = readPublishedGeneration(indexRoot);
    } catch (cause) {
      closeLock(lock);
      throw cause;
    }
    if (current === generation) {
      // A missing published directory reads as unindexed; there is nothing in it to protect.
      if (lock === "missing") return unpinned(generation);
      if (lock === null) throw new Error("published-generation-locked");
      const pinned = generation;
      return {
        generation: pinned,
        release: () => {
          lock.close();
          retireIfSuperseded(indexRoot, pinned);
        },
      };
    }
    closeLock(lock);
    generation = current;
  }
  return unpinned(null);
}

function retireIfSuperseded(indexRoot: string, generation: number): void {
  try {
    const published = readPublishedGeneration(indexRoot);
    // Builds write only generations newer than the published one.
    if (published !== null && generation < published) {
      removeGenerationUnlessRead(indexRoot, generation);
    }
  } catch {
    // The next build sweeps a generation left behind.
  }
}
