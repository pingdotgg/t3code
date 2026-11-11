// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// The launcher must survive unloadable server versions; use Node built-ins without Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
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
  isValidServiceUpdateId,
  parseServiceState,
  SERVER_OWNER_LEASE_FILE,
  serviceUnitBaseDirOf,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
  SERVICE_UNIT_ENV,
  serviceStateActiveVersion,
  serviceStateHasPendingUpdate,
} from "./cloud/serviceProtocol.ts";

const HANDOFF_DELAY_MS = 2_000;
/**
 * Migrations count toward it and can scale with the database: tens of GB on a cold page cache
 * take minutes. A missed window rolls back the database, so the next attempt pays the same cost.
 */
const PREPARED_TIMEOUT_MS = 30 * 60_000;
const TERMINATE_GRACE_MS = 5_000;
// A replacement started by a handoff waits up to two minutes for the stopping launcher.
const CONTROL_LISTEN_RETRY_MS = 500;
const CONTROL_LISTEN_ATTEMPTS = 240;
const CONTROL_HANDSHAKE_TIMEOUT_MS = 5_000;
const CONTROL_QUERY_TIMEOUT_MS = 5_000;
// Leave 30s inside BootService STOP_STEP_TIMEOUT (120s) for fallback task termination + lock release.
const CONTROL_STOP_REQUEST_TIMEOUT_MS = 90_000;
const CONTROL_MUTATION_TIMEOUT_MS = 120_000;
const MAX_CONTROL_MESSAGE_BYTES = 16_384;
const MAX_UNAUTHENTICATED_CONTROL_SOCKETS = 16;
const MAX_TOTAL_CONTROL_SOCKETS = 64;
// Match contracts' SERVER_EXIT_CODE_STATE_DIR_OWNED without depending on Effect.
const STATE_DIR_OWNED_EXIT_CODE = 78;
const IS_WINDOWS = NodePath.sep === "\\";

type TerminalStatus = "committed" | "rolled-back" | "failed";
type ChildRole = "active" | "trial";

interface ManagedChild {
  readonly version: string;
  role: ChildRole;
  readonly process: NodeChildProcess.ChildProcess;
}

const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  const executableName = IS_WINDOWS ? "t3.exe" : "t3";
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, executableName),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

const runtimeSpawnArguments = (entryPath: string) => ({
  command: entryPath,
  args: ["serve"] as ReadonlyArray<string>,
});

/**
 * The unit or launch agent that `t3 service install` wrote. Its program names
 * the runtime that ran the install, and a remote update never replaces it, so
 * after a commit the launcher points it at the committed runtime. Otherwise the
 * next start lands on a runtime that nothing in the service state records.
 */
export interface ServiceUnit {
  readonly path: string;
  /** systemd and Task Scheduler keep a loaded copy of the definition; launchd re-reads the plist at bootstrap. */
  readonly reload: () => Promise<void>;
}

export const WINDOWS_QUERY_REGISTERED_TASK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$service = New-Object -ComObject Schedule.Service",
  "$service.Connect()",
  "try {",
  "  $task = $service.GetFolder('\\').GetTask($env:T3_TASK_NAME)",
  "  $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$task.Xml)",
  "  $stdout = [Console]::OpenStandardOutput()",
  "  $stdout.Write($bytes, 0, $bytes.Length)",
  "  $stdout.Flush()",
  "} catch {",
  "  $err = $_.Exception",
  "  while ($null -ne $err.InnerException) { $err = $err.InnerException }",
  "  $hr = $err.HResult",
  "  if ($err -is [System.IO.FileNotFoundException] -or $err -is [System.IO.DirectoryNotFoundException] -or $hr -eq -2147024894 -or $hr -eq -2147024893) {",
  "    exit 2",
  "  }",
  "  throw",
  "}",
].join("; ");

const sameInstalledBaseDir = (left: string, right: string, caseInsensitive: boolean): boolean => {
  if (caseInsensitive) {
    const looksWindowsDrive = /^[A-Za-z]:[\\/]/.test(left) || /^[A-Za-z]:[\\/]/.test(right);
    const resolvePath = looksWindowsDrive ? NodePath.win32.resolve : NodePath.resolve;
    return resolvePath(left).toLowerCase() === resolvePath(right).toLowerCase();
  }
  return NodePath.resolve(left) === NodePath.resolve(right);
};

async function reloadWindowsTaskUnit(input: {
  readonly unitPath: string;
  readonly baseDir: string;
  readonly localAppData: string;
  readonly userName: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<void> {
  const taskName = resolvePersistedServiceTaskName(
    input.localAppData,
    serviceTaskName(input.env.USERDOMAIN ?? "", input.userName),
  );
  let registeredXml: string;
  try {
    const queried = await execFileAsync(
      windowsPowerShellBinary(input.env),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_QUERY_REGISTERED_TASK_SCRIPT,
      ],
      {
        env: { ...input.env, T3_TASK_NAME: taskName },
        windowsHide: true,
        timeout: 15_000,
      },
    );
    registeredXml = queried.stdout;
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 2) return;
    throw error;
  }
  const registeredBaseDir = serviceUnitBaseDirOf(registeredXml);
  if (
    registeredBaseDir === undefined ||
    !sameInstalledBaseDir(registeredBaseDir, input.baseDir, true)
  ) {
    return;
  }
  const settings = /<Settings>[\s\S]*?<\/Settings>/i.exec(registeredXml)?.[0] ?? "";
  const registeredDisabled = /<Enabled>\s*false\s*<\/Enabled>/i.test(settings);
  const unitContents = await NodeFSP.readFile(input.unitPath, "utf8");
  const unitSettings = /<Settings>[\s\S]*?<\/Settings>/i.exec(unitContents)?.[0] ?? "";
  const unitAlreadyDisabled = /<Enabled>\s*false\s*<\/Enabled>/i.test(unitSettings);
  let tempDisabledPath: string | undefined;
  try {
    let xmlPath = input.unitPath;
    if (registeredDisabled && !unitAlreadyDisabled && /<\/Settings>/i.test(unitContents)) {
      tempDisabledPath = NodePath.join(
        NodePath.dirname(input.unitPath),
        `.service-task-${process.pid}.${NodeCrypto.randomUUID()}.xml`,
      );
      await NodeFSP.writeFile(
        tempDisabledPath,
        unitContents.replace(/<\/Settings>/i, "    <Enabled>false</Enabled>\n  </Settings>"),
        { mode: 0o600 },
      );
      xmlPath = tempDisabledPath;
    }
    await execFileAsync(
      windowsSystem32Binary("schtasks.exe", input.env),
      ["/Create", "/XML", xmlPath, "/TN", taskName, "/F"],
      {
        env: input.env,
        windowsHide: true,
        timeout: 30_000,
      },
    );
  } finally {
    if (tempDisabledPath !== undefined) {
      await NodeFSP.rm(tempDisabledPath, { force: true }).catch(() => undefined);
    }
  }
}

function serviceUnitFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    readonly isWindows?: boolean | undefined;
    readonly localAppData?: string | undefined;
    readonly baseDir?: string | undefined;
  },
): ServiceUnit | undefined {
  const unitName = env[SERVICE_UNIT_ENV]?.trim();
  if (
    !unitName ||
    unitName === "." ||
    unitName === ".." ||
    unitName.includes("/") ||
    unitName.includes("\\")
  ) {
    return undefined;
  }
  if (options?.isWindows === true || unitName.endsWith(".xml")) {
    const localAppData = (options?.localAppData ?? env.LOCALAPPDATA ?? "").trim();
    const userName = (env.USERNAME ?? "").trim();
    const baseDir = (options?.baseDir ?? env.T3CODE_HOME ?? "").trim();
    if (!localAppData || !userName || !baseDir) return undefined;
    const taskFile = unitName.endsWith(".xml") ? unitName : "t3code-task.xml";
    const unitPath = NodePath.join(localAppData, "t3code", taskFile);
    return {
      path: unitPath,
      reload: () =>
        reloadWindowsTaskUnit({
          unitPath,
          baseDir,
          localAppData,
          userName,
          env,
        }),
    };
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

// systemd's ExecStart value, the plist string, or the Windows task action before __service-launcher.
// Only the version segment changes, so quoted or escaped paths stay as rendered.
// The launch agent's PATH names a versions directory without the executable; leave it.
const SERVICE_UNIT_PROGRAMS = [
  /^(ExecStart=.*?[\\/]runtime[\\/]versions[\\/])([^\\/\s"]+)([\\/]t3)(?=["\s])/m,
  /(<string>[^<]*?[\\/]runtime[\\/]versions[\\/])([^\\/<]+)([\\/]t3<\/string>\s*<string>__service-launcher<\/string>)/,
  /(<Actions\b[\s\S]*?<Arguments>--headless\s+(?:"|&quot;)[^<]*?[\\/]runtime[\\/]versions[\\/])([^\\/<"&]+)([\\/]t3(?:\.exe)?(?:"|&quot;)\s+(?:"|&quot;)?__service-launcher\b)/i,
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

const databaseBackupDir = (baseDir: string, updateId: string) => {
  if (!isValidServiceUpdateId(updateId)) {
    throw new Error(`Invalid service update identifier '${updateId}'.`);
  }
  return NodePath.join(baseDir, "runtime", "db-backup", updateId);
};

function resolvePathForContainment(baseDir: string, candidate: string) {
  const useWin32 =
    IS_WINDOWS ||
    baseDir.startsWith("\\\\") ||
    candidate.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(baseDir) ||
    /^[A-Za-z]:[\\/]/.test(candidate);
  const pathMod = useWin32 ? NodePath.win32 : NodePath.posix;
  const normalizeCase = (value: string) => (useWin32 ? value.toLowerCase() : value);
  if (!pathMod.isAbsolute(baseDir) || !pathMod.isAbsolute(candidate)) return undefined;
  const resolvedBase = normalizeCase(pathMod.resolve(baseDir));
  const resolvedCandidate = normalizeCase(pathMod.resolve(candidate));
  const rel = pathMod.relative(resolvedBase, resolvedCandidate);
  if (rel === "" || rel.startsWith("..") || pathMod.isAbsolute(rel)) return undefined;
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.includes("..")) return undefined;
  return segments;
}

function isDatabasePathInsideBaseDir(baseDir: string, dbPath: string): boolean {
  if (dbPath.includes("\0") || baseDir.includes("\0")) return false;
  const segments = resolvePathForContainment(baseDir, dbPath);
  return segments !== undefined && segments.length >= 1 && segments[0] !== "runtime";
}

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
  if (IS_WINDOWS) return NodeFSP.copyFile(source, destination);
  if (!(await runCp([source, destination]))) throw new Error(`cp ${source} failed.`);
}

const STATE_DIR_OWNED_DURING_BACKUP_CODE = "ERR_T3_STATE_DIR_OWNED_DURING_BACKUP";

const createStateDirOwnedDuringBackupError = (): NodeJS.ErrnoException => {
  const error: NodeJS.ErrnoException = new Error(
    "Another T3 Code server owns this T3 home while backing up the database.",
  );
  error.code = STATE_DIR_OWNED_DURING_BACKUP_CODE;
  return error;
};

const isStateDirOwnedDuringBackupError = (cause: unknown): boolean =>
  (cause as NodeJS.ErrnoException | undefined)?.code === STATE_DIR_OWNED_DURING_BACKUP_CODE;

async function writeLauncherServerOwnerLease(
  dbPath: string,
  pendingUpdateId: string,
): Promise<void> {
  const stateDir = NodePath.dirname(dbPath);
  await NodeFSP.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await replaceFileDurably(
    NodePath.join(stateDir, SERVER_OWNER_LEASE_FILE),
    `${JSON.stringify({ ownerId: "service-launcher", pendingUpdateId })}\n`,
  );
}

async function hasConflictingServerOwnerLease(
  dbPath: string,
  pendingUpdateId: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(
      NodePath.join(NodePath.dirname(dbPath), SERVER_OWNER_LEASE_FILE),
      "utf8",
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  try {
    const parsed = JSON.parse(raw) as { readonly pendingUpdateId?: unknown } | null;
    return (
      typeof parsed !== "object" || parsed === null || parsed.pendingUpdateId !== pendingUpdateId
    );
  } catch {
    return true;
  }
}

// Copies the main file while the server runs; an open read transaction stops SQLite resetting the WAL,
// which `finish` copies after the stop and which overrides any page the copy caught mid-checkpoint.
// `-shm` is left out: its backfill count would make SQLite trust those pages. Past the WAL size gate,
// a write-heavy server's new writes wait, uncommitted, until the server stops.
async function startOnlineDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
  probe: Partial<BackupSpaceProbe> = {},
  log: (message: string) => void = (message) => process.stderr.write(message),
): Promise<(() => Promise<void>) | undefined> {
  if (!(await isDatabaseRestoreTargetInsideBaseDir(baseDir, pending.dbPath))) {
    return undefined;
  }
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) return undefined;
  const { canClone } = { ...filesystemBackupSpaceProbe, ...probe };
  if (await canClone(pending.dbPath, NodePath.dirname(backupDir)).catch(() => true))
    return undefined;

  const stagingDir = `${backupDir}.staging`;
  const discardStaging = () =>
    NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  const fallBack = async (cause: unknown) => {
    await discardStaging();
    log(
      `[service-launcher] Copying the database while the server runs failed; backing it up offline: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return undefined;
  };
  let snapshot: NodeSqlite.DatabaseSync | undefined;
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
    const realBaseDir = await NodeFSP.realpath(baseDir).catch(() => baseDir);
    dbPath = await NodeFSP.realpath(pending.dbPath);
    if (resolvePathForContainment(realBaseDir, dbPath) === undefined) {
      throw new Error("Resolved database path escapes the T3 home.");
    }
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
    const ownerLock = tryAcquireServerOwnerLock(pending.dbPath);
    if (ownerLock === undefined) {
      release();
      await discardStaging();
      throw createStateDirOwnedDuringBackupError();
    }
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
      await writeLauncherServerOwnerLease(pending.dbPath, pending.id);
    } catch (cause) {
      release();
      await fallBack(cause);
    } finally {
      ownerLock.close();
    }
  };
}

// Preserve completed backups; restarted trials may already have changed the live database.
async function backupDatabaseOnce(baseDir: string, pending: PendingServiceUpdate): Promise<void> {
  if (!(await isDatabaseRestoreTargetInsideBaseDir(baseDir, pending.dbPath))) {
    throw new Error("Refusing to back up a database path outside the T3 home.");
  }
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) return;

  const ownerLock = tryAcquireServerOwnerLock(pending.dbPath);
  if (ownerLock === undefined) {
    throw createStateDirOwnedDuringBackupError();
  }
  const stagingDir = `${backupDir}.staging`;
  try {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true });
    await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${pending.dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      const destination = databaseBackupFile(stagingDir, suffix);
      await copyDatabaseFile(source, destination);
      await syncFile(destination);
    }
    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
    await writeLauncherServerOwnerLease(pending.dbPath, pending.id);
  } catch (cause) {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  } finally {
    ownerLock.close();
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

// Resolve symlink targets and missing leaves under symlinked ancestors.
async function restoreTarget(path: string, depth = 0): Promise<string> {
  let current = path;
  for (let hops = depth; hops < 40; hops++) {
    try {
      return await NodeFSP.realpath(current);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
    }
    const link = await NodeFSP.readlink(current).catch((cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL" || code === "ENOTDIR") return undefined;
      throw cause;
    });
    if (link !== undefined) {
      // Do not normalize .. before following directory symlinks; match filesystem resolution.
      const resolvedParent = await restoreTarget(NodePath.dirname(current), hops + 1);
      current = NodePath.isAbsolute(link) ? link : `${resolvedParent}${NodePath.sep}${link}`;
      continue;
    }
    const parent = NodePath.dirname(current);
    if (parent === current) return current;
    const resolvedParent = await restoreTarget(parent, hops + 1);
    return NodePath.join(resolvedParent, NodePath.basename(current));
  }
  throw new Error(`Too many symbolic links resolving ${path}.`);
}

async function isDatabaseRestoreTargetInsideBaseDir(
  baseDir: string,
  dbPath: string,
): Promise<boolean> {
  if (!isDatabasePathInsideBaseDir(baseDir, dbPath)) return false;
  try {
    const realBaseDir = await restoreTarget(baseDir);
    const mainTarget = await restoreTarget(dbPath);
    if (resolvePathForContainment(realBaseDir, mainTarget) === undefined) return false;
    for (const suffix of DB_FILE_SUFFIXES) {
      if (suffix === "") continue;
      for (const candidate of [`${dbPath}${suffix}`, `${mainTarget}${suffix}`]) {
        const target = await restoreTarget(candidate);
        if (resolvePathForContainment(realBaseDir, target) === undefined) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function restoreDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  if (!(await isDatabaseRestoreTargetInsideBaseDir(baseDir, pending.dbPath))) {
    throw new Error("Refusing to restore a database path outside the T3 home.");
  }
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
  const state = parseServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
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
  let resend: NodeJS.Timeout | undefined;
  if (overIpc) {
    await sendMessage(child, { type: "stop" }).catch(() => child.kill(signal));
    // A child stopped while importing its entrypoint may not have attached its IPC listener yet.
    resend = setInterval(() => {
      if (child.exitCode === null && child.signalCode === null && child.connected) {
        void sendMessage(child, { type: "stop" }).catch(() => undefined);
      }
    }, 200);
  } else {
    child.kill(signal);
  }
  const force = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await waitForExit(child);
  } finally {
    if (resend !== undefined) clearInterval(resend);
    clearTimeout(force);
  }
}

const sanitizeTaskNamePart = (value: string) => value.trim().replaceAll(/[\\/:*?"<>|]+/g, "_");

/** Task Scheduler names are machine-wide, so each Windows account runs its own collision-free task. */
export const serviceTaskName = (domain: string, userName: string) => {
  const trimmedDomain = domain.trim();
  const trimmedUser = userName.trim();
  const safeDomain = sanitizeTaskNamePart(trimmedDomain);
  const safeUser = sanitizeTaskNamePart(trimmedUser);
  const label = (safeDomain === "" ? safeUser : `${safeDomain}-${safeUser}`).slice(0, 64);
  const suffix = NodeCrypto.createHash("sha256")
    .update(`${trimmedDomain.toLowerCase()}\0${trimmedUser.toLowerCase()}`)
    .digest("hex")
    .slice(0, 8);
  return `t3code-${label}-${suffix}`;
};

const BOOT_SERVICE_TASK_NAME_FILE = "t3code-task-name";

export const isValidServiceTaskName = (value: string): boolean =>
  /^t3code-[^\r\n/\\:*?"<>|]{1,80}$/.test(value);

export const serviceTaskNamePath = (localAppData: string) =>
  NodePath.join(localAppData, "t3code", BOOT_SERVICE_TASK_NAME_FILE);

function resolvePersistedServiceTaskName(localAppData: string, fallbackTaskName: string): string {
  try {
    const persisted = NodeFS.readFileSync(serviceTaskNamePath(localAppData), "utf8").trim();
    return isValidServiceTaskName(persisted) ? persisted : fallbackTaskName;
  } catch {
    return fallbackTaskName;
  }
}

export const serviceAccountControlRoot = (localAppData: string) =>
  NodePath.join(localAppData, "t3code", "control");

/** Stored under user-private `%LOCALAPPDATA%` rather than `baseDir`, which may be shared. */
export const serviceControlDir = (
  localAppData: string,
  baseDir: string,
  options?: { readonly caseInsensitive?: boolean | undefined },
) => {
  const resolved = NodePath.resolve(baseDir);
  const normalized = (options?.caseInsensitive ?? IS_WINDOWS) ? resolved.toLowerCase() : resolved;
  const id = NodeCrypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return NodePath.join(serviceAccountControlRoot(localAppData), id);
};

export interface ControlAclHooks {
  readonly restrictPathAcl: (targetPath: string, isDirectory: boolean) => Promise<void>;
  readonly verifyPathAcl: (targetPath: string, isDirectory: boolean) => Promise<boolean>;
  readonly verifyPathsAcl?:
    | ((
        targets: ReadonlyArray<{ readonly path: string; readonly isDirectory: boolean }>,
      ) => Promise<boolean>)
    | undefined;
}

export function windowsSystem32Binary(
  name: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const systemRoot = (environment.SystemRoot ?? "").trim() || "C:\\Windows";
  return NodePath.win32.join(systemRoot, "System32", name);
}

export function windowsPowerShellBinary(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const systemRoot = (environment.SystemRoot ?? "").trim() || "C:\\Windows";
  return NodePath.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Verifies a full Windows security descriptor SDDL (`O:...D:...`) is owned by `SYSTEM`,
 * `Administrators`, or the current user SID, is protected from inheritance (`D:P`), and grants
 * access only to `SYSTEM`, `Administrators`, and the current user SID (with `OI`+`CI` on directories).
 */
export function isPrivateWindowsControlSddl(
  sddlText: string,
  userSid: string,
  options?: {
    readonly isDirectory?: boolean | undefined;
    readonly allowLocalAdminAlias?: boolean | undefined;
  },
): boolean {
  const expectedUser = userSid.trim().toUpperCase();
  if (!/^S-1-[0-9-]+$/.test(expectedUser)) return false;
  const allowLocalAdminAlias = options?.allowLocalAdminAlias === true;
  const allowedTrustees = new Set([
    "SY",
    "S-1-5-18",
    "BA",
    "S-1-5-32-544",
    expectedUser,
    ...(allowLocalAdminAlias ? ["LA"] : []),
  ]);
  const isExpectedUserTrustee = (trustee: string) =>
    trustee === expectedUser || (allowLocalAdminAlias && trustee === "LA");
  const trimmed = sddlText.replaceAll("\0", "").trim();
  if (trimmed === "") return false;
  const sections = Array.from(trimmed.matchAll(/([OGDS]):(.*?)(?=[OGDS]:|$)/gi));
  if (sections.length === 0 || sections.map((section) => section[0]).join("") !== trimmed) {
    return false;
  }
  let ownerOk = false;
  let daclOk = false;
  for (const section of sections) {
    const tag = section[1]!.toUpperCase();
    const body = section[2]!.trim();
    if (tag === "O") {
      if (ownerOk || !allowedTrustees.has(body.toUpperCase())) return false;
      ownerOk = true;
    } else if (tag === "D") {
      if (daclOk) return false;
      const match = /^([A-Z]*)((?:\([^()]+\))+)$/i.exec(body);
      if (match === null) return false;
      const flags = (match[1] ?? "").toUpperCase();
      const aceList = match[2] ?? "";
      if (!flags.includes("P")) return false;
      const aces = Array.from(aceList.matchAll(/\(([^()]+)\)/g), (aceMatch) => aceMatch[1]!);
      if (aces.length === 0) return false;
      let hasUserFullControl = false;
      for (const ace of aces) {
        const parts = ace.split(";");
        if (parts.length !== 6) return false;
        const aceType = (parts[0] ?? "").trim().toUpperCase();
        const aceFlags = (parts[1] ?? "").trim().toUpperCase();
        const rights = (parts[2] ?? "").trim().toUpperCase();
        const trustee = (parts[5] ?? "").trim().toUpperCase();
        if (aceType !== "A" || !allowedTrustees.has(trustee)) return false;
        if (isExpectedUserTrustee(trustee)) {
          if (
            options?.isDirectory === true &&
            (!aceFlags.includes("OI") || !aceFlags.includes("CI"))
          ) {
            return false;
          }
          if (rights === "FA" || rights === "GA" || rights === "0X1F01FF") {
            hasUserFullControl = true;
          }
        }
      }
      if (!hasUserFullControl) return false;
      daclOk = true;
    }
  }
  return ownerOk && daclOk;
}

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
let cachedWindowsIdentityPromise:
  | Promise<{ readonly sid: string; readonly allowLocalAdminAlias: boolean }>
  | undefined;

function readCurrentWindowsIdentity(): Promise<{
  readonly sid: string;
  readonly allowLocalAdminAlias: boolean;
}> {
  cachedWindowsIdentityPromise ??= execFileAsync(
    windowsPowerShellBinary(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $la = try { ([System.Security.Principal.SecurityIdentifier]::new('LA')).Value } catch { '' }; [Console]::Out.Write(\"$sid`n$la\")",
    ],
    {
      windowsHide: true,
      timeout: 10_000,
    },
  )
    .then(({ stdout }) => {
      const [rawSid = "", rawLocalAdminSid = ""] = stdout.split(/\r?\n/);
      const sid = rawSid.trim();
      const localAdminSid = rawLocalAdminSid.trim();
      if (!/^S-1-[0-9-]+$/i.test(sid)) {
        throw new Error("Could not resolve current Windows user SID.");
      }
      return {
        sid,
        allowLocalAdminAlias:
          localAdminSid !== "" && sid.toUpperCase() === localAdminSid.toUpperCase(),
      };
    })
    .catch((cause) => {
      cachedWindowsIdentityPromise = undefined;
      throw cause;
    });
  return cachedWindowsIdentityPromise;
}

const defaultWindowsControlAclHooks: ControlAclHooks = {
  async restrictPathAcl(targetPath, isDirectory) {
    const { sid, allowLocalAdminAlias } = await readCurrentWindowsIdentity();
    const aceFlags = isDirectory ? "OICI" : "";
    const dacl = `D:P(A;${aceFlags};FA;;;SY)(A;${aceFlags};FA;;;BA)(A;${aceFlags};FA;;;${sid})`;
    const { stdout } = await execFileAsync(
      windowsPowerShellBinary(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $acl = Get-Acl -LiteralPath $env:T3_ACL_TARGET; $acl.SetSecurityDescriptorSddlForm($env:T3_ACL_SDDL, [System.Security.AccessControl.AccessControlSections]::Access); Set-Acl -LiteralPath $env:T3_ACL_TARGET -AclObject $acl; [Console]::Out.Write((Get-Acl -LiteralPath $env:T3_ACL_TARGET).Sddl)",
      ],
      {
        env: { ...process.env, T3_ACL_TARGET: targetPath, T3_ACL_SDDL: dacl },
        windowsHide: true,
        timeout: 15_000,
      },
    );
    if (!isPrivateWindowsControlSddl(stdout, sid, { isDirectory, allowLocalAdminAlias })) {
      throw createControlRejectedError("unauthorized");
    }
  },
  async verifyPathAcl(targetPath, isDirectory) {
    const { sid, allowLocalAdminAlias } = await readCurrentWindowsIdentity();
    try {
      const { stdout } = await execFileAsync(
        windowsPowerShellBinary(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write((Get-Acl -LiteralPath $env:T3_ACL_TARGET).Sddl)",
        ],
        {
          env: { ...process.env, T3_ACL_TARGET: targetPath },
          windowsHide: true,
          timeout: 15_000,
        },
      );
      return isPrivateWindowsControlSddl(stdout, sid, { isDirectory, allowLocalAdminAlias });
    } catch {
      return false;
    }
  },
  async verifyPathsAcl(targets) {
    if (targets.length === 0) return true;
    if (targets.length === 1) {
      return defaultWindowsControlAclHooks.verifyPathAcl(targets[0]!.path, targets[0]!.isDirectory);
    }
    const { sid, allowLocalAdminAlias } = await readCurrentWindowsIdentity();
    try {
      const { stdout } = await execFileAsync(
        windowsPowerShellBinary(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $paths = @(ConvertFrom-Json -InputObject $env:T3_ACL_TARGETS); $sddls = foreach ($p in $paths) { (Get-Acl -LiteralPath ([string]$p)).Sddl }; [Console]::Out.Write(($sddls -join \"`n\"))",
        ],
        {
          env: { ...process.env, T3_ACL_TARGETS: JSON.stringify(targets.map((item) => item.path)) },
          windowsHide: true,
          timeout: 15_000,
        },
      );
      const lines = stdout.split(/\r?\n/);
      if (lines.length !== targets.length) return false;
      return targets.every((target, index) =>
        isPrivateWindowsControlSddl(lines[index] ?? "", sid, {
          isDirectory: target.isDirectory,
          allowLocalAdminAlias,
        }),
      );
    } catch {
      return false;
    }
  },
};

const resolveControlAclHooks = (override?: ControlAclHooks): ControlAclHooks | undefined =>
  override ?? (IS_WINDOWS ? defaultWindowsControlAclHooks : undefined);

const isMissingControl = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
};

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

const CONTROL_REJECTED_UNAUTHORIZED_CODE = "ERR_T3_CONTROL_UNAUTHORIZED";
const CONTROL_REJECTED_CODE = "ERR_T3_CONTROL_REJECTED";
const CONTROL_CLOSED_EARLY_CODE = "ERR_T3_CONTROL_CLOSED_EARLY";
const CONTROL_LAUNCHER_MISMATCH_CODE = "ERR_T3_CONTROL_LAUNCHER_MISMATCH";
const CONTROL_ABORTED_CODE = "ABORT_ERR";

function createControlError(message: string, code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

const createControlRejectedError = (reason: string) =>
  createControlError(
    `Service launcher rejected control request (${reason}).`,
    reason === "unauthorized" ? CONTROL_REJECTED_UNAUTHORIZED_CODE : CONTROL_REJECTED_CODE,
  );

const createControlClosedEarlyError = () =>
  createControlError(
    "Service launcher closed control connection before replying.",
    CONTROL_CLOSED_EARLY_CODE,
  );

const createControlLauncherMismatchError = () =>
  createControlError(
    "Service launcher control reply did not match the published launcher instance.",
    CONTROL_LAUNCHER_MISMATCH_CODE,
  );

const createControlAbortedError = () =>
  createControlError("Service launcher control operation was aborted.", CONTROL_ABORTED_CODE);

const isTransientControlClose = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === CONTROL_CLOSED_EARLY_CODE || code === "ECONNRESET" || code === "EPIPE";
};

export const isServiceControlUnauthorizedError = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === CONTROL_REJECTED_UNAUTHORIZED_CODE;

export const isServiceControlLauncherMismatchError = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === CONTROL_LAUNCHER_MISMATCH_CODE;

const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);
const restartPendingPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
const controlLockPath = (controlDir: string) => NodePath.join(controlDir, "lock.sqlite");
const controlTokenPath = (controlDir: string) => NodePath.join(controlDir, "control.token");
const controlEndpointPath = (controlDir: string) => NodePath.join(controlDir, "endpoint.json");

async function waitForControlDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw createControlAbortedError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createControlAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Exclusive SQLite transaction lock (`BEGIN EXCLUSIVE`), matching `server-owner.sqlite`: the OS
 * releases the file lock automatically if the holder crashes or is terminated, and the file is
 * never unlinked.
 */
function tryAcquireSqliteExclusiveLock(
  lockPath: string,
  fileMode = 0o600,
): { readonly close: () => void } | undefined {
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true, mode: 0o700 });
  if (!NodeFS.existsSync(lockPath)) {
    NodeFS.closeSync(NodeFS.openSync(lockPath, "a", fileMode));
  }
  const db = new NodeSqlite.DatabaseSync(lockPath);
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    return {
      close: () => {
        try {
          db.close();
        } catch {
          // Already closed.
        }
      },
    };
  } catch (cause) {
    try {
      db.close();
    } catch {
      // Ignore close error after failed BEGIN EXCLUSIVE.
    }
    if (isSqliteBusy(cause)) return undefined;
    throw cause;
  }
}

/** Acquires the same `server-owner.sqlite` lock held by foreground and service servers. */
function tryAcquireServerOwnerLock(dbPath: string): { readonly close: () => void } | undefined {
  return tryAcquireSqliteExclusiveLock(
    NodePath.join(NodePath.dirname(dbPath), "server-owner.sqlite"),
    0o644,
  );
}

export function probeControlLockHeld(controlDir: string): boolean {
  const lockPath = controlLockPath(controlDir);
  if (!NodeFS.existsSync(lockPath)) return false;
  const lock = tryAcquireSqliteExclusiveLock(lockPath);
  if (lock === undefined) return true;
  lock.close();
  return false;
}

async function acquireSqliteExclusiveLock(
  lockPath: string,
  options: {
    readonly timeoutMs: number;
    readonly retryMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly onRetry?: ((attempt: number) => void) | undefined;
  },
): Promise<{ readonly close: () => void }> {
  const deadline = performance.now() + Math.max(0, options.timeoutMs);
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted === true) throw createControlAbortedError();
    const lock = tryAcquireSqliteExclusiveLock(lockPath);
    if (lock !== undefined) return lock;
    options.onRetry?.(attempt);
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    await waitForControlDelay(Math.min(options.retryMs, remainingMs), options.signal);
  }
  throw new Error("Timed out waiting to acquire the service launcher control lock.");
}

async function verifyControlPathsAcl(
  targets: ReadonlyArray<{ readonly path: string; readonly isDirectory: boolean }>,
  acl?: ControlAclHooks,
): Promise<boolean> {
  if (acl === undefined || targets.length === 0) return true;
  if (acl.verifyPathsAcl !== undefined) {
    return acl.verifyPathsAcl(targets);
  }
  for (const target of targets) {
    if (!(await acl.verifyPathAcl(target.path, target.isDirectory))) return false;
  }
  return true;
}

async function ensurePrivateControlLockReady(
  directoryPath: string,
  lockFileName: string,
  acl?: ControlAclHooks,
): Promise<string> {
  await NodeFSP.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  if (acl !== undefined && !(await acl.verifyPathAcl(directoryPath, true))) {
    await acl.restrictPathAcl(directoryPath, true);
  }
  const lockPath = NodePath.join(directoryPath, lockFileName);
  if (!NodeFS.existsSync(lockPath)) {
    NodeFS.closeSync(NodeFS.openSync(lockPath, "a", 0o600));
  }
  if (acl !== undefined && !(await acl.verifyPathAcl(lockPath, false))) {
    await acl.restrictPathAcl(lockPath, false);
  }
  return lockPath;
}

async function verifyControlLockAcl(controlDir: string, acl?: ControlAclHooks): Promise<boolean> {
  if (acl === undefined || !NodeFS.existsSync(controlDir)) return true;
  const lockPath = controlLockPath(controlDir);
  return verifyControlPathsAcl(
    [
      { path: controlDir, isDirectory: true },
      ...(NodeFS.existsSync(lockPath) ? [{ path: lockPath, isDirectory: false }] : []),
    ],
    acl,
  );
}

export async function acquireServiceAccountLock(
  accountControlRoot: string,
  options: {
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly acl?: ControlAclHooks | undefined;
  } = {},
): Promise<{ readonly close: () => void }> {
  const acl = resolveControlAclHooks(options.acl);
  const lockPath = await ensurePrivateControlLockReady(
    accountControlRoot,
    "account-task.sqlite",
    acl,
  );
  return acquireSqliteExclusiveLock(lockPath, {
    timeoutMs: options.timeoutMs ?? CONTROL_MUTATION_TIMEOUT_MS,
    retryMs: 50,
    signal: options.signal,
  });
}

async function readVerifiedControlToken(
  controlDir: string,
  acl: ControlAclHooks | undefined,
  alreadyVerifiedAcl = false,
): Promise<string | undefined> {
  const targetPath = controlTokenPath(controlDir);
  if (!NodeFS.existsSync(targetPath)) return undefined;
  if (!alreadyVerifiedAcl && acl !== undefined && !(await acl.verifyPathAcl(targetPath, false))) {
    return undefined;
  }
  try {
    const token = (await NodeFSP.readFile(targetPath, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
    return token;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return undefined;
    throw cause;
  }
}

async function ensureControlToken(controlDir: string, acl?: ControlAclHooks): Promise<string> {
  await NodeFSP.mkdir(controlDir, { recursive: true, mode: 0o700 });
  if (acl !== undefined && !(await acl.verifyPathAcl(controlDir, true))) {
    await acl.restrictPathAcl(controlDir, true);
  }
  const existing = await readVerifiedControlToken(controlDir, acl);
  if (existing !== undefined) return existing;
  const targetPath = controlTokenPath(controlDir);
  const tempPath = NodePath.join(
    controlDir,
    `.control-token.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  const token = NodeCrypto.randomBytes(32).toString("hex");
  let handle: NodeFSP.FileHandle | undefined;
  try {
    // Created inside the verified `OICI` private directory before writing secret bytes.
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (acl !== undefined) {
      await acl.restrictPathAcl(tempPath, false);
    }
    try {
      await NodeFSP.rename(tempPath, targetPath);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw cause;
      await NodeFSP.rm(targetPath, { force: true });
      await NodeFSP.rename(tempPath, targetPath);
    }
    await syncDirectory(controlDir);
    if (acl !== undefined && !(await acl.verifyPathAcl(targetPath, false))) {
      throw new Error("Could not verify owner-only Windows ACL on service control token.");
    }
    return token;
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

interface ControlEndpoint {
  readonly port: number;
  readonly launcherId: string;
}

async function readControlEndpoint(controlDir: string): Promise<ControlEndpoint | undefined> {
  try {
    const raw = await NodeFSP.readFile(controlEndpointPath(controlDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { readonly port?: unknown }).port !== "number" ||
      !Number.isInteger((parsed as { readonly port: number }).port) ||
      (parsed as { readonly port: number }).port < 1 ||
      (parsed as { readonly port: number }).port > 65_535 ||
      typeof (parsed as { readonly launcherId?: unknown }).launcherId !== "string"
    ) {
      throw createControlError("Invalid service launcher control endpoint.", CONTROL_REJECTED_CODE);
    }
    return parsed as ControlEndpoint;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function writeControlEndpoint(
  controlDir: string,
  endpoint: ControlEndpoint,
  acl?: ControlAclHooks,
): Promise<void> {
  const targetPath = controlEndpointPath(controlDir);
  const tempPath = NodePath.join(
    controlDir,
    `.endpoint.${process.pid}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    await NodeFSP.writeFile(tempPath, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
    if (acl !== undefined) {
      await acl.restrictPathAcl(tempPath, false);
    }
    await NodeFSP.rename(tempPath, targetPath);
  } finally {
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

const computeControlMac = (
  token: string,
  domain: "req" | "res",
  serverNonce: string,
  clientNonce: string,
  body: string,
) =>
  NodeCrypto.createHmac("sha256", token)
    .update(`${domain}\0${serverNonce}\0${clientNonce}\0${body}`)
    .digest("hex");

function hexDigestsMatch(expectedHex: string, provided: unknown): boolean {
  if (typeof provided !== "string" || provided.length !== expectedHex.length) return false;
  const expectedBytes = Buffer.from(expectedHex, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  return (
    expectedBytes.length === providedBytes.length &&
    NodeCrypto.timingSafeEqual(expectedBytes, providedBytes)
  );
}

export type ControlStageInstallResult =
  | { readonly status: "staged"; readonly launcherId?: string }
  | { readonly status: "update-pending"; readonly installedVersion?: string }
  | { readonly status: "downgrade-refused"; readonly installedVersion: string };

type LauncherStageInstallResult = ControlStageInstallResult | { readonly status: "not-running" };

type ControlReply =
  | {
      readonly ok: true;
      readonly launcherId: string;
      readonly result?: LauncherStageInstallResult;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

/**
 * Connects over loopback TCP (`127.0.0.1`) rather than a Windows named pipe so connecting and
 * writing never expose a named-pipe security token to `ImpersonateNamedPipeClient`, and binds
 * both request and response MACs to fresh per-connection server and client nonces.
 */
async function sendControlRequestToPort(
  port: number,
  token: string | undefined,
  payload: Record<string, unknown>,
  options: {
    readonly expectedLauncherId?: string | undefined;
    readonly waitForClose?: boolean | undefined;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<ControlReply | undefined> {
  if (options.signal?.aborted === true) throw createControlAbortedError();
  if (token === undefined) throw createControlRejectedError("unauthorized");
  return new Promise((resolve, reject) => {
    let connected = false;
    let buffer = "";
    let serverNonce: string | undefined;
    let clientNonce: string | undefined;
    let reply: ControlReply | undefined;
    let failure: Error | undefined;
    const failWith = (error: Error) => {
      if (failure === undefined) failure = error;
      socket.destroy();
    };
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port }, () => {
      connected = true;
    });
    const onAbort = () => {
      failWith(createControlAbortedError());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => {
      failWith(new Error("Timed out waiting for the service launcher control channel."));
    }, options.timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (reply !== undefined || failure !== undefined) return;
      if (buffer.length + chunk.length > MAX_CONTROL_MESSAGE_BYTES) {
        failWith(new Error("Service launcher control message exceeded maximum size."));
        return;
      }
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (serverNonce === undefined) {
          try {
            const challenge = JSON.parse(line) as { readonly nonce?: unknown };
            if (typeof challenge.nonce !== "string" || !/^[0-9a-f]{32}$/.test(challenge.nonce)) {
              failWith(new Error("Service launcher sent an invalid control challenge."));
              return;
            }
            serverNonce = challenge.nonce;
            clientNonce = NodeCrypto.randomBytes(16).toString("hex");
            const body = JSON.stringify(payload);
            const mac = computeControlMac(token, "req", serverNonce, clientNonce, body);
            // Not end(): when waiting for exit, a half-close closes the socket before shutdown completes.
            socket.write(
              `${JSON.stringify({ snonce: serverNonce, cnonce: clientNonce, payload: body, mac })}\n`,
            );
          } catch (cause) {
            failWith(cause instanceof Error ? cause : new Error(String(cause)));
            return;
          }
          continue;
        }
        try {
          const envelope = JSON.parse(line) as {
            readonly body?: unknown;
            readonly mac?: unknown;
          };
          if (
            clientNonce === undefined ||
            typeof envelope.body !== "string" ||
            !hexDigestsMatch(
              computeControlMac(token, "res", serverNonce, clientNonce, envelope.body),
              envelope.mac,
            )
          ) {
            failWith(createControlRejectedError("unauthorized"));
            return;
          }
          const parsed = JSON.parse(envelope.body) as ControlReply;
          if (parsed.ok === false) {
            failWith(createControlRejectedError(parsed.error));
            return;
          }
          if (
            options.expectedLauncherId !== undefined &&
            parsed.launcherId !== options.expectedLauncherId
          ) {
            failWith(createControlLauncherMismatchError());
            return;
          }
          reply = parsed;
          if (options.waitForClose !== true) {
            clearTimeout(deadline);
            socket.destroy();
            resolve(parsed);
          }
          return;
        } catch (cause) {
          failWith(cause instanceof Error ? cause : new Error(String(cause)));
          return;
        }
      }
    });
    socket.on("error", (error) => {
      if (!connected) {
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", onAbort);
        if (failure !== undefined) reject(failure);
        else if (isMissingControl(error)) resolve(undefined);
        else reject(error);
      } else if (failure === undefined && reply === undefined) {
        failure = error;
      }
    });
    socket.once("close", () => {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      if (!connected) return;
      if (reply !== undefined) {
        resolve(reply);
      } else {
        reject(createControlClosedEarlyError());
      }
    });
  });
}

export interface ControlRequestOptions {
  readonly waitForClose?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly acl?: ControlAclHooks | undefined;
}

async function readVerifiedEndpointAndToken(
  controlDir: string,
  acl?: ControlAclHooks,
): Promise<{ readonly endpoint: ControlEndpoint; readonly token: string | undefined } | undefined> {
  const endpointPath = controlEndpointPath(controlDir);
  if (!NodeFS.existsSync(endpointPath)) return undefined;
  const tokenPath = controlTokenPath(controlDir);
  if (!NodeFS.existsSync(tokenPath)) {
    throw createControlRejectedError("unauthorized");
  }
  if (
    !(await verifyControlPathsAcl(
      [
        { path: endpointPath, isDirectory: false },
        { path: tokenPath, isDirectory: false },
      ],
      acl,
    ))
  ) {
    throw createControlRejectedError("unauthorized");
  }
  const endpoint = await readControlEndpoint(controlDir);
  if (endpoint === undefined) return undefined;
  const token = await readVerifiedControlToken(controlDir, acl, true);
  return { endpoint, token };
}

async function sendControlRequest(
  controlDir: string,
  payload: Record<string, unknown>,
  options: ControlRequestOptions & { readonly skipLockAclVerify?: boolean | undefined } = {},
): Promise<ControlReply | undefined> {
  if (options.signal?.aborted === true) throw createControlAbortedError();
  const acl = resolveControlAclHooks(options.acl);
  if (options.skipLockAclVerify !== true && !(await verifyControlLockAcl(controlDir, acl))) {
    throw createControlRejectedError("unauthorized");
  }
  if (!probeControlLockHeld(controlDir)) return undefined;
  const verified = await readVerifiedEndpointAndToken(controlDir, acl);
  if (verified === undefined) return undefined;
  const timeoutMs =
    options.timeoutMs ??
    (options.waitForClose === true
      ? CONTROL_STOP_REQUEST_TIMEOUT_MS
      : payload.type === "stage-install"
        ? CONTROL_MUTATION_TIMEOUT_MS
        : CONTROL_QUERY_TIMEOUT_MS);
  try {
    return await sendControlRequestToPort(verified.endpoint.port, verified.token, payload, {
      expectedLauncherId: verified.endpoint.launcherId,
      waitForClose: options.waitForClose,
      timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    // Home-scoped requests (`payload.launcherId === undefined`) intentionally retry once onto a
    // replacement launcher that acquired this home's lock during handoff; instance-targeted
    // `signalServiceLauncherStop` carries `launcherId`, which a replacement safely ignores.
    if (
      (!isTransientControlClose(error) && !isServiceControlLauncherMismatchError(error)) ||
      !probeControlLockHeld(controlDir)
    ) {
      throw error;
    }
    if (!(await verifyControlLockAcl(controlDir, acl))) {
      throw createControlRejectedError("unauthorized");
    }
    const retryVerified = await readVerifiedEndpointAndToken(controlDir, acl);
    if (retryVerified === undefined) return undefined;
    return sendControlRequestToPort(retryVerified.endpoint.port, retryVerified.token, payload, {
      expectedLauncherId: retryVerified.endpoint.launcherId,
      waitForClose: options.waitForClose,
      timeoutMs,
      signal: options.signal,
    });
  }
}

/** Waits until no process holds the per-home control lock. */
export async function waitForServiceLauncherRelease(
  controlDir: string,
  options: {
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly acl?: ControlAclHooks | undefined;
  } = {},
): Promise<void> {
  const acl = resolveControlAclHooks(options.acl);
  if (!(await verifyControlLockAcl(controlDir, acl))) {
    throw createControlRejectedError("unauthorized");
  }
  const timeoutMs = options.timeoutMs ?? CONTROL_MUTATION_TIMEOUT_MS;
  const deadline = performance.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (options.signal?.aborted === true) throw createControlAbortedError();
    if (!probeControlLockHeld(controlDir)) return;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    await waitForControlDelay(Math.min(50, remainingMs), options.signal);
  }
  throw new Error("Timed out waiting for the service launcher to release its control lock.");
}

/** Asks the launcher to stop and resolves once its control lock is released; false when none was running. */
export async function requestServiceLauncherStop(
  controlDir: string,
  options: Omit<ControlRequestOptions, "waitForClose"> & {
    readonly publishTimeoutMs?: number | undefined;
  } = {},
): Promise<boolean> {
  const acl = resolveControlAclHooks(options.acl);
  if (!(await verifyControlLockAcl(controlDir, acl))) {
    throw createControlRejectedError("unauthorized");
  }
  if (!probeControlLockHeld(controlDir)) return false;
  const publishDeadline = performance.now() + Math.max(0, options.publishTimeoutMs ?? 5_000);
  for (;;) {
    const reply = await sendControlRequest(
      controlDir,
      { type: "stop", wait: true },
      { ...options, acl, waitForClose: true, skipLockAclVerify: true },
    );
    if (reply !== undefined) {
      await waitForServiceLauncherRelease(controlDir, {
        timeoutMs: 5_000,
        signal: options.signal,
        acl,
      });
      return true;
    }
    if (!probeControlLockHeld(controlDir)) return true;
    const remainingMs = publishDeadline - performance.now();
    if (remainingMs <= 0) break;
    await waitForControlDelay(Math.min(50, remainingMs), options.signal);
  }
  throw new Error("Timed out waiting for the starting service launcher to publish its endpoint.");
}

/** Enqueues a graceful launcher stop without waiting for process exit; targets a specific instance when given. */
export async function signalServiceLauncherStop(
  controlDir: string,
  launcherId?: string,
  options: Omit<ControlRequestOptions, "waitForClose"> & {
    readonly uninstall?: boolean | undefined;
  } = {},
): Promise<boolean> {
  const reply = await sendControlRequest(
    controlDir,
    {
      type: "stop",
      wait: false,
      ...(launcherId === undefined ? {} : { launcherId }),
      ...(options.uninstall === true ? { uninstall: true } : {}),
    },
    options,
  );
  return reply !== undefined;
}

/** Reads the active launcher instance identifier, or undefined when none is listening. */
export async function queryServiceLauncherId(
  controlDir: string,
  options: Omit<ControlRequestOptions, "waitForClose"> = {},
): Promise<string | undefined> {
  const reply = await sendControlRequest(controlDir, { type: "identify" }, options);
  return reply?.ok === true ? reply.launcherId : undefined;
}

const STOPPED_DB_DIGEST_FILE = "stopped-db-digest.json";
const MAX_FULL_FINGERPRINT_BYTES = 64 * 1024 * 1024;
const FINGERPRINT_CHUNK_BYTES = 64 * 1024;

interface StoppedDatabaseFileFingerprint {
  readonly suffix: string;
  readonly exists: boolean;
  readonly size?: number | undefined;
  readonly mtimeNs?: string | undefined;
  readonly sha256?: string | undefined;
}

async function fingerprintDatabaseFiles(
  dbPath: string,
): Promise<ReadonlyArray<StoppedDatabaseFileFingerprint>> {
  const mainTarget = await restoreTarget(dbPath).catch(() => dbPath);
  const entries: StoppedDatabaseFileFingerprint[] = [];
  const chunk = Buffer.allocUnsafe(FINGERPRINT_CHUNK_BYTES);
  for (const suffix of DB_FILE_SUFFIXES) {
    const livePath = suffix === "" ? mainTarget : `${mainTarget}${suffix}`;
    let handle: NodeFSP.FileHandle | undefined;
    try {
      const stat = await NodeFSP.stat(livePath, { bigint: true });
      handle = await NodeFSP.open(livePath, "r");
      const size = Number(stat.size);
      const hash = NodeCrypto.createHash("sha256");
      if (size <= MAX_FULL_FINGERPRINT_BYTES) {
        let offset = 0;
        while (offset < size) {
          const toRead = Math.min(FINGERPRINT_CHUNK_BYTES, size - offset);
          const { bytesRead } = await handle.read(chunk, 0, toRead, offset);
          if (bytesRead === 0) break;
          hash.update(chunk.subarray(0, bytesRead));
          offset += bytesRead;
        }
      } else {
        const headLen = Math.min(FINGERPRINT_CHUNK_BYTES, size);
        const tailOffset = Math.max(headLen, size - FINGERPRINT_CHUNK_BYTES);
        const tailLen = Math.max(0, size - tailOffset);
        if (headLen > 0) {
          const { bytesRead } = await handle.read(chunk, 0, headLen, 0);
          hash.update(chunk.subarray(0, bytesRead));
        }
        if (tailLen > 0) {
          const { bytesRead } = await handle.read(chunk, 0, tailLen, tailOffset);
          hash.update(chunk.subarray(0, bytesRead));
        }
      }
      entries.push({
        suffix,
        exists: true,
        size,
        mtimeNs: stat.mtimeNs.toString(),
        sha256: hash.digest("hex"),
      });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        entries.push({ suffix, exists: false });
      } else {
        throw cause;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return entries;
}

async function recordStoppedPendingDatabaseFingerprint(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  if (
    !isValidServiceUpdateId(pending.id) ||
    !(await isDatabaseRestoreTargetInsideBaseDir(baseDir, pending.dbPath))
  ) {
    return;
  }
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (!(await pathExists(backupDir))) return;
  const files = await fingerprintDatabaseFiles(pending.dbPath);
  await replaceFileDurably(
    NodePath.join(backupDir, STOPPED_DB_DIGEST_FILE),
    `${JSON.stringify({ updateId: pending.id, files })}\n`,
  );
}

async function stoppedDigestMatchesCurrentDatabase(
  baseDir: string,
  pending: PendingServiceUpdate,
  options?: { readonly requireDigest?: boolean | undefined },
): Promise<boolean> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  const digestPath = NodePath.join(backupDir, STOPPED_DB_DIGEST_FILE);
  let rawDigest: string;
  try {
    rawDigest = await NodeFSP.readFile(digestPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return options?.requireDigest !== true;
    }
    return false;
  }
  try {
    const parsed = JSON.parse(rawDigest) as {
      readonly updateId?: unknown;
      readonly files?: unknown;
    } | null;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.updateId !== pending.id ||
      !Array.isArray(parsed.files)
    ) {
      return false;
    }
    const current = await fingerprintDatabaseFiles(pending.dbPath);
    return JSON.stringify(current) === JSON.stringify(parsed.files);
  } catch {
    return false;
  }
}

async function canSafelyRestoreStoppedTrialBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<boolean> {
  if (
    !isValidServiceUpdateId(pending.id) ||
    !(await isDatabaseRestoreTargetInsideBaseDir(baseDir, pending.dbPath))
  ) {
    return false;
  }
  if (await hasConflictingServerOwnerLease(pending.dbPath, pending.id)) {
    return false;
  }
  if (await databaseRestorePending(baseDir, pending)) {
    return true;
  }
  return stoppedDigestMatchesCurrentDatabase(baseDir, pending, { requireDigest: true });
}

async function acquirePendingDatabaseOwnerLock(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<{ readonly acquired: true; readonly close: () => void } | { readonly acquired: false }> {
  const ownerLockPath = NodePath.join(NodePath.dirname(pending.dbPath), "server-owner.sqlite");
  if (
    !(await pathExists(databaseBackupDir(baseDir, pending.id))) &&
    !NodeFS.existsSync(ownerLockPath)
  ) {
    return { acquired: true, close: () => undefined };
  }
  const lock = tryAcquireServerOwnerLock(pending.dbPath);
  return lock === undefined ? { acquired: false } : { acquired: true, close: lock.close };
}

/**
 * Recovers an interrupted trial update after `service uninstall` stops the launcher so releasing
 * the home to `t3 serve` or desktop mode starts from a consistent database when stop history is
 * proven clean, while preserving both copies whenever foreground work or a crash makes it ambiguous.
 */
export async function recoverServiceLauncherUninstall(input: {
  readonly baseDir: string;
  readonly controlDir?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly acl?: ControlAclHooks | undefined;
}): Promise<void> {
  const acl = resolveControlAclHooks(input.acl);
  if (input.controlDir !== undefined && !(await verifyControlLockAcl(input.controlDir, acl))) {
    throw createControlRejectedError("unauthorized");
  }
  const statePath = NodePath.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const lockHeld = input.controlDir !== undefined && probeControlLockHeld(input.controlDir);
  if (!lockHeld) {
    let initialStateText: string | undefined;
    try {
      initialStateText = await NodeFSP.readFile(statePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (parseServiceState(initialStateText)?.update?.status !== "pending") return;
  }
  const runUnderControlLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (input.controlDir === undefined) return fn();
    const lockPath = await ensurePrivateControlLockReady(input.controlDir, "lock.sqlite", acl);
    const lock = await acquireSqliteExclusiveLock(lockPath, {
      timeoutMs: input.timeoutMs ?? CONTROL_MUTATION_TIMEOUT_MS,
      retryMs: 50,
      signal: input.signal,
    });
    try {
      return await fn();
    } finally {
      lock.close();
    }
  };
  await runUnderControlLock(async () => {
    const release = await acquireServiceSelectionLock(statePath);
    try {
      let stateText: string;
      try {
        stateText = await NodeFSP.readFile(statePath, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
        throw cause;
      }
      const parsed = parseServiceState(stateText);
      if (parsed?.update?.status !== "pending") return;
      const pending = parsed.update;
      const validTarget =
        isValidServiceUpdateId(pending.id) &&
        (await isDatabaseRestoreTargetInsideBaseDir(input.baseDir, pending.dbPath));
      if (!validTarget) {
        await writeServiceState(statePath, {
          ...parsed,
          activeVersion: pending.fromVersion,
          update: terminalUpdate({ pending, status: "failed", reason: "service-uninstalled" }),
        });
        await NodeFSP.rm(stopMarkerPath(input.baseDir), { force: true }).catch(() => undefined);
        return;
      }
      const serverOwnerLock = await acquirePendingDatabaseOwnerLock(input.baseDir, pending);
      if (!serverOwnerLock.acquired) {
        await writeServiceState(statePath, {
          ...parsed,
          activeVersion: pending.fromVersion,
          update: terminalUpdate({ pending, status: "failed", reason: "state-dir-owned" }),
        });
        return;
      }
      try {
        const hasBackup = await pathExists(databaseBackupDir(input.baseDir, pending.id));
        const restored =
          hasBackup && (await canSafelyRestoreStoppedTrialBackup(input.baseDir, pending));
        if (restored) {
          await restoreDatabaseBackup(input.baseDir, pending);
        }
        await writeServiceState(statePath, {
          ...parsed,
          activeVersion: pending.fromVersion,
          update: terminalUpdate({ pending, status: "failed", reason: "service-uninstalled" }),
        });
        await NodeFSP.rm(stopMarkerPath(input.baseDir), { force: true }).catch(() => undefined);
        if (restored) {
          await discardDatabaseBackup(input.baseDir, pending.id).catch(() => undefined);
        }
      } finally {
        serverOwnerLock.close();
      }
    } finally {
      release();
    }
  });
}

function throwIfControlAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw createControlAbortedError();
}

async function restorePreviousRestartPending(
  targetPath: string,
  previousContents: string | undefined,
): Promise<void> {
  if (previousContents === undefined) {
    await NodeFSP.rm(targetPath, { force: true }).catch(() => undefined);
  } else {
    await NodeFSP.writeFile(targetPath, previousContents, { mode: 0o600 }).catch(() => undefined);
  }
}

async function stageOfflineInstall(
  baseDir: string,
  version: string,
  allowDowngrade: boolean,
  signal?: AbortSignal,
): Promise<ControlStageInstallResult> {
  const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
  const release = await acquireServiceSelectionLock(statePath);
  try {
    let previousStateText: string | undefined;
    try {
      previousStateText = await NodeFSP.readFile(statePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    if (previousStateText !== undefined) {
      const installedVersion = serviceStateActiveVersion(previousStateText);
      if (serviceStateHasPendingUpdate(previousStateText)) {
        return {
          status: "update-pending",
          ...(installedVersion === undefined ? {} : { installedVersion }),
        };
      }
      if (
        installedVersion !== undefined &&
        !allowDowngrade &&
        compareExactServiceVersions(version, installedVersion) < 0
      ) {
        return { status: "downgrade-refused", installedVersion };
      }
    }
    const restartPending = restartPendingPath(baseDir);
    const previousRestartPending = await NodeFSP.readFile(restartPending, "utf8").catch(
      () => undefined,
    );
    await NodeFSP.mkdir(NodePath.join(baseDir, "runtime"), { recursive: true, mode: 0o700 });
    throwIfControlAborted(signal);
    await NodeFSP.writeFile(restartPending, `${version}\n`, { mode: 0o600 });
    if (signal?.aborted === true) {
      await restorePreviousRestartPending(restartPending, previousRestartPending);
      throw createControlAbortedError();
    }
    await writeServiceState(statePath, {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: version,
    });
    return { status: "staged" };
  } finally {
    release();
  }
}

/**
 * Atomically checks and stages a CLI service install through the running launcher's transition
 * queue, or while holding the per-home SQLite control lock when no launcher is running.
 */
export async function stageServiceLauncherInstall(input: {
  readonly controlDir: string;
  readonly baseDir: string;
  readonly version: string;
  readonly allowDowngrade?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly acl?: ControlAclHooks | undefined;
}): Promise<ControlStageInstallResult> {
  if (!isExactServiceVersion(input.version)) {
    throw new Error(`Invalid target service version '${input.version}'.`);
  }
  const allowDowngrade = input.allowDowngrade === true;
  const acl = resolveControlAclHooks(input.acl);
  const timeoutMs = input.timeoutMs ?? CONTROL_MUTATION_TIMEOUT_MS;
  const deadline = performance.now() + Math.max(0, timeoutMs);
  const lockPath = await ensurePrivateControlLockReady(input.controlDir, "lock.sqlite", acl);
  for (;;) {
    if (input.signal?.aborted === true) throw createControlAbortedError();
    const lock = tryAcquireSqliteExclusiveLock(lockPath);
    if (lock !== undefined) {
      try {
        await NodeFSP.rm(controlEndpointPath(input.controlDir), { force: true }).catch(
          () => undefined,
        );
        return await stageOfflineInstall(
          input.baseDir,
          input.version,
          allowDowngrade,
          input.signal,
        );
      } finally {
        lock.close();
      }
    }
    const remainingBeforeSendMs = deadline - performance.now();
    if (remainingBeforeSendMs <= 0) break;
    let reply: ControlReply | undefined;
    try {
      reply = await sendControlRequest(
        input.controlDir,
        {
          type: "stage-install",
          version: input.version,
          allowDowngrade,
        },
        {
          timeoutMs: remainingBeforeSendMs,
          signal: input.signal,
          acl,
          skipLockAclVerify: true,
        },
      );
    } catch (error) {
      if (!isTransientControlClose(error) && !isMissingControl(error)) throw error;
      const remainingAfterErrorMs = deadline - performance.now();
      if (remainingAfterErrorMs <= 0) break;
      await waitForControlDelay(Math.min(50, remainingAfterErrorMs), input.signal);
      continue;
    }
    if (reply?.ok === true && reply.result !== undefined && reply.result.status !== "not-running") {
      return reply.result;
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    await waitForControlDelay(Math.min(50, remainingMs), input.signal);
  }
  throw new Error("Timed out acquiring service launcher control lock to stage install.");
}

export type ServiceLauncherProbeStatus = "running" | "unhealthy" | "stopped";

/**
 * Distinguishes an authenticated running launcher (`"running"`), a stopped launcher (`"stopped"`),
 * and an occupied or unauthenticated control lock (`"unhealthy"`).
 */
export async function probeServiceLauncher(
  controlDir: string,
  options: {
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly acl?: ControlAclHooks | undefined;
  } = {},
): Promise<ServiceLauncherProbeStatus> {
  const acl = resolveControlAclHooks(options.acl);
  try {
    if (!(await verifyControlLockAcl(controlDir, acl))) return "unhealthy";
  } catch {
    return "unhealthy";
  }
  const deadline = performance.now() + Math.max(0, options.timeoutMs ?? 1_500);
  for (;;) {
    let lockHeld: boolean;
    try {
      lockHeld = probeControlLockHeld(controlDir);
    } catch {
      return "unhealthy";
    }
    if (!lockHeld) return "stopped";
    try {
      const reply = await sendControlRequest(
        controlDir,
        { type: "identify" },
        {
          timeoutMs: Math.min(
            CONTROL_QUERY_TIMEOUT_MS,
            Math.max(250, deadline - performance.now()),
          ),
          signal: options.signal,
          acl,
          skipLockAclVerify: true,
        },
      );
      if (reply?.ok === true && reply.launcherId !== undefined) return "running";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === CONTROL_ABORTED_CODE) throw error;
      try {
        return probeControlLockHeld(controlDir) ? "unhealthy" : "stopped";
      } catch {
        return "unhealthy";
      }
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    await waitForControlDelay(Math.min(100, remainingMs), options.signal);
  }
  try {
    return probeControlLockHeld(controlDir) ? "unhealthy" : "stopped";
  } catch {
    return "unhealthy";
  }
}

export class Launcher {
  readonly #instanceId = NodeCrypto.randomUUID();
  readonly #baseDir: string;
  readonly #statePath: string;
  #state: ServiceState;
  #child: ManagedChild | null = null;
  #managedPendingTrialId: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopping = false;
  #uninstalling = false;
  #done = false;
  #ownsControl: boolean;
  readonly #stopAbort = new AbortController();
  readonly #completion = Promise.withResolvers<void>();
  readonly #backupSpaceProbe: Partial<BackupSpaceProbe> | undefined;
  readonly #serviceUnit: ServiceUnit | undefined;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #output: number | undefined;
  readonly #controlDir: string | undefined;
  readonly #controlListenRetryMs: number;
  readonly #acl: ControlAclHooks | undefined;
  readonly #onControlAcquired: (() => void) | undefined;
  readonly #onControlRetry: ((attempt: number) => void) | undefined;
  readonly #onControlStageQueued:
    | ((info: { readonly version: string; readonly disconnected: Promise<void> }) => void)
    | undefined;
  readonly #onFatalControlOwnerExit: ((error: unknown) => void) | undefined;
  readonly #stopChildOverIpc: boolean;
  readonly #spawnCommand: (entryPath: string) => {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  };

  constructor(
    baseDir: string,
    state: ServiceState,
    options: {
      readonly backupSpaceProbe?: Partial<BackupSpaceProbe>;
      readonly serviceUnit?: ServiceUnit;
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      /** Launcher and server output, for managers that cannot redirect it. */
      readonly output?: number;
      /** Account-private directory holding the SQLite lock, token, and loopback TCP endpoint. */
      readonly controlDir?: string;
      readonly controlListenRetryMs?: number;
      readonly acl?: ControlAclHooks;
      readonly onControlAcquired?: () => void;
      readonly onControlRetry?: (attempt: number) => void;
      readonly onControlStageQueued?: (info: {
        readonly version: string;
        readonly disconnected: Promise<void>;
      }) => void;
      /** Invoked while still holding the control lock when the active launcher fails fatally. */
      readonly onFatalControlOwnerExit?: (error: unknown) => void;
      /** Windows `kill()` is TerminateProcess, which skips the server's shutdown finalizers. */
      readonly stopChildOverIpc?: boolean;
      readonly spawnCommand?: (entryPath: string) => {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
    } = {},
  ) {
    this.#baseDir = baseDir;
    this.#backupSpaceProbe = options.backupSpaceProbe;
    this.#serviceUnit = options.serviceUnit;
    this.#environment = { ...(options.environment ?? process.env) };
    this.#output = options.output;
    this.#controlDir = options.controlDir;
    this.#controlListenRetryMs = options.controlListenRetryMs ?? CONTROL_LISTEN_RETRY_MS;
    this.#acl = resolveControlAclHooks(options.acl);
    this.#onControlAcquired = options.onControlAcquired;
    this.#onControlRetry = options.onControlRetry;
    this.#onControlStageQueued = options.onControlStageQueued;
    this.#onFatalControlOwnerExit = options.onFatalControlOwnerExit;
    this.#ownsControl = options.controlDir === undefined;
    this.#stopChildOverIpc = options.stopChildOverIpc ?? IS_WINDOWS;
    this.#spawnCommand = options.spawnCommand ?? runtimeSpawnArguments;
    this.#statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    this.#state = state;
  }

  get ownsControl(): boolean {
    return this.#ownsControl;
  }

  async run(): Promise<void> {
    const onSigterm = () => void this.stop("SIGTERM");
    const onSigint = () => void this.stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    try {
      const control =
        this.#controlDir === undefined
          ? undefined
          : await this.#listenForControl(
              this.#controlDir,
              (publishReady, didPublish) => {
                // Enqueued before `endpoint.json` is written so any request arriving on the newly
                // published loopback port runs strictly after persisted state reload + recovery.
                this.#enqueue(async () => {
                  await publishReady;
                  if (!didPublish() || this.#stopRequested) return;
                  this.#state = await readServiceState(this.#statePath);
                  await this.#recover();
                });
              },
              () => this.#onControlAcquired?.(),
            );
      try {
        if (this.#controlDir === undefined && !this.#stopRequested) {
          this.#enqueue(() => this.#recover());
        }
        await this.#completion.promise;
      } catch (error) {
        if (this.#ownsControl) {
          try {
            this.#onFatalControlOwnerExit?.(error);
          } catch {
            // Crash cleanup must not mask the original launcher failure.
          }
        }
        throw error;
      } finally {
        await control?.close();
      }
    } finally {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    }
  }

  /** Acquires the per-home SQLite lock, verifies the private token, and binds a loopback port once. */
  async #listenForControl(
    controlDir: string,
    beforePublish: (publishReady: Promise<void>, didPublish: () => boolean) => void,
    onPublished: () => void,
  ): Promise<{ readonly close: () => Promise<void> } | undefined> {
    if (this.#stopRequested) return undefined;
    const lockPath = await ensurePrivateControlLockReady(controlDir, "lock.sqlite", this.#acl);
    let lock: { readonly close: () => void };
    try {
      lock = await acquireSqliteExclusiveLock(lockPath, {
        timeoutMs: CONTROL_LISTEN_ATTEMPTS * this.#controlListenRetryMs,
        retryMs: this.#controlListenRetryMs,
        signal: this.#stopAbort.signal,
        onRetry: this.#onControlRetry,
      });
    } catch (error) {
      if (this.#stopRequested && (error as NodeJS.ErrnoException).code === CONTROL_ABORTED_CODE) {
        return undefined;
      }
      throw error;
    }
    if (this.#stopRequested) {
      lock.close();
      return undefined;
    }
    const sockets = new Set<NodeNet.Socket>();
    const unauthenticatedSockets = new Set<NodeNet.Socket>();
    let server: NodeNet.Server | undefined;
    try {
      NodeFS.rmSync(controlEndpointPath(controlDir), { force: true });
      const controlToken = await ensureControlToken(controlDir, this.#acl);
      server = NodeNet.createServer((socket) => {
        if (unauthenticatedSockets.size >= MAX_UNAUTHENTICATED_CONTROL_SOCKETS) {
          const oldest = unauthenticatedSockets.values().next().value;
          oldest?.destroy();
        }
        if (sockets.size >= MAX_TOTAL_CONTROL_SOCKETS) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        unauthenticatedSockets.add(socket);
        const handshakeDeadline = setTimeout(() => {
          socket.destroy();
        }, CONTROL_HANDSHAKE_TIMEOUT_MS);
        handshakeDeadline.unref();
        const markAuthenticated = () => {
          clearTimeout(handshakeDeadline);
          unauthenticatedSockets.delete(socket);
        };
        socket.once("close", () => {
          clearTimeout(handshakeDeadline);
          unauthenticatedSockets.delete(socket);
          sockets.delete(socket);
        });
        socket.on("error", () => undefined);
        socket.setEncoding("utf8");
        const serverNonce = NodeCrypto.randomBytes(16).toString("hex");
        let buffer = "";
        let handled = false;
        socket.on("data", (chunk: string) => {
          if (handled) return;
          if (buffer.length + chunk.length > MAX_CONTROL_MESSAGE_BYTES) {
            socket.destroy();
            return;
          }
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          handled = true;
          const line = buffer.slice(0, newline);
          buffer = "";
          void this.#handleControlLine(socket, controlToken, serverNonce, line, markAuthenticated);
        });
        socket.write(`${JSON.stringify({ nonce: serverNonce })}\n`);
      });
      const activeServer = server;
      await new Promise<void>((resolve, reject) => {
        activeServer.once("error", reject);
        activeServer.listen(0, "127.0.0.1", () => {
          activeServer.off("error", reject);
          resolve();
        });
      });
      activeServer.on("error", () => undefined);
      const address = activeServer.address();
      if (address === null || typeof address !== "object") {
        throw new Error("Could not resolve loopback control port.");
      }
      let published = false;
      const publishGate = Promise.withResolvers<void>();
      this.#ownsControl = true;
      beforePublish(publishGate.promise, () => published);
      try {
        await writeControlEndpoint(
          controlDir,
          {
            port: address.port,
            launcherId: this.#instanceId,
          },
          this.#acl,
        );
        published = true;
      } finally {
        publishGate.resolve();
      }
      if (!this.#stopRequested) {
        onPublished();
      }
      return {
        close: async () => {
          await NodeFSP.rm(controlEndpointPath(controlDir), { force: true }).catch(() => undefined);
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => activeServer.close(() => resolve()));
          this.#ownsControl = false;
          lock.close();
        },
      };
    } catch (cause) {
      this.#ownsControl = false;
      await NodeFSP.rm(controlEndpointPath(controlDir), { force: true }).catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      if (server !== undefined) {
        const closingServer = server;
        await new Promise<void>((resolve) => closingServer.close(() => resolve()));
      }
      lock.close();
      throw cause;
    }
  }

  async #handleControlLine(
    socket: NodeNet.Socket,
    controlToken: string,
    serverNonce: string,
    line: string,
    markAuthenticated: () => void,
  ): Promise<void> {
    const sendSigned = (reply: ControlReply, closeAfterWrite: boolean, macClientNonce: string) => {
      const body = JSON.stringify(reply);
      const mac = computeControlMac(controlToken, "res", serverNonce, macClientNonce, body);
      const wire = `${JSON.stringify({ ok: reply.ok, body, mac })}\n`;
      if (closeAfterWrite) socket.end(wire);
      else socket.write(wire);
    };
    let providedServerNonce: string;
    let clientNonce: string;
    let payloadBody: string;
    let providedMac: unknown;
    try {
      const envelope: unknown = JSON.parse(line);
      if (
        typeof envelope !== "object" ||
        envelope === null ||
        Array.isArray(envelope) ||
        typeof (envelope as { readonly snonce?: unknown }).snonce !== "string" ||
        typeof (envelope as { readonly cnonce?: unknown }).cnonce !== "string" ||
        !/^[0-9a-f]{32}$/.test((envelope as { readonly cnonce: string }).cnonce) ||
        typeof (envelope as { readonly payload?: unknown }).payload !== "string"
      ) {
        sendSigned({ ok: false, error: "invalid-request" }, true, "");
        return;
      }
      providedServerNonce = (envelope as { readonly snonce: string }).snonce;
      clientNonce = (envelope as { readonly cnonce: string }).cnonce;
      payloadBody = (envelope as { readonly payload: string }).payload;
      providedMac = (envelope as { readonly mac?: unknown }).mac;
    } catch {
      sendSigned({ ok: false, error: "invalid-json" }, true, "");
      return;
    }
    if (
      providedServerNonce !== serverNonce ||
      !hexDigestsMatch(
        computeControlMac(controlToken, "req", serverNonce, clientNonce, payloadBody),
        providedMac,
      )
    ) {
      sendSigned({ ok: false, error: "unauthorized" }, true, clientNonce);
      return;
    }
    let request: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payloadBody);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        sendSigned({ ok: false, error: "invalid-request" }, true, clientNonce);
        return;
      }
      request = parsed as Record<string, unknown>;
    } catch {
      sendSigned({ ok: false, error: "invalid-json" }, true, clientNonce);
      return;
    }
    markAuthenticated();
    if (request.type === "identify") {
      sendSigned({ ok: true, launcherId: this.#instanceId }, true, clientNonce);
      return;
    }
    if (request.type === "stop") {
      const targeted = typeof request.launcherId === "string" ? request.launcherId : undefined;
      if (targeted !== undefined && targeted !== this.#instanceId) {
        sendSigned({ ok: true, launcherId: this.#instanceId }, true, clientNonce);
        return;
      }
      if (request.uninstall === true) {
        this.#uninstalling = true;
      }
      if (request.wait === true) {
        sendSigned({ ok: true, launcherId: this.#instanceId }, false, clientNonce);
        void this.stop("SIGTERM");
        return;
      }
      void this.stop("SIGTERM");
      sendSigned({ ok: true, launcherId: this.#instanceId }, true, clientNonce);
      return;
    }
    if (request.type === "stage-install" && typeof request.version === "string") {
      const version = request.version;
      const allowDowngrade = request.allowDowngrade === true;
      let clientDisconnected = socket.destroyed;
      const disconnected = Promise.withResolvers<void>();
      if (clientDisconnected) {
        disconnected.resolve();
      } else {
        socket.once("close", () => {
          clientDisconnected = true;
          disconnected.resolve();
        });
      }
      const isClientDisconnected = () => clientDisconnected || socket.destroyed;
      const outcome = Promise.withResolvers<LauncherStageInstallResult | undefined>();
      this.#enqueue(async () => {
        if (isClientDisconnected()) {
          outcome.resolve(undefined);
          return;
        }
        try {
          outcome.resolve(await this.#stageInstall(version, allowDowngrade, isClientDisconnected));
        } catch (cause) {
          outcome.reject(cause);
        }
      });
      this.#onControlStageQueued?.({ version, disconnected: disconnected.promise });
      try {
        const result = await outcome.promise;
        if (result !== undefined && !isClientDisconnected()) {
          sendSigned({ ok: true, launcherId: this.#instanceId, result }, true, clientNonce);
        }
      } catch {
        if (!isClientDisconnected()) {
          sendSigned({ ok: false, error: "stage-failed" }, true, clientNonce);
        }
      }
      return;
    }
    sendSigned({ ok: false, error: "unknown-command" }, true, clientNonce);
  }

  async #stageInstall(
    version: string,
    allowDowngrade: boolean,
    isClientDisconnected: () => boolean,
  ): Promise<LauncherStageInstallResult | undefined> {
    if (!isExactServiceVersion(version)) {
      throw new Error(`Invalid target service version '${version}'.`);
    }
    if (this.#stopping || this.#done) {
      return { status: "not-running" };
    }
    const release = await acquireServiceSelectionLock(this.#statePath);
    try {
      let previousStateText: string | undefined;
      try {
        previousStateText = await NodeFSP.readFile(this.#statePath, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      const diskVersion =
        previousStateText === undefined ? undefined : serviceStateActiveVersion(previousStateText);
      const effectiveVersion = diskVersion ?? this.#state.activeVersion;
      if (
        this.#state.update?.status === "pending" ||
        (previousStateText !== undefined && serviceStateHasPendingUpdate(previousStateText))
      ) {
        return {
          status: "update-pending",
          ...(effectiveVersion === undefined ? {} : { installedVersion: effectiveVersion }),
        };
      }
      if (!allowDowngrade && compareExactServiceVersions(version, effectiveVersion) < 0) {
        return { status: "downgrade-refused", installedVersion: effectiveVersion };
      }
      const next: ServiceState = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: version,
      };
      const restartPending = restartPendingPath(this.#baseDir);
      const previousRestartPending = await NodeFSP.readFile(restartPending, "utf8").catch(
        () => undefined,
      );
      await NodeFSP.mkdir(NodePath.join(this.#baseDir, "runtime"), {
        recursive: true,
        mode: 0o700,
      });
      if (isClientDisconnected()) return undefined;
      await NodeFSP.writeFile(restartPending, `${version}\n`, { mode: 0o600 });
      if (isClientDisconnected()) {
        await restorePreviousRestartPending(restartPending, previousRestartPending);
        return undefined;
      }
      await writeServiceState(this.#statePath, next);
      return { status: "staged", launcherId: this.#instanceId };
    } finally {
      release();
    }
  }

  #terminate(child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
    return terminateChild(child, signal, this.#stopChildOverIpc);
  }

  #log(line: string): void {
    try {
      if (this.#output === undefined) process.stderr.write(line);
      else NodeFS.writeSync(this.#output, line);
    } catch {
      // Log write failures must not terminate a running launcher.
    }
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

  async #assertSelectionMatchesState(): Promise<void> {
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
  }

  async #recoverPendingUpdateOnUninstall(pending: PendingServiceUpdate): Promise<void> {
    const managedByThisLauncher = this.#managedPendingTrialId === pending.id;
    this.#managedPendingTrialId = undefined;
    const release = await acquireServiceSelectionLock(this.#statePath);
    try {
      await this.#assertSelectionMatchesState();
      const validTarget =
        isValidServiceUpdateId(pending.id) &&
        (await isDatabaseRestoreTargetInsideBaseDir(this.#baseDir, pending.dbPath));
      if (!validTarget) {
        const next: ServiceState = {
          ...this.#state,
          activeVersion: pending.fromVersion,
          update: terminalUpdate({ pending, status: "failed", reason: "service-uninstalled" }),
        };
        await writeServiceState(this.#statePath, next);
        this.#state = next;
        await NodeFSP.rm(stopMarkerPath(this.#baseDir), { force: true }).catch(() => undefined);
        return;
      }
      const serverOwnerLock = await acquirePendingDatabaseOwnerLock(this.#baseDir, pending);
      if (!serverOwnerLock.acquired) {
        const next: ServiceState = {
          ...this.#state,
          activeVersion: pending.fromVersion,
          update: terminalUpdate({ pending, status: "failed", reason: "state-dir-owned" }),
        };
        await writeServiceState(this.#statePath, next);
        this.#state = next;
        return;
      }
      try {
        const hasBackup = await pathExists(databaseBackupDir(this.#baseDir, pending.id));
        const restored =
          hasBackup &&
          (managedByThisLauncher
            ? !(await hasConflictingServerOwnerLease(pending.dbPath, pending.id))
            : await canSafelyRestoreStoppedTrialBackup(this.#baseDir, pending));
        if (restored) {
          await restoreDatabaseBackup(this.#baseDir, pending);
        }
        const next: ServiceState = {
          ...this.#state,
          activeVersion: pending.fromVersion,
          update: terminalUpdate({ pending, status: "failed", reason: "service-uninstalled" }),
        };
        await writeServiceState(this.#statePath, next);
        this.#state = next;
        await NodeFSP.rm(stopMarkerPath(this.#baseDir), { force: true }).catch(() => undefined);
        if (restored) {
          await discardDatabaseBackup(this.#baseDir, pending.id).catch(() => undefined);
        }
      } finally {
        serverOwnerLock.close();
      }
    } finally {
      release();
    }
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    // Only the lock owner writes the stop marker; a waiting replacement must not mark the active server's home.
    if (this.#ownsControl) {
      // Write synchronously on signal receipt; a terminating child needs the marker in its finalizer.
      try {
        NodeFS.writeFileSync(stopMarkerPath(this.#baseDir), "", { mode: 0o600 });
      } catch {}
    }
    this.#stopAbort.abort();
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
      if (this.#ownsControl) {
        const pending = this.#state.update?.status === "pending" ? this.#state.update : undefined;
        if (this.#uninstalling && pending !== undefined) {
          await this.#recoverPendingUpdateOnUninstall(pending);
        } else if (pending !== undefined) {
          const validTarget =
            isValidServiceUpdateId(pending.id) &&
            (await isDatabaseRestoreTargetInsideBaseDir(this.#baseDir, pending.dbPath));
          const serverOwnerLock = validTarget
            ? await acquirePendingDatabaseOwnerLock(this.#baseDir, pending)
            : { acquired: false as const };
          try {
            NodeFS.writeFileSync(stopMarkerPath(this.#baseDir), "", { mode: 0o600 });
          } catch {}
          if (serverOwnerLock.acquired) {
            try {
              if (!(await hasConflictingServerOwnerLease(pending.dbPath, pending.id))) {
                await recordStoppedPendingDatabaseFingerprint(this.#baseDir, pending).catch(
                  () => undefined,
                );
              }
            } finally {
              serverOwnerLock.close();
            }
          }
        } else {
          try {
            NodeFS.writeFileSync(stopMarkerPath(this.#baseDir), "", { mode: 0o600 });
          } catch {}
        }
      }
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
      await this.#assertSelectionMatchesState();
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
      this.#log(
        `[service-launcher] Could not clear ${restartPending}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    const update = this.#state.update;
    if (update?.status !== "pending") {
      if (update?.status === "committed" && isValidServiceUpdateId(update.id)) {
        await discardDatabaseBackup(this.#baseDir, update.id).catch(() => undefined);
      }
      try {
        await this.#startChild(this.#state.activeVersion, "active", update);
      } finally {
        if (update !== undefined) await this.#repointServiceUnit(this.#state.activeVersion);
      }
      return;
    }
    if (!isValidServiceUpdateId(update.id)) {
      await this.#returnToPrevious(update, "failed", "invalid-update", undefined, {
        startupRecovery: true,
      });
      return;
    }
    if (await databaseRestorePending(this.#baseDir, update)) {
      await this.#returnToPrevious(update, "failed", "rollback-interrupted", undefined, {
        startupRecovery: true,
      });
      return;
    }
    if (!(await runtimeExists(this.#baseDir, update.targetVersion))) {
      await this.#returnToPrevious(update, "failed", "target-runtime-missing", undefined, {
        startupRecovery: true,
      });
      return;
    }
    await this.#startTrial(update);
  }

  async #startTrial(pending: PendingServiceUpdate): Promise<void> {
    if (
      !isValidServiceUpdateId(pending.id) ||
      !(await isDatabaseRestoreTargetInsideBaseDir(this.#baseDir, pending.dbPath))
    ) {
      await this.#returnToPrevious(pending, "failed", "db-backup-failed");
      return;
    }
    const existingBackup = await pathExists(databaseBackupDir(this.#baseDir, pending.id));
    if (existingBackup && this.#managedPendingTrialId !== pending.id) {
      if (
        (await hasConflictingServerOwnerLease(pending.dbPath, pending.id)) ||
        !(await stoppedDigestMatchesCurrentDatabase(this.#baseDir, pending))
      ) {
        await this.#returnToPrevious(pending, "failed", "live-db-modified", undefined, {
          startupRecovery: true,
        });
        return;
      }
    }
    try {
      await backupDatabaseOnce(this.#baseDir, pending);
    } catch (cause) {
      if (isStateDirOwnedDuringBackupError(cause)) {
        await this.#idleWhileStateDirOwned();
        return;
      }
      await this.#returnToPrevious(pending, "failed", "db-backup-failed");
      return;
    }
    this.#managedPendingTrialId = pending.id;
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
    const spawnArguments = this.#spawnCommand(paths.entryPath);
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
    if (
      !NodePath.isAbsolute(message.dbPath) ||
      !isDatabasePathInsideBaseDir(this.#baseDir, message.dbPath)
    ) {
      await reject("The requested database path must be inside the T3 home.");
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
    this.#managedPendingTrialId = pending.id;
    // Anything thrown outside its own fallback still leaves the offline backup to run.
    const finishOnlineBackup = await startOnlineDatabaseBackup(
      this.#baseDir,
      pending,
      this.#backupSpaceProbe,
      (message) => this.#log(message),
    ).catch(() => undefined);
    this.#child = null;
    await this.#terminate(child.process);
    try {
      await finishOnlineBackup?.();
    } catch (cause) {
      if (isStateDirOwnedDuringBackupError(cause)) {
        await this.#idleWhileStateDirOwned();
        return;
      }
      throw cause;
    }
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
    this.#managedPendingTrialId = undefined;
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
          !sameInstalledBaseDir(
            installedBaseDir,
            this.#baseDir,
            IS_WINDOWS || unit.path.endsWith(".xml"),
          )
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
      this.#log(
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

  #enterOwnedStateDirIdle(): void {
    // Signal listeners alone do not keep Node alive.
    this.#timer = setInterval(() => {}, 2_147_483_647);
    this.#log(
      "[service-launcher] Another T3 Code server owns this T3 home. Stop it, then restart this service.\n",
    );
  }

  // Stay idle to avoid supervisor restart loops; preserve backups rather than overwriting or discarding data.
  async #idleWhileStateDirOwned(): Promise<void> {
    this.#clearTimer();
    this.#managedPendingTrialId = undefined;
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      const next: ServiceState = {
        ...this.#state,
        activeVersion: pending.fromVersion,
        update: terminalUpdate({ pending, status: "failed", reason: "state-dir-owned" }),
      };
      await this.#selectState(next);
      await this.#repointServiceUnit(next.activeVersion);
    }
    this.#enterOwnedStateDirIdle();
  }

  async #returnToPrevious(
    pending: PendingServiceUpdate,
    status: "rolled-back" | "failed",
    reason: string,
    child?: ManagedChild,
    options?: { readonly startupRecovery?: boolean | undefined },
  ): Promise<void> {
    const managedByThisLauncher =
      this.#managedPendingTrialId === pending.id && options?.startupRecovery !== true;
    this.#managedPendingTrialId = undefined;
    if (child !== undefined) {
      this.#child = null;
      await this.#terminate(child.process);
    }
    const release = await acquireServiceSelectionLock(this.#statePath);
    let enteredOwnedIdle = false;
    let next: ServiceState;
    let outcome: Exclude<ServiceUpdateRecord, PendingServiceUpdate>;
    let restored = false;
    try {
      await this.#assertSelectionMatchesState();
      const validTarget =
        isValidServiceUpdateId(pending.id) &&
        (await isDatabaseRestoreTargetInsideBaseDir(this.#baseDir, pending.dbPath));
      const serverOwnerLock = validTarget
        ? await acquirePendingDatabaseOwnerLock(this.#baseDir, pending)
        : { acquired: true as const, close: () => undefined };
      if (!serverOwnerLock.acquired) {
        outcome = terminalUpdate({ pending, status: "failed", reason: "state-dir-owned" });
        next = {
          ...this.#state,
          activeVersion: pending.fromVersion,
          update: outcome,
        };
        await writeServiceState(this.#statePath, next);
        this.#state = next;
        enteredOwnedIdle = true;
      } else {
        try {
          const hasBackup =
            validTarget && (await pathExists(databaseBackupDir(this.#baseDir, pending.id)));
          restored =
            hasBackup &&
            (managedByThisLauncher
              ? !(await hasConflictingServerOwnerLease(pending.dbPath, pending.id))
              : await canSafelyRestoreStoppedTrialBackup(this.#baseDir, pending));
          if (restored) {
            await restoreDatabaseBackup(this.#baseDir, pending);
          }
          outcome = terminalUpdate({ pending, status, reason });
          next = {
            ...this.#state,
            activeVersion: pending.fromVersion,
            update: outcome,
          };
          await writeServiceState(this.#statePath, next);
          this.#state = next;
          if (restored) {
            await discardDatabaseBackup(this.#baseDir, pending.id).catch(() => undefined);
          }
        } finally {
          serverOwnerLock.close();
        }
      }
    } finally {
      release();
    }
    if (enteredOwnedIdle) {
      await this.#repointServiceUnit(next.activeVersion);
      this.#enterOwnedStateDirIdle();
      return;
    }
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
  readonly platform?: NodeJS.Platform | undefined;
  readonly environment?: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly acl?: ControlAclHooks | undefined;
  readonly controlListenRetryMs?: number | undefined;
  readonly spawnCommand?: (entryPath: string) => {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  };
  readonly endScheduledTask?: ((taskName: string) => void) | undefined;
}

export async function main(options: LauncherOptions = {}): Promise<void> {
  const hostEnv = options.environment ?? process.env;
  const isWindows = options.platform !== undefined ? options.platform === "win32" : IS_WINDOWS;
  const baseDir = (options.baseDir ?? hostEnv.T3CODE_HOME)?.trim();
  if (baseDir === undefined || baseDir === "") {
    throw new Error("T3CODE_HOME is required by the T3 Code service launcher.");
  }
  if (options.logFile !== undefined) {
    NodeFS.mkdirSync(NodePath.dirname(options.logFile), { recursive: true, mode: 0o700 });
  }
  const output =
    options.logFile === undefined ? undefined : NodeFS.openSync(options.logFile, "a", 0o600);
  let loggedFatalError = false;
  const writeFatalError = (cause: unknown) => {
    if (loggedFatalError || output === undefined) return;
    loggedFatalError = true;
    try {
      NodeFS.writeSync(
        output,
        `[service-launcher] ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    } catch {
      // Log write failures (for example ENOSPC) must not suppress crash cleanup or mask the error.
    }
  };
  try {
    const managerEnvironment: NodeJS.ProcessEnv = {
      ...hostEnv,
      T3CODE_HOME: baseDir,
      ...(options.serviceUnit === undefined ? {} : { [SERVICE_UNIT_ENV]: options.serviceUnit }),
    };
    const environment = await readServiceEnvironment(baseDir, managerEnvironment);
    const configuredLocalAppData = (hostEnv.LOCALAPPDATA ?? "").trim();
    const userProfile = (hostEnv.USERPROFILE ?? "").trim();
    const localAppData =
      configuredLocalAppData !== ""
        ? configuredLocalAppData
        : userProfile === ""
          ? ""
          : NodePath.join(userProfile, "AppData", "Local");
    if (isWindows && localAppData === "") {
      throw new Error("LOCALAPPDATA is required by the T3 Code Windows service launcher.");
    }
    const userName = (hostEnv.USERNAME ?? "").trim();
    const endScheduledTask =
      options.endScheduledTask ??
      ((taskName: string) => {
        NodeChildProcess.spawnSync(
          windowsSystem32Binary("schtasks.exe", hostEnv),
          ["/End", "/TN", taskName],
          {
            stdio: "ignore",
            windowsHide: true,
          },
        );
      });
    const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    const state = await readServiceState(statePath);
    const serviceUnit = serviceUnitFromEnvironment(managerEnvironment, {
      isWindows,
      localAppData,
      baseDir,
    });
    const activeLauncher = new Launcher(baseDir, state, {
      environment,
      ...(serviceUnit === undefined ? {} : { serviceUnit }),
      ...(output === undefined ? {} : { output }),
      ...(options.acl === undefined ? {} : { acl: options.acl }),
      ...(options.controlListenRetryMs === undefined
        ? {}
        : { controlListenRetryMs: options.controlListenRetryMs }),
      ...(options.spawnCommand === undefined ? {} : { spawnCommand: options.spawnCommand }),
      ...(isWindows
        ? {
            controlDir: serviceControlDir(localAppData, baseDir, { caseInsensitive: true }),
            stopChildOverIpc: true,
            ...(options.serviceUnit !== undefined && userName !== ""
              ? {
                  // Runs while `lock.sqlite` is still held so a replacement launcher cannot own
                  // the task yet, and flushes the fatal log line before `schtasks /End` kills conhost.
                  onFatalControlOwnerExit: (cause) => {
                    try {
                      writeFatalError(cause);
                    } finally {
                      const taskName = resolvePersistedServiceTaskName(
                        localAppData,
                        serviceTaskName(hostEnv.USERDOMAIN ?? "", userName),
                      );
                      endScheduledTask(taskName);
                    }
                  },
                }
              : {}),
          }
        : {}),
    });
    // Ending a scheduled task kills its console host without a signal; the console read fails instead.
    const watchConsole = isWindows && process.stdin.isTTY === true;
    const onConsoleLost = () => void activeLauncher.stop("SIGTERM");
    if (watchConsole) {
      process.stdin.on("error", () => undefined);
      process.stdin.once("close", onConsoleLost);
      process.stdin.resume();
    }
    try {
      await activeLauncher.run();
    } finally {
      if (watchConsole) {
        process.stdin.off("close", onConsoleLost);
        process.stdin.destroy();
      }
    }
  } catch (cause) {
    writeFatalError(cause);
    throw cause;
  } finally {
    if (output !== undefined) {
      try {
        NodeFS.closeSync(output);
      } catch {}
    }
  }
}
