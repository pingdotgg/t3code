// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// The launcher must survive unloadable server versions; use Node built-ins without Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { acquireServiceSelectionLock } from "./cloud/serviceSelectionLock.ts";

import type {
  PendingServiceUpdate,
  ServiceLauncherChildMessage,
  ServiceLauncherContext,
  ServiceLauncherParentMessage,
  ServiceState,
  ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";
import {
  compareExactServiceVersions,
  decodeServiceLauncherChildMessage,
  isExactServiceVersion,
  parseLegacyServiceState,
  disabledServiceTask,
  parseServiceState,
  serviceTaskIsDisabled,
  serviceUnitBaseDirOf,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_LOCK_FILE,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
  SERVICE_UNIT_ENV,
} from "./cloud/serviceProtocol.ts";

const HANDOFF_DELAY_MS = 2_000;
/**
 * Migrations count toward it and can scale with the database: tens of GB on a cold page cache
 * take minutes. A missed window rolls back the database, so the next attempt pays the same cost.
 */
const PREPARED_TIMEOUT_MS = 30 * 60_000;
const TERMINATE_GRACE_MS = 5_000;
// A replacement started by a handoff waits up to two minutes for the stopping launcher.
const LOCK_RETRY_MS = 500;
const LOCK_ATTEMPTS = 240;
// Match contracts' SERVER_EXIT_CODE_STATE_DIR_OWNED without depending on Effect.
const STATE_DIR_OWNED_EXIT_CODE = 78;

type TerminalStatus = "committed" | "rolled-back" | "failed";
type ChildRole = "active" | "trial";

interface ManagedChild {
  readonly version: string;
  role: ChildRole;
  readonly process: NodeChildProcess.ChildProcess;
}

const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const executableName = process.platform === "win32" ? "t3.exe" : "t3";
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, executableName),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

const runtimeSpawnArguments = (paths: ReturnType<typeof runtimePaths>) => ({
  command: paths.entryPath,
  args: ["serve"],
});

/**
 * The unit or launch agent that `t3 service install` wrote. Its program names
 * the runtime that ran the install, and a remote update never replaces it, so
 * after a commit the launcher points it at the committed runtime. Otherwise the
 * next start lands on a runtime that nothing in the service state records.
 */
export interface ServiceUnit {
  readonly path: string;
  /** systemd and Task Scheduler keep a loaded copy; launchd re-reads the plist at bootstrap. */
  readonly reload: () => Promise<void>;
}

const runSchtasks = (...args: ReadonlyArray<string>) =>
  NodeUtil.promisify(NodeChildProcess.execFile)("schtasks", args, {
    windowsHide: true,
    timeout: 30_000,
  });

/**
 * Registering replaces the task, so one the CLI disabled to keep the service stopped is
 * registered disabled. The caller holds the unit lease, as the CLI does to disable it.
 */
export async function registerServiceTask(
  unitPath: string,
  taskName: string,
  schtasks: (...args: ReadonlyArray<string>) => Promise<{ readonly stdout: string }> = runSchtasks,
): Promise<void> {
  const register = (xmlPath: string) => schtasks("/Create", "/XML", xmlPath, "/TN", taskName, "/F");
  const registered = await schtasks("/Query", "/TN", taskName, "/XML");
  if (!serviceTaskIsDisabled(registered.stdout)) {
    await register(unitPath);
    return;
  }
  const disabledPath = `${unitPath}.${process.pid}.disabled`;
  try {
    const unit = await NodeFSP.readFile(unitPath, "utf8");
    await NodeFSP.writeFile(disabledPath, disabledServiceTask(unit));
    await register(disabledPath);
  } finally {
    await NodeFSP.rm(disabledPath, { force: true });
  }
}

function serviceUnitFromEnvironment(env: NodeJS.ProcessEnv = process.env): ServiceUnit | undefined {
  const unitName = env[SERVICE_UNIT_ENV]?.trim();
  if (!unitName) return undefined;
  if (unitName.endsWith(".xml")) {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) return undefined;
    const path = NodePath.win32.join(localAppData, "t3code", unitName);
    const taskName = serviceTaskName(env.USERDOMAIN ?? "", env.USERNAME ?? "");
    return { path, reload: () => registerServiceTask(path, taskName) };
  }
  const home = env.HOME?.trim();
  if (!home) return undefined;
  if (unitName.endsWith(".plist")) {
    return {
      path: NodePath.join(home, "Library", "LaunchAgents", unitName),
      reload: () => Promise.resolve(),
    };
  }
  // The manager's own environment, which decides where it reads user units.
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const configHome =
    xdgConfigHome && NodePath.isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : NodePath.join(home, ".config");
  return {
    path: NodePath.join(configHome, "systemd", "user", unitName),
    reload: () =>
      new Promise((resolve, reject) => {
        NodeChildProcess.spawn("systemctl", ["--user", "daemon-reload"], {
          stdio: "ignore",
          timeout: 30_000,
        })
          .once("error", reject)
          .once("exit", (code, signal) =>
            code === 0
              ? resolve()
              : reject(new Error(`systemctl --user daemon-reload exited with ${code ?? signal}`)),
          );
      }),
  };
}

// systemd's ExecStart value, or the plist string or task argument before __service-launcher.
// Only the version segment changes, so quoted or escaped paths stay as rendered.
// The launch agent's PATH names a versions directory without the executable; leave it.
const SERVICE_UNIT_PROGRAMS = [
  /^(ExecStart=.*?[\\/]runtime[\\/]versions[\\/])([^\\/\s"]+)([\\/]t3)(?=["\s])/m,
  /(<string>[^<]*?[\\/]runtime[\\/]versions[\\/])([^\\/<]+)([\\/]t3<\/string>\s*<string>__service-launcher<\/string>)/,
  /(<Arguments>--headless "[^"<]*?[\\/]runtime[\\/]versions[\\/])([^\\/"<]+)([\\/]t3\.exe" "__service-launcher")/,
] as const;

/**
 * The unit contents with their program pointed at `version`'s runtime. A unit
 * already at that version or a newer one is returned unchanged: `t3 update`
 * may have repointed it to a later version while this commit was in flight.
 */
function repointServiceUnit(contents: string, version: string): string {
  for (const program of SERVICE_UNIT_PROGRAMS) {
    const match = program.exec(contents);
    if (match === null) continue;
    const [, prefix = "", current = "", suffix = ""] = match;
    if (isExactServiceVersion(current) && compareExactServiceVersions(current, version) >= 0) {
      return contents;
    }
    return contents.replace(program, () => `${prefix}${version}${suffix}`);
  }
  return contents;
}

const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const RESTORE_MARKER = ".restore-pending";

const databaseBackupDir = (baseDir: string, updateId: string) =>
  NodePath.join(baseDir, "runtime", "db-backup", updateId);

const databaseBackupFile = (backupDir: string, suffix: (typeof DB_FILE_SUFFIXES)[number]) =>
  NodePath.join(backupDir, suffix === "" ? "database" : `database${suffix}`);

async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

const MANAGED_SERVICE_ENV_NAMES = new Set([
  "PATH",
  "T3CODE_HOME",
  "T3_BOOT_SERVICE_UNIT",
  SERVICE_LAUNCHER_CONTEXT_ENV,
]);

export async function readServiceEnvironment(
  baseDir: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  let contents: string;
  try {
    contents = await NodeFSP.readFile(NodePath.join(baseDir, SERVICE_ENV_FILE), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return environment;
    throw cause;
  }
  for (const [name, value] of Object.entries(NodeUtil.parseEnv(contents))) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !MANAGED_SERVICE_ENV_NAMES.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

// Opened read-write: Windows refuses to flush a handle without write access.
async function syncFile(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Fsync makes renames durable; Windows returns EPERM and NTFS journals them itself.
async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}

function runCp(args: ReadonlyArray<string>): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile("cp", args, (error) => resolve(error === null));
  });
}

// macOS fs.copyFile clone flags fall back to full copies.
async function copyDatabaseFile(source: string, destination: string): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  // cp -c replaces files and breaks hard links; copy into hard-linked destinations instead.
  const hardLinked =
    platform === "darwin" &&
    ((await NodeFSP.stat(destination).catch(() => undefined))?.nlink ?? 1) > 1;
  const args =
    platform === "darwin" && !hardLinked
      ? ["-c", source, destination]
      : platform === "linux"
        ? ["--reflink=auto", source, destination]
        : undefined;
  if (args === undefined || !(await runCp(args))) await NodeFSP.copyFile(source, destination);
}

const GIB = 1024 ** 3;
// Cloned backups still need headroom for trial writes and migrations to diverge.
const CLONED_BACKUP_MIN_HEADROOM_BYTES = GIB;
const CLONED_BACKUP_HEADROOM_FRACTION = 0.1;
// While the online backup holds its snapshot, the live WAL and its copy can each reach the server's 128 MiB gate.
const ONLINE_BACKUP_WAL_HEADROOM_BYTES = 2 * 128 * 1024 ** 2;

async function statDatabaseFiles(dbPath: string): Promise<ReadonlyArray<NodeFS.Stats>> {
  const stats: Array<NodeFS.Stats> = [];
  for (const suffix of DB_FILE_SUFFIXES) {
    const stat = await NodeFSP.stat(`${dbPath}${suffix}`).catch((cause: unknown) => {
      if (suffix !== "" && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (stat !== undefined) stats.push(stat);
  }
  return stats;
}

// cp -c silently copies across volumes; require one device matching the APFS system volume's filesystem type.
async function backupCanClone(dbPath: string, backupRoot: string): Promise<boolean> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  if (platform === "darwin") {
    const [backupDirectory, backupFs, systemFs] = await Promise.all([
      NodeFSP.stat(backupRoot),
      NodeFSP.statfs(backupRoot),
      NodeFSP.statfs("/"),
    ]);
    if (backupFs.type !== systemFs.type) return false;
    return (await statDatabaseFiles(dbPath)).every(
      (source) => source.dev === backupDirectory.dev && source.nlink === 1,
    );
  }
  if (platform !== "linux") return false;
  const probe = NodePath.join(backupRoot, `.clone-probe-${NodeCrypto.randomUUID()}`);
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      if (!(await runCp(["--reflink=always", source, `${probe}${suffix}`]))) return false;
    }
    return true;
  } finally {
    for (const suffix of DB_FILE_SUFFIXES) {
      await NodeFSP.rm(`${probe}${suffix}`, { force: true }).catch(() => undefined);
    }
  }
}

export interface BackupSpaceProbe {
  readonly readFreeBytes: (directory: string) => Promise<number>;
  readonly canClone: (dbPath: string, backupRoot: string) => Promise<boolean>;
}

const filesystemBackupSpaceProbe: BackupSpaceProbe = {
  readFreeBytes: async (directory) => {
    const stats = await NodeFSP.statfs(directory);
    return stats.bavail * stats.bsize;
  },
  canClone: backupCanClone,
};

// A killed launcher skips the backup's cleanup, and retries only clear their own update's copy.
// Update requests are refused while one is pending, so no staging directory is still in use here.
async function removeAbandonedBackupCopies(backupRoot: string): Promise<void> {
  for (const entry of await NodeFSP.readdir(backupRoot)) {
    if (!entry.endsWith(".staging")) continue;
    await NodeFSP.rm(NodePath.join(backupRoot, entry), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/** Check before stopping the server so full disks refuse updates without an outage. */
export async function databaseBackupBlocker(
  baseDir: string,
  dbPath: string,
  probe: Partial<BackupSpaceProbe> = {},
): Promise<string | undefined> {
  const { readFreeBytes, canClone } = { ...filesystemBackupSpaceProbe, ...probe };
  const backupRoot = NodePath.join(baseDir, "runtime", "db-backup");
  await NodeFSP.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await removeAbandonedBackupCopies(backupRoot);
  const [files, free] = await Promise.all([statDatabaseFiles(dbPath), readFreeBytes(backupRoot)]);
  const size = files.reduce((total, file) => total + file.size, 0);
  const fullCopyBytes = size * 1.05 + ONLINE_BACKUP_WAL_HEADROOM_BYTES;
  if (free >= fullCopyBytes) return undefined;
  const clonedBytes = Math.max(
    CLONED_BACKUP_MIN_HEADROOM_BYTES,
    size * CLONED_BACKUP_HEADROOM_FRACTION,
  );
  const needed = (await canClone(dbPath, backupRoot)) ? clonedBytes : fullCopyBytes;
  if (free >= needed) return undefined;
  const gb = (bytes: number) => (bytes / GIB).toFixed(1);
  return `Not enough free disk space to back up the database before updating: ${gb(needed)} GB needed, ${gb(free)} GB free. Free up disk space and try again. The server was not stopped.`;
}

// A child-process copy: closing any descriptor this process opens on the database drops the snapshot's POSIX locks.
async function copyWithoutOpening(source: string, destination: string): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  if (process.platform === "win32") return NodeFSP.copyFile(source, destination);
  if (!(await runCp([source, destination]))) throw new Error(`cp ${source} failed.`);
}

// Copies the main file while the server runs; an open read transaction stops SQLite resetting the WAL,
// which `finish` copies after the stop and which overrides any page the copy caught mid-checkpoint.
// `-shm` is left out: its backfill count would make SQLite trust those pages. Past the WAL size gate,
// a write-heavy server's new writes wait, uncommitted, until the server stops.
async function startOnlineDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
  probe: Partial<BackupSpaceProbe> = {},
): Promise<(() => Promise<void>) | undefined> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) return undefined;
  const { canClone } = { ...filesystemBackupSpaceProbe, ...probe };
  if (await canClone(pending.dbPath, NodePath.dirname(backupDir)).catch(() => true))
    return undefined;
  const NodeSqlite = await import("node:sqlite").catch(() => undefined);
  if (NodeSqlite === undefined) return undefined;

  const stagingDir = `${backupDir}.staging`;
  const discardStaging = () =>
    NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  const fallBack = async (cause: unknown) => {
    await discardStaging();
    process.stderr.write(
      `[service-launcher] Copying the database while the server runs failed; backing it up offline: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return undefined;
  };
  let snapshot: InstanceType<typeof NodeSqlite.DatabaseSync> | undefined;
  // SQLite keeps -wal beside the resolved file, not beside a symlink to it.
  let dbPath = pending.dbPath;
  const release = () => {
    try {
      snapshot?.close();
    } catch {}
    snapshot = undefined;
  };
  try {
    await discardStaging();
    await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    dbPath = await NodeFSP.realpath(pending.dbPath);
    snapshot = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const mode = String(snapshot.prepare("PRAGMA journal_mode").get()?.journal_mode);
    if (mode.toLowerCase() !== "wal") throw new Error(`journal_mode is ${mode}, not wal.`);
    snapshot.exec("BEGIN");
    snapshot.prepare("SELECT count(*) FROM sqlite_schema").get();
    const mainCopy = databaseBackupFile(stagingDir, "");
    await copyWithoutOpening(dbPath, mainCopy);
    await syncFile(mainCopy);
  } catch (cause) {
    release();
    return fallBack(cause);
  }
  return async () => {
    try {
      const wal = `${dbPath}-wal`;
      if (!(await pathExists(wal)))
        throw new Error("the WAL disappeared while the snapshot was open.");
      const walCopy = databaseBackupFile(stagingDir, "-wal");
      await copyWithoutOpening(wal, walCopy);
      await syncFile(walCopy);
      release();
      await NodeFSP.rename(stagingDir, backupDir);
      await syncDirectory(NodePath.dirname(backupDir));
    } catch (cause) {
      release();
      await fallBack(cause);
    }
  };
}

// Preserve completed backups; restarted trials may already have changed the live database.
async function backupDatabaseOnce(baseDir: string, pending: PendingServiceUpdate): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) return;

  const stagingDir = `${backupDir}.staging`;
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${pending.dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      const destination = databaseBackupFile(stagingDir, suffix);
      await copyDatabaseFile(source, destination);
      await syncFile(destination);
    }
    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
  } catch (cause) {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

const restoreMarkerPath = (baseDir: string, updateId: string) =>
  NodePath.join(databaseBackupDir(baseDir, updateId), RESTORE_MARKER);

const databaseRestorePending = (baseDir: string, pending: PendingServiceUpdate) =>
  pathExists(restoreMarkerPath(baseDir, pending.id));

// Mark before live writes so recovery cannot boot a partial restore.
async function markDatabaseRestorePending(backupDir: string): Promise<void> {
  const markerPath = NodePath.join(backupDir, RESTORE_MARKER);
  if (!(await pathExists(markerPath))) {
    const handle = await NodeFSP.open(markerPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(backupDir);
  }
}

// Resolve symlink targets even if a crashed cp -c left the final target missing.
async function restoreTarget(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    try {
      return await NodeFSP.realpath(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const link = await NodeFSP.readlink(current).catch((cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") return undefined;
      throw cause;
    });
    if (link === undefined) return current;
    // Do not normalize .. before following directory symlinks; match filesystem resolution.
    current = NodePath.isAbsolute(link)
      ? link
      : `${await NodeFSP.realpath(NodePath.dirname(current))}${NodePath.sep}${link}`;
  }
  throw new Error(`Too many symbolic links resolving ${path}.`);
}

async function restoreDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (!(await pathExists(backupDir))) return;

  await markDatabaseRestorePending(backupDir);
  const directories = new Set([NodePath.dirname(pending.dbPath)]);
  // SQLite keeps -wal and -shm beside the resolved database file, not beside a symlink to it.
  const mainTarget = await restoreTarget(pending.dbPath);
  for (const suffix of DB_FILE_SUFFIXES) {
    const livePath = suffix === "" ? pending.dbPath : `${mainTarget}${suffix}`;
    if (livePath !== `${pending.dbPath}${suffix}`) {
      await NodeFSP.rm(`${pending.dbPath}${suffix}`, { force: true });
    }
    const source = databaseBackupFile(backupDir, suffix);
    if (await pathExists(source)) {
      // Restore into the symlink target; cloning would replace the link.
      const target = await restoreTarget(livePath);
      await copyDatabaseFile(source, target);
      await syncFile(target);
      directories.add(NodePath.dirname(target));
    } else {
      await NodeFSP.rm(livePath, { force: true });
    }
  }
  for (const directory of directories) await syncDirectory(directory);
}

async function discardDatabaseBackup(baseDir: string, updateId: string): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, updateId);
  if (!(await pathExists(backupDir))) return;
  await NodeFSP.rm(backupDir, { recursive: true, force: true });
  await syncDirectory(NodePath.dirname(backupDir));
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const state = parseServiceState(contents) ?? adoptLegacyServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
}

// An older coordinator can write protocol 2 beside a newer runtime. Adopt
// only its install record, in memory: rewriting it outside the selection lock
// could replace state a concurrent install wrote after this read.
function adoptLegacyServiceState(contents: string): ServiceState | undefined {
  const legacy = parseLegacyServiceState(contents);
  return legacy && { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: legacy.activeVersion };
}

export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  await replaceFileDurably(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function replaceFileDurably(filePath: string, contents: string): Promise<void> {
  const directory = NodePath.dirname(filePath);
  const tempPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(tempPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function runtimeExists(baseDir: string, version: string): Promise<boolean> {
  const paths = runtimePaths(baseDir, version);
  try {
    const [entry, sentinel] = await Promise.all([
      NodeFSP.stat(paths.entryPath),
      NodeFSP.readFile(paths.sentinelPath, "utf8"),
    ]);
    return entry.isFile() && sentinel.trim() === version;
  } catch {
    return false;
  }
}

function terminalUpdate<S extends TerminalStatus>(input: {
  readonly pending: PendingServiceUpdate;
  readonly status: S;
  readonly reason?: string;
}): Exclude<ServiceUpdateRecord, PendingServiceUpdate> & { readonly status: S } {
  return {
    id: input.pending.id,
    fromVersion: input.pending.fromVersion,
    targetVersion: input.pending.targetVersion,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function sendMessage(
  child: NodeChildProcess.ChildProcess,
  message: ServiceLauncherParentMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error("service child IPC is disconnected."));
      return;
    }
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

function waitForExit(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function terminateChild(
  child: NodeChildProcess.ChildProcess,
  signal: NodeJS.Signals,
  overIpc: boolean,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (overIpc) {
    await sendMessage(child, { type: "stop" }).catch(() => child.kill(signal));
  } else {
    child.kill(signal);
  }
  const force = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await waitForExit(child);
  } finally {
    clearTimeout(force);
  }
}

/** Task Scheduler names are machine-wide, so each Windows account runs its own task. */
export const serviceTaskName = (domain: string, userName: string) => `t3code-${domain}-${userName}`;

export const serviceLauncherLockPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_LAUNCHER_LOCK_FILE);

// An exclusive SQLite transaction, like the server's owner lock: the OS drops it when the holder dies.
async function tryAcquireLauncherLock(
  lockPath: string,
): Promise<{ readonly close: () => void } | undefined> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(lockPath);
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    return db;
  } catch (cause) {
    db.close();
    if (cause instanceof Error && "errcode" in cause && cause.errcode === 5) return undefined;
    throw cause;
  }
}

export async function serviceLauncherIsRunning(lockPath: string): Promise<boolean> {
  if (!NodeFS.existsSync(lockPath)) return false;
  const lock = await tryAcquireLauncherLock(lockPath);
  lock?.close();
  return lock === undefined;
}

/** Resolves once no launcher holds the lock; the caller bounds the wait through `signal`. */
export async function waitForServiceLauncherExit(
  lockPath: string,
  signal: AbortSignal,
): Promise<void> {
  while (await serviceLauncherIsRunning(lockPath)) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);
const restartPendingPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);

export class Launcher {
  readonly #baseDir: string;
  readonly #statePath: string;
  #state: ServiceState;
  #child: ManagedChild | null = null;
  #timer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopping = false;
  #done = false;
  readonly #completion = Promise.withResolvers<void>();
  readonly #backupSpaceProbe: Partial<BackupSpaceProbe> | undefined;
  readonly #serviceUnit: ServiceUnit | undefined;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #output: number | undefined;
  readonly #lockPath: string | undefined;
  readonly #stopChildOverIpc: boolean;

  constructor(
    baseDir: string,
    state: ServiceState,
    options: {
      readonly backupSpaceProbe?: Partial<BackupSpaceProbe>;
      readonly serviceUnit?: ServiceUnit;
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      /** Launcher and server output, for managers that cannot redirect it. */
      readonly output?: number;
      /** Makes this the only launcher for its home; a replacement waits for the one stopping. */
      readonly lockPath?: string;
      /** Windows `kill()` is TerminateProcess, which skips the server's shutdown finalizers. */
      readonly stopChildOverIpc?: boolean;
    } = {},
  ) {
    this.#baseDir = baseDir;
    this.#backupSpaceProbe = options.backupSpaceProbe;
    this.#serviceUnit = options.serviceUnit;
    this.#environment = { ...(options.environment ?? process.env) };
    this.#output = options.output;
    this.#lockPath = options.lockPath;
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
    this.#stopChildOverIpc = options.stopChildOverIpc ?? process.platform === "win32";
    this.#statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    this.#state = state;
  }

  async run(): Promise<void> {
    const onSigterm = () => void this.stop("SIGTERM");
    const onSigint = () => void this.stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    try {
      const lock =
        this.#lockPath === undefined ? undefined : await this.#acquireLock(this.#lockPath);
      try {
        // The launcher that held the lock may have moved the state since main read it.
        if (lock !== undefined) this.#state = await readServiceState(this.#statePath);
        // A stop that arrived before this point leaves nothing to start or recover.
        if (!this.#stopRequested) this.#enqueue(() => this.#recover());
        await this.#completion.promise;
      } finally {
        if (lock !== undefined) {
          // Releasing the lock says this launcher is done with the home.
          await this.#transitions.catch(() => undefined);
          lock.close();
        }
      }
    } finally {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    }
  }

  async #acquireLock(lockPath: string): Promise<{ readonly close: () => void } | undefined> {
    for (let attempt = 1; !this.#stopRequested; attempt++) {
      const lock = await tryAcquireLauncherLock(lockPath);
      if (lock !== undefined) return lock;
      if (attempt >= LOCK_ATTEMPTS) {
        throw new Error("Another T3 Code service launcher still runs for this T3 home.");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    return undefined;
  }

  #terminate(child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
    return terminateChild(child, signal, this.#stopChildOverIpc);
  }

  #log(line: string): void {
    if (this.#output === undefined) process.stderr.write(line);
    else NodeFS.writeSync(this.#output, line);
  }

  #enqueue(transition: () => Promise<void>): void {
    this.#transitions = this.#transitions
      .then(transition, transition)
      .catch((cause: unknown) =>
        this.#fatal(cause instanceof Error ? cause : new Error(String(cause))),
      );
  }

  async #fatal(error: Error): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#stopping = true;
    this.#clearTimer();
    const child = this.#child?.process;
    this.#child = null;
    if (child !== undefined) await this.#terminate(child);
    this.#completion.reject(error);
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    // Write synchronously on signal receipt; a terminating child needs the marker in its finalizer.
    try {
      NodeFS.writeFileSync(stopMarkerPath(this.#baseDir), "", { mode: 0o600 });
    } catch {}
    if (this.#stopRequested || this.#stopping) {
      await this.#completion.promise.catch(() => undefined);
      return;
    }
    this.#stopRequested = true;
    this.#clearTimer();
    this.#enqueue(async () => {
      // Let in-progress updates start replacements first; replacements observe the marker and own pre-activation tunnel cleanup.
      this.#stopping = true;
      const child = this.#child?.process;
      this.#child = null;
      if (child !== undefined) await this.#terminate(child, signal);
      this.#done = true;
      this.#completion.resolve();
    });
    await this.#completion.promise.catch(() => undefined);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #selectState(next: ServiceState): Promise<void> {
    const release = await acquireServiceSelectionLock(this.#statePath);
    try {
      const selected = await readServiceState(this.#statePath);
      // Local installs replace the selection and clear its update record. An old
      // launcher must not restore its own selection when asked to update again.
      if (
        selected.activeVersion !== this.#state.activeVersion ||
        selected.update?.id !== this.#state.update?.id ||
        selected.update?.status !== this.#state.update?.status
      ) {
        throw new Error("Service selection changed. Restart the service before updating.");
      }
      await writeServiceState(this.#statePath, next);
      this.#state = next;
    } finally {
      release();
    }
  }

  async #recover(): Promise<void> {
    // Clear old stop markers to preserve future tunnels; clear restart-pending only for the awaited version to avoid CLI races.
    await NodeFSP.rm(stopMarkerPath(this.#baseDir), { force: true }).catch(() => undefined);
    const restartPending = restartPendingPath(this.#baseDir);
    try {
      const release = await acquireServiceSelectionLock(this.#statePath);
      try {
        const selected = await readServiceState(this.#statePath);
        const awaitedVersion = await NodeFSP.readFile(restartPending, "utf8").catch(
          () => undefined,
        );
        const awaited = awaitedVersion?.trim();
        if (
          selected.activeVersion === this.#state.activeVersion &&
          selected.update?.id === this.#state.update?.id &&
          selected.update?.status === this.#state.update?.status &&
          awaited !== undefined &&
          isExactServiceVersion(awaited) &&
          compareExactServiceVersions(awaited, this.#state.activeVersion) <= 0
        ) {
          await NodeFSP.rm(restartPending, { force: true });
        }
      } finally {
        release();
      }
    } catch (error) {
      process.stderr.write(
        `[service-launcher] Could not clear ${restartPending}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    const update = this.#state.update;
    if (update?.status !== "pending") {
      if (update !== undefined) {
        await discardDatabaseBackup(this.#baseDir, update.id).catch(() => undefined);
      }
      try {
        await this.#startChild(this.#state.activeVersion, "active", update);
      } finally {
        if (update !== undefined) await this.#repointServiceUnit(this.#state.activeVersion);
      }
      return;
    }
    if (await databaseRestorePending(this.#baseDir, update)) {
      await this.#returnToPrevious(update, "failed", "rollback-interrupted");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, update.targetVersion))) {
      await this.#returnToPrevious(update, "failed", "target-runtime-missing");
      return;
    }
    await this.#startTrial(update);
  }

  async #startTrial(pending: PendingServiceUpdate): Promise<void> {
    try {
      await backupDatabaseOnce(this.#baseDir, pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "db-backup-failed");
      return;
    }
    try {
      await this.#startChild(pending.targetVersion, "trial", pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "candidate-start-failed");
    }
  }

  async #startChild(version: string, role: ChildRole, update?: ServiceUpdateRecord): Promise<void> {
    if (this.#stopping) return;
    if (!(await runtimeExists(this.#baseDir, version))) {
      throw new Error(`Selected t3@${version} runtime is missing or incomplete.`);
    }
    if (this.#stopping) return;
    const paths = runtimePaths(this.#baseDir, version);
    const context: ServiceLauncherContext = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: version,
      ...(update === undefined ? {} : { update }),
    };
    const spawnArguments = runtimeSpawnArguments(paths);
    const child = NodeChildProcess.spawn(spawnArguments.command, spawnArguments.args, {
      env: { ...this.#environment, [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) },
      stdio:
        this.#output === undefined
          ? ["inherit", "inherit", "inherit", "ipc"]
          : ["ignore", this.#output, this.#output, "ipc"],
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        child.on("error", (error) => this.#enqueue(() => Promise.reject(error)));
        resolve();
      });
    });
    if (this.#stopping) {
      await this.#terminate(child);
      return;
    }

    const managed: ManagedChild = {
      version,
      role,
      process: child,
    };
    this.#child = managed;
    child.on("message", (value) => {
      const message = decodeServiceLauncherChildMessage(value);
      if (message !== undefined) this.#enqueue(() => this.#handleMessage(managed, message));
    });
    child.once("exit", (code, signal) =>
      this.#enqueue(() => this.#handleExit(managed, code, signal)),
    );

    if (role === "trial") {
      this.#timer = setTimeout(
        () => this.#enqueue(() => this.#handlePreparedTimeout(managed)),
        PREPARED_TIMEOUT_MS,
      );
    }
  }

  async #handleMessage(child: ManagedChild, message: ServiceLauncherChildMessage): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    if (message.type === "request-update") {
      await this.#handleUpdateRequest(child, message);
      return;
    }
    await this.#handlePrepared(child, message.updateId);
  }

  async #handleUpdateRequest(
    child: ManagedChild,
    message: Extract<ServiceLauncherChildMessage, { readonly type: "request-update" }>,
  ): Promise<void> {
    const reject = (reason: string) =>
      sendMessage(child.process, { type: "update-rejected", reason });
    if (child.role !== "active") {
      await reject("Only the active server can request an update.");
      return;
    }
    if (child.version !== this.#state.activeVersion) {
      await reject("The requesting server is not the selected active version.");
      return;
    }
    if (this.#state.update?.status === "pending") {
      await reject("Another server update is already pending.");
      return;
    }
    if (!isExactServiceVersion(message.targetVersion)) {
      await reject("The requested target is not an exact version.");
      return;
    }
    if (compareExactServiceVersions(message.targetVersion, child.version) <= 0) {
      await reject("Remote updates must select a newer server version.");
      return;
    }
    if (!NodePath.isAbsolute(message.dbPath)) {
      await reject("The requested database path is not absolute.");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, message.targetVersion))) {
      await reject("The requested target runtime is missing or incomplete.");
      return;
    }
    // Failed checks must refuse updates rather than stop the server with unknown backup capacity.
    const backupBlocker = await databaseBackupBlocker(
      this.#baseDir,
      message.dbPath,
      this.#backupSpaceProbe,
    ).catch(
      (error: unknown) =>
        `Could not check that the database backup fits before updating: ${error instanceof Error ? error.message : String(error)}. The server was not stopped.`,
    );
    if (!child.process.connected) return;
    if (backupBlocker !== undefined) {
      await reject(backupBlocker);
      return;
    }

    const pending: PendingServiceUpdate = {
      id: NodeCrypto.randomUUID(),
      fromVersion: child.version,
      targetVersion: message.targetVersion,
      dbPath: message.dbPath,
      status: "pending",
    };
    const next: ServiceState = { ...this.#state, update: pending };
    try {
      await this.#selectState(next);
    } catch (error) {
      await reject(error instanceof Error ? error.message : String(error));
      return;
    }
    await sendMessage(child.process, { type: "update-accepted", updateId: pending.id });
    this.#timer = setTimeout(() => this.#enqueue(() => this.#beginTrial(child)), HANDOFF_DELAY_MS);
  }

  async #beginTrial(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "active" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    // Anything thrown outside its own fallback still leaves the offline backup to run.
    const finishOnlineBackup = await startOnlineDatabaseBackup(
      this.#baseDir,
      pending,
      this.#backupSpaceProbe,
    ).catch(() => undefined);
    this.#child = null;
    await this.#terminate(child.process);
    await finishOnlineBackup?.();
    // A stop during a minutes-long copy should not start a trial; restart resumes the pending update.
    if (this.#stopRequested) return;
    await this.#startTrial(pending);
  }

  async #handlePrepared(child: ManagedChild, updateId: string): Promise<void> {
    const pending = this.#state.update;
    if (
      child.role !== "trial" ||
      pending?.status !== "pending" ||
      pending.id !== updateId ||
      pending.targetVersion !== child.version
    ) {
      if (child.role === "trial" && pending?.status === "pending") {
        await this.#returnToPrevious(pending, "rolled-back", "invalid-prepared", child);
        return;
      }
      throw new Error("Trial child reported prepared for an unexpected update.");
    }
    this.#clearTimer();
    const committed = terminalUpdate({ pending, status: "committed" });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.targetVersion,
      update: committed,
    };
    await this.#selectState(next);
    child.role = "active";
    await discardDatabaseBackup(this.#baseDir, committed.id).catch(() => undefined);
    try {
      await sendMessage(child.process, { type: "committed", updateId: committed.id });
    } finally {
      await this.#repointServiceUnit(committed.targetVersion);
    }
  }

  // Selection is durable before this best-effort unit reconciliation.
  async #repointServiceUnit(version: string): Promise<void> {
    const unit = this.#serviceUnit;
    if (unit === undefined) return;
    try {
      const release = await acquireServiceSelectionLock(unit.path);
      try {
        // The installer writes state before the unit under this lease. Do not
        // acquire its state lease here: the installer takes that lease first.
        const selected = await readServiceState(this.#statePath);
        if (
          selected.activeVersion !== this.#state.activeVersion ||
          selected.update?.id !== this.#state.update?.id ||
          selected.update?.status !== this.#state.update?.status
        ) {
          return;
        }
        const contents = await NodeFSP.readFile(unit.path, "utf8");
        const installedBaseDir = serviceUnitBaseDirOf(contents);
        if (
          installedBaseDir === undefined ||
          NodePath.resolve(installedBaseDir) !== NodePath.resolve(this.#baseDir)
        ) {
          return;
        }
        const repointed = repointServiceUnit(contents, version);
        if (repointed !== contents) await replaceFileDurably(unit.path, repointed);
        // A previous rename may have succeeded before reload failed.
        await unit.reload();
      } finally {
        release();
      }
    } catch (error) {
      process.stderr.write(
        `[service-launcher] Could not point ${unit.path} at t3@${version}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  async #handlePreparedTimeout(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "trial" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    await this.#returnToPrevious(pending, "rolled-back", "prepared-timeout", child);
  }

  async #handleExit(
    child: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    this.#child = null;
    if (code === STATE_DIR_OWNED_EXIT_CODE) {
      await this.#idleWhileStateDirOwned();
      return;
    }
    if (child.role === "trial") {
      this.#clearTimer();
      const pending = this.#state.update;
      if (pending?.status !== "pending") {
        throw new Error("Trial child exited without matching pending state.");
      }
      await this.#returnToPrevious(
        pending,
        "rolled-back",
        `candidate-exited:${String(code ?? signal ?? "unknown")}`,
      );
      return;
    }

    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      await this.#startTrial(pending);
      return;
    }
    throw new Error(`Active child exited unexpectedly (${String(code ?? signal ?? "unknown")}).`);
  }

  // Stay idle to avoid supervisor restart loops; never restore backups over another owner's possible writes.
  async #idleWhileStateDirOwned(): Promise<void> {
    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      const next: ServiceState = {
        ...this.#state,
        activeVersion: pending.fromVersion,
        update: terminalUpdate({ pending, status: "failed", reason: "state-dir-owned" }),
      };
      await this.#selectState(next);
      await discardDatabaseBackup(this.#baseDir, pending.id).catch(() => undefined);
      await this.#repointServiceUnit(next.activeVersion);
    }
    // Signal listeners alone do not keep Node alive.
    this.#timer = setInterval(() => {}, 2_147_483_647);
    this.#log(
      "[service-launcher] Another T3 Code server owns this T3 home. Stop it, then restart this service.\n",
    );
  }

  async #returnToPrevious(
    pending: PendingServiceUpdate,
    status: "rolled-back" | "failed",
    reason: string,
    child?: ManagedChild,
  ): Promise<void> {
    if (child !== undefined) {
      this.#child = null;
      await this.#terminate(child.process);
    }
    await restoreDatabaseBackup(this.#baseDir, pending);
    const outcome = terminalUpdate({ pending, status, reason });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.fromVersion,
      update: outcome,
    };
    await this.#selectState(next);
    await discardDatabaseBackup(this.#baseDir, pending.id).catch(() => undefined);
    try {
      await this.#startChild(next.activeVersion, "active", outcome);
    } finally {
      await this.#repointServiceUnit(next.activeVersion);
    }
  }
}

/** Task Scheduler cannot set variables or redirect output, so a Windows task passes them as flags. */
export interface LauncherOptions {
  readonly baseDir?: string | undefined;
  readonly logFile?: string | undefined;
  readonly serviceUnit?: string | undefined;
}

export async function main(options: LauncherOptions = {}): Promise<void> {
  const baseDir = (options.baseDir ?? process.env.T3CODE_HOME)?.trim();
  if (baseDir === undefined || baseDir === "") {
    throw new Error("T3CODE_HOME is required by the T3 Code service launcher.");
  }
  const output =
    options.logFile === undefined ? undefined : NodeFS.openSync(options.logFile, "a", 0o600);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const windows = process.platform === "win32";
  try {
    // What the service manager started the launcher with. It locates the unit; service.env
    // changes only what the server gets.
    const managerEnvironment = {
      ...process.env,
      T3CODE_HOME: baseDir,
      ...(options.serviceUnit === undefined ? {} : { [SERVICE_UNIT_ENV]: options.serviceUnit }),
    };
    const environment = await readServiceEnvironment(baseDir, managerEnvironment);
    const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    const contents = await NodeFSP.readFile(statePath, "utf8");
    let state = parseServiceState(contents);
    if (state === undefined) {
      state = adoptLegacyServiceState(contents);
      if (state === undefined) throw new Error("Service state is invalid or unsupported.");
      if (!(await runtimeExists(baseDir, state.activeVersion))) {
        throw new Error(`Selected t3@${state.activeVersion} runtime is missing or incomplete.`);
      }
    }
    const serviceUnit = serviceUnitFromEnvironment(managerEnvironment);
    const launcher = new Launcher(baseDir, state, {
      environment,
      ...(serviceUnit === undefined ? {} : { serviceUnit }),
      ...(output === undefined ? {} : { output }),
      ...(windows ? { lockPath: serviceLauncherLockPath(baseDir) } : {}),
    });
    // Ending a scheduled task kills its console host without a signal; the console read fails instead.
    const watchConsole = windows && process.stdin.isTTY === true;
    const onConsoleLost = () => void launcher.stop("SIGTERM");
    if (watchConsole) {
      process.stdin.on("error", () => undefined);
      process.stdin.once("close", onConsoleLost);
      process.stdin.resume();
    }
    try {
      await launcher.run();
    } finally {
      if (watchConsole) {
        process.stdin.off("close", onConsoleLost);
        process.stdin.destroy();
      }
    }
  } catch (cause) {
    if (output !== undefined) {
      NodeFS.writeSync(
        output,
        `[service-launcher] ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
    // Agents the server left behind keep the console host, and so the task, running; ending it
    // lets the next repeating trigger start the service again.
    if (windows && options.serviceUnit !== undefined) {
      const taskName = serviceTaskName(process.env.USERDOMAIN ?? "", process.env.USERNAME ?? "");
      NodeChildProcess.spawnSync("schtasks", ["/End", "/TN", taskName], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    throw cause;
  } finally {
    if (output !== undefined) NodeFS.closeSync(output);
  }
}
