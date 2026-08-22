// @effect-diagnostics nodeBuiltinImport:off
import type { OpenCode2Settings } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export const OPENCODE2_BACKGROUND_SUBAGENTS_ENV = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS";

const OPENCODE2_AUTH_FILES = ["account.json", "auth-v2.json", "auth.json"] as const;
const fallbackStateRoots = new Map<string, string>();

/**
 * Session/runtime tables pruned from a seeded host DB so we keep credentials
 * without reusing host chat sessions in the managed instance.
 */
const OPENCODE2_SESSION_TABLES = [
  "event",
  "event_sequence",
  "instruction_blob",
  "instruction_entry",
  "instruction_state",
  "message",
  "part",
  "permission",
  "session",
  "session_message",
  "session_pending",
  "session_share",
  "session_v2",
  "todo",
] as const;

/**
 * Self-spawned 2.x servers get an isolated data/state tree so they do not share
 * a live `opencode.db` with a desktop `opencode2 serve --service`. Host auth is
 * bridged in: next-line stores provider credentials in the sqlite `credential`
 * table (not only auth.json), and without that seed only free models appear.
 *
 * When `instanceId` and `environmentIdentity` are provided, the root is stable
 * per T3 environment + provider instance so neither separate servers nor
 * multi-instance configurations share a live sqlite or password dir.
 */
export function openCode2ManagedStateRoot(
  environment: NodeJS.ProcessEnv = process.env,
  instanceId?: string,
  environmentIdentity?: string,
): string {
  const home = environment.HOME?.trim() || NodeOS.homedir();
  const trimmedInstance = instanceId?.trim();
  const trimmedEnvironmentIdentity = environmentIdentity?.trim();
  const identity = [
    home,
    ...(trimmedEnvironmentIdentity === undefined || trimmedEnvironmentIdentity.length === 0
      ? []
      : [NodePath.resolve(trimmedEnvironmentIdentity)]),
    ...(trimmedInstance === undefined || trimmedInstance.length === 0 ? [] : [trimmedInstance]),
  ].join("\0");
  const userKey = NodeCrypto.createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return NodePath.join(
    environment.TMPDIR?.trim() || NodeOS.tmpdir(),
    `t3-opencode2-state-${userKey}`,
  );
}

/** Prior per-user root (home only). Used once when migrating to instance scope. */
function previousPerUserManagedStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return openCode2ManagedStateRoot(environment);
}

function legacyOpenCode2ManagedStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return NodePath.join(environment.TMPDIR?.trim() || NodeOS.tmpdir(), "t3-opencode2-state");
}

export function openCode2HostDataHome(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.XDG_DATA_HOME?.trim() ||
    NodePath.join(environment.HOME?.trim() || NodeOS.homedir(), ".local", "share")
  );
}

function sqlQuoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function currentUserId(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isOwnedDirectory(stat: NodeFS.Stats): boolean {
  if (!stat.isDirectory()) return false;
  const uid = currentUserId();
  return uid === undefined || stat.uid === uid;
}

/**
 * Set 0700 on a directory via fd when POSIX flags are available so a
 * pathname symlink swap between lstat and chmod cannot redirect the mode
 * change. Does not protect later pathname use of the same path.
 */
function setManagedDirectoryMode(path: string): boolean {
  const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = NodeFS.constants;
  const supportsNoFollowDirectory =
    typeof O_DIRECTORY === "number" &&
    typeof O_NOFOLLOW === "number" &&
    typeof NodeFS.fchmodSync === "function" &&
    typeof NodeFS.fstatSync === "function";

  if (!supportsNoFollowDirectory) {
    try {
      NodeFS.chmodSync(path, 0o700);
      return true;
    } catch {
      return false;
    }
  }

  let fd: number | undefined;
  try {
    fd = NodeFS.openSync(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const stat = NodeFS.fstatSync(fd);
    if (!isOwnedDirectory(stat)) return false;
    NodeFS.fchmodSync(fd, 0o700);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        NodeFS.closeSync(fd);
      } catch {
        // Best-effort close.
      }
    }
  }
}

/**
 * Create or validate a directory that T3 writes to. `lstat` is intentional:
 * following a pre-existing symlink here would let a different local process
 * redirect provider credentials outside the managed tree.
 */
function ensureManagedDirectory(path: string): boolean {
  try {
    const existing = NodeFS.lstatSync(path);
    if (!isOwnedDirectory(existing)) return false;
    return setManagedDirectoryMode(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  try {
    NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
    const created = NodeFS.lstatSync(path);
    if (!isOwnedDirectory(created)) return false;
    return setManagedDirectoryMode(path);
  } catch {
    return false;
  }
}

function tryAdoptManagedStateRoot(sourceRoot: string, stateRoot: string): void {
  if (sourceRoot === stateRoot) return;
  if (managedFileState(stateRoot) !== "missing") return;
  let source: NodeFS.Stats;
  try {
    source = NodeFS.lstatSync(sourceRoot);
  } catch {
    return;
  }
  if (!isOwnedDirectory(source)) return;
  try {
    if (!setManagedDirectoryMode(sourceRoot)) return;
    NodeFS.renameSync(sourceRoot, stateRoot);
  } catch {
    // Another provider startup may have adopted or created the target first.
  }
}

function migrateManagedStateRoot(
  stateRoot: string,
  environment: NodeJS.ProcessEnv,
  instanceId?: string,
  environmentIdentity?: string,
): void {
  if (managedFileState(stateRoot) !== "missing") return;

  const home = environment.HOME?.trim() || NodeOS.homedir();
  const trimmedEnvironmentIdentity = environmentIdentity?.trim();
  const canAdoptGlobalRoot =
    trimmedEnvironmentIdentity === undefined ||
    trimmedEnvironmentIdentity.length === 0 ||
    NodePath.resolve(trimmedEnvironmentIdentity) === NodePath.resolve(home, ".t3", "userdata");

  const trimmedInstance = instanceId?.trim();
  if (canAdoptGlobalRoot && trimmedInstance !== undefined && trimmedInstance.length > 0) {
    if (trimmedEnvironmentIdentity !== undefined && trimmedEnvironmentIdentity.length > 0) {
      // Adopt the pre-environment-identity instance root only for the default
      // T3 home. A worktree or custom server must never steal live native
      // sessions from the user's primary environment.
      tryAdoptManagedStateRoot(openCode2ManagedStateRoot(environment, instanceId), stateRoot);
      if (managedFileState(stateRoot) !== "missing") return;
    }
    // Adopt the previous per-user root once so existing native sessions survive
    // the move to instance-scoped layout. Later instances seed isolated roots.
    tryAdoptManagedStateRoot(previousPerUserManagedStateRoot(environment), stateRoot);
    if (managedFileState(stateRoot) !== "missing") return;
  }

  // Still-older unkeyed legacy root.
  if (canAdoptGlobalRoot) {
    tryAdoptManagedStateRoot(legacyOpenCode2ManagedStateRoot(environment), stateRoot);
  }
}

function prepareManagedStateRoot(stateRoot: string):
  | {
      readonly dataHome: string;
      readonly stateHome: string;
    }
  | undefined {
  if (!ensureManagedDirectory(stateRoot)) return undefined;
  const stateHome = NodePath.join(stateRoot, "state");
  const dataHome = NodePath.join(stateRoot, "data");
  if (!ensureManagedDirectory(stateHome) || !ensureManagedDirectory(dataHome)) return undefined;
  return { dataHome, stateHome };
}

function fallbackManagedStateRoot(
  stateRoot: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const existing = fallbackStateRoots.get(stateRoot);
  if (existing !== undefined && prepareManagedStateRoot(existing) !== undefined) return existing;
  const temporaryRoot = environment.TMPDIR?.trim() || NodeOS.tmpdir();
  const fallbackKey = NodeCrypto.createHash("sha256").update(stateRoot).digest("hex").slice(0, 12);
  const persistentFallback = NodePath.join(
    temporaryRoot,
    `t3-opencode2-state-fallback-${fallbackKey}`,
  );
  if (prepareManagedStateRoot(persistentFallback) !== undefined) {
    fallbackStateRoots.set(stateRoot, persistentFallback);
    return persistentFallback;
  }
  try {
    const fallback = NodeFS.mkdtempSync(
      NodePath.join(temporaryRoot, "t3-opencode2-state-fallback-random-"),
    );
    if (prepareManagedStateRoot(fallback) === undefined) return undefined;
    fallbackStateRoots.set(stateRoot, fallback);
    return fallback;
  } catch {
    return undefined;
  }
}

type ManagedFileState = "missing" | "safe" | "unsafe";

function setManagedFileMode(path: string): boolean {
  const { O_NOFOLLOW, O_RDONLY } = NodeFS.constants;
  const supportsNoFollowFile =
    typeof O_NOFOLLOW === "number" &&
    typeof NodeFS.fchmodSync === "function" &&
    typeof NodeFS.fstatSync === "function";

  if (!supportsNoFollowFile) {
    try {
      NodeFS.chmodSync(path, 0o600);
      return true;
    } catch {
      return false;
    }
  }

  let fd: number | undefined;
  try {
    fd = NodeFS.openSync(path, O_RDONLY | O_NOFOLLOW);
    const stat = NodeFS.fstatSync(fd);
    const uid = currentUserId();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return false;
    NodeFS.fchmodSync(fd, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        NodeFS.closeSync(fd);
      } catch {
        // Best-effort close.
      }
    }
  }
}

function managedFileState(path: string): ManagedFileState {
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
  const uid = currentUserId();
  if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return "unsafe";
  return setManagedFileMode(path) ? "safe" : "unsafe";
}

function copyManagedFile(source: string, target: string): void {
  if (managedFileState(target) === "unsafe") return;
  const temporary = `${target}.${process.pid}.${NodeCrypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    // COPYFILE_EXCL prevents a pre-created temporary symlink from redirecting
    // copyFileSync before the atomic rename replaces the destination.
    NodeFS.copyFileSync(source, temporary, NodeFS.constants.COPYFILE_EXCL);
    NodeFS.chmodSync(temporary, 0o600);
    NodeFS.renameSync(temporary, target);
  } finally {
    try {
      NodeFS.unlinkSync(temporary);
    } catch {
      // The rename normally removed it.
    }
  }
}

function unlinkQuietly(path: string): void {
  try {
    NodeFS.unlinkSync(path);
  } catch {
    // Best-effort cleanup.
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const MANAGED_DATABASE_TEMP_SUFFIXES = ["", "-journal", "-shm", "-wal"] as const;

function cleanupManagedDatabaseTemp(temporary: string): void {
  for (const suffix of MANAGED_DATABASE_TEMP_SUFFIXES) {
    unlinkQuietly(`${temporary}${suffix}`);
  }
}

function cleanupStaleManagedDatabaseTemps(managedOpenCode: string): void {
  let names: ReadonlyArray<string>;
  try {
    names = NodeFS.readdirSync(managedOpenCode);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^opencode\.db\.(\d+)\.[0-9a-f]{16}\.tmp(?:-(?:journal|shm|wal))?$/.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || processExists(pid)) continue;
    const path = NodePath.join(managedOpenCode, name);
    if (managedFileState(path) === "safe") unlinkQuietly(path);
  }
}

/**
 * Publish a fully prepared temporary managed database without overwriting an
 * existing valid final path. A leftover temp must never count as initialized.
 */
function publishManagedDatabase(temporary: string, managedDb: string): boolean {
  const lockPath = `${managedDb}.publish.lock`;
  let lock: NodeSqlite.DatabaseSync | undefined;
  try {
    lock = new NodeSqlite.DatabaseSync(lockPath);
    NodeFS.chmodSync(lockPath, 0o600);
    lock.exec("PRAGMA busy_timeout = 30000; BEGIN EXCLUSIVE");
  } catch {
    lock?.close();
    return false;
  }
  const publicationLock = lock;
  try {
    const finalState = managedFileState(managedDb);
    if (finalState !== "missing") return false;
    try {
      // Hard-link is atomic and fails with EEXIST when the final path is taken.
      NodeFS.linkSync(temporary, managedDb);
      unlinkQuietly(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      // The exclusive sibling lock serializes this module's publishers, so a
      // same-directory rename is a portable atomic fallback on filesystems
      // that do not support hard links.
      if (managedFileState(managedDb) !== "missing") return false;
      NodeFS.renameSync(temporary, managedDb);
    }
    return managedFileState(managedDb) === "safe";
  } finally {
    try {
      publicationLock.exec("COMMIT");
    } catch {
      try {
        publicationLock.exec("ROLLBACK");
      } catch {
        // Preserve the publication result or failure.
      }
    } finally {
      publicationLock.close();
    }
  }
}

function pruneManagedDatabaseSessions(dbPath: string): void {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    const existingTables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          readonly name: string;
        }>
      ).map((row) => row.name),
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of OPENCODE2_SESSION_TABLES) {
        if (!existingTables.has(table)) continue;
        db.exec(`DELETE FROM ${table}`);
      }
      for (const table of OPENCODE2_SESSION_TABLES) {
        if (!existingTables.has(table)) continue;
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
          | { readonly count: number | bigint }
          | undefined;
        if (Number(row?.count ?? -1) !== 0) {
          throw new Error(`OpenCode 2 session table was not fully pruned: ${table}`);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original pruning failure.
      }
      throw error;
    }
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  try {
    NodeFS.chmodSync(dbPath, 0o600);
  } catch {
    // Best-effort privacy mode.
  }
}

/**
 * Copy host auth files and seed a private DB copy that retains credentials but
 * drops host sessions. Safe to call repeatedly: existing managed DB is kept.
 * Auth files that disappear and an existing host DB's empty credential table
 * revoke authority for the isolated instance too.
 *
 * @internal exported for tests
 */
export function seedOpenCode2ManagedDataHome(
  managedDataHome: string,
  hostDataHome: string = openCode2HostDataHome(),
): void {
  const hostOpenCode = NodePath.join(hostDataHome, "opencode");
  const managedOpenCode = NodePath.join(managedDataHome, "opencode");
  if (!ensureManagedDirectory(managedDataHome) || !ensureManagedDirectory(managedOpenCode)) {
    return;
  }
  cleanupStaleManagedDatabaseTemps(managedOpenCode);

  for (const name of OPENCODE2_AUTH_FILES) {
    const source = NodePath.join(hostOpenCode, name);
    const target = NodePath.join(managedOpenCode, name);
    if (!NodeFS.existsSync(source)) {
      try {
        if (managedFileState(target) === "safe") NodeFS.unlinkSync(target);
      } catch {
        // Best-effort revoke: a locked managed auth file should not block spawn.
      }
      continue;
    }
    try {
      copyManagedFile(source, target);
    } catch {
      // Best-effort: a locked or unreadable host auth file should not block spawn.
    }
  }

  const hostDb = NodePath.join(hostOpenCode, "opencode.db");
  const managedDb = NodePath.join(managedOpenCode, "opencode.db");
  const managedState = managedFileState(managedDb);
  if (managedState === "unsafe") return;
  // A missing host database can be transient during an upgrade or migration.
  // Preserve the last known credential snapshot; an existing, readable host DB
  // with an empty credential table remains the authoritative logout signal.
  if (!NodeFS.existsSync(hostDb)) return;

  try {
    if (managedState === "missing") {
      // First managed spawn: build, prune, and chmod a unique sibling temporary
      // DB, then atomically publish it. An interrupted process must never leave
      // an unpruned host chat snapshot at the final path.
      const temporary = `${managedDb}.${process.pid}.${NodeCrypto.randomBytes(8).toString("hex")}.tmp`;
      try {
        const hostSnapshot = new NodeSqlite.DatabaseSync(hostDb, { readOnly: true });
        try {
          hostSnapshot.exec(`VACUUM INTO ${sqlQuoteLiteral(temporary)}`);
        } finally {
          hostSnapshot.close();
        }
        if (managedFileState(temporary) !== "safe") {
          unlinkQuietly(temporary);
          return;
        }
        pruneManagedDatabaseSessions(temporary);
        if (managedFileState(temporary) !== "safe") {
          unlinkQuietly(temporary);
          return;
        }
        publishManagedDatabase(temporary, managedDb);
      } finally {
        cleanupManagedDatabaseTemp(temporary);
      }
      return;
    }

    // Subsequent spawns: refresh credential rows from the host DB so new API
    // keys / oauth tokens land without wiping managed sessions. Empty host
    // rows clear managed credentials so host logout revokes them.
    const host = new NodeSqlite.DatabaseSync(hostDb, { readOnly: true });
    const managed = new NodeSqlite.DatabaseSync(managedDb);
    try {
      const rows = host.prepare("SELECT * FROM credential").all() as Array<
        Record<string, NodeSqlite.SQLInputValue>
      >;
      const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
      managed.exec("BEGIN IMMEDIATE");
      try {
        managed.exec("DELETE FROM credential");
        if (rows.length > 0 && columns.length > 0) {
          const placeholders = columns.map(() => "?").join(", ");
          const insert = managed.prepare(
            `INSERT INTO credential (${columns.join(", ")}) VALUES (${placeholders})`,
          );
          for (const row of rows) {
            insert.run(...columns.map((column) => row[column] ?? null));
          }
        }
        managed.exec("COMMIT");
      } catch (error) {
        try {
          managed.exec("ROLLBACK");
        } catch {
          // Connection may already be aborted.
        }
        throw error;
      }
    } finally {
      host.close();
      managed.close();
    }
  } catch {
    // If seed fails, leave auth.json bridge only; free models still work.
    if (!NodeFS.existsSync(managedDb)) return;
  }
}

export function applyOpenCode2ProviderEnvironment(
  settings: Pick<OpenCode2Settings, "backgroundSubagents" | "serverUrl">,
  environment: NodeJS.ProcessEnv,
  instanceId?: string,
  environmentIdentity?: string,
): NodeJS.ProcessEnv {
  if (settings.serverUrl.trim().length > 0) {
    return environment;
  }

  const hostDataHome = openCode2HostDataHome(environment);
  const preferredStateRoot = openCode2ManagedStateRoot(
    environment,
    instanceId,
    environmentIdentity,
  );
  migrateManagedStateRoot(preferredStateRoot, environment, instanceId, environmentIdentity);
  const preferredHomes = prepareManagedStateRoot(preferredStateRoot);
  const stateRoot =
    preferredHomes === undefined
      ? fallbackManagedStateRoot(preferredStateRoot, environment)
      : preferredStateRoot;
  if (stateRoot === undefined) {
    throw new Error("Unable to create a private OpenCode 2 managed-state root.");
  }
  const managedHomes =
    stateRoot === preferredStateRoot ? preferredHomes : prepareManagedStateRoot(stateRoot);
  if (managedHomes === undefined) {
    throw new Error("Unable to secure the private OpenCode 2 managed-state directories.");
  }
  seedOpenCode2ManagedDataHome(managedHomes.dataHome, hostDataHome);

  // Keep the host XDG_CONFIG_HOME so user provider config (e.g. llama.cpp)
  // still applies. Isolate only state (server password) and data (db/auth).
  return {
    ...environment,
    [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: settings.backgroundSubagents ? "true" : "false",
    XDG_DATA_HOME: managedHomes.dataHome,
    XDG_STATE_HOME: managedHomes.stateHome,
  };
}
