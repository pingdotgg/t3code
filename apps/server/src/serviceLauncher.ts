// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
// This file is shipped as a standalone bundle and copied to a stable path by
// `t3 service update`. Keep runtime imports limited to Node built-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  PendingServiceUpdate,
  ServiceLauncherChildMessage,
  ServiceLauncherContext,
  ServiceLauncherParentMessage,
  ServiceLauncherPresence,
  ServiceState,
  ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";
import {
  compareExactServiceVersions,
  decodeServiceLauncherChildMessage,
  isExactServiceVersion,
  parseServiceState,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_PID_FILE,
  decodeServiceLauncherPresence,
  encodeServiceLauncherPresence,
  serviceLauncherPresenceIsFromThisBoot,
  SERVICE_SELF_SUPERVISE_ENV,
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  SERVICE_STOP_REQUEST_FILE,
} from "./cloud/serviceProtocol.ts";

const HANDOFF_DELAY_MS = 2_000;
const PREPARED_TIMEOUT_MS = 120_000;
const TERMINATE_GRACE_MS = 5_000;

/**
 * Windows only. A Startup folder shortcut has no supervisor, so the launcher
 * does the job the systemd unit does on Linux. These three mirror RestartSec=5,
 * StartLimitBurst=5 and StartLimitIntervalSec=300, so a self-supervising
 * launcher gives up at exactly the point systemd would. The burst counts the
 * first start as well, the way systemd counts it, so five means four restarts.
 */
const RESTART_DELAY_MS = 5_000;
const RESTART_BURST = 5;
const RESTART_WINDOW_MS = 300_000;
/** Windows only. How often the launcher looks for a stop request. Directory
    watching misses events, so this poll is the real delivery guarantee. */
const STOP_REQUEST_WATCH_INTERVAL_MS = 2_000;
/**
 * Windows only. A request older than this when the launcher starts was left by
 * a stop nobody completed, so obeying it would stop a launcher the request was
 * never meant for. The window is generous on purpose: some filesystems report
 * a coarse modification time, and wrongly ignoring a real stop is far worse
 * than wrongly obeying an old one. Ignoring one lets an install rewrite the
 * runtime under a launcher that is still running.
 */
const STOP_REQUEST_GRACE_MS = 5_000;

/** Windows only. Set by the generated logon script. systemd never sets it. */
const isSelfSupervising = (): boolean => process.env[SERVICE_SELF_SUPERVISE_ENV] === "1";

/** Windows only. Milliseconds since the epoch when this machine last booted. */
const currentBootTimeMs = (): number => Date.now() - NodeOS.uptime() * 1_000;

/**
 * Windows only. Signal 0 asks the kernel whether a process exists without
 * touching it. A permission error means it exists but is not ours, which still
 * counts as running.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

type TerminalStatus = "committed" | "rolled-back" | "failed";
type ChildRole = "active" | "trial";

interface ManagedChild {
  readonly version: string;
  role: ChildRole;
  readonly process: NodeChildProcess.ChildProcess;
}

const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, "node_modules", "t3", "dist", "bin.mjs"),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

/** SQLite persists across the main file plus its WAL and shared-memory sidecars. */
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

async function syncFile(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Snapshots the database once per update before the first trial. A completed
 * backup is never overwritten because a restarted launcher may be looking at
 * database writes from an earlier attempt by the same trial.
 */
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
      await NodeFSP.copyFile(source, destination);
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

/** Mark rollback before changing live files so launcher recovery cannot boot a partial restore. */
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

/** Restore is retryable after any process crash while the backup directory remains. */
async function restoreDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (!(await pathExists(backupDir))) return;

  await markDatabaseRestorePending(backupDir);
  for (const suffix of DB_FILE_SUFFIXES) {
    const target = `${pending.dbPath}${suffix}`;
    const source = databaseBackupFile(backupDir, suffix);
    if (await pathExists(source)) {
      await NodeFSP.copyFile(source, target);
      await syncFile(target);
    } else {
      await NodeFSP.rm(target, { force: true });
    }
  }
  await syncDirectory(NodePath.dirname(pending.dbPath));
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

/** Durable same-directory replacement used for every runtime state transition. */
export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  const directory = NodePath.dirname(filePath);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(tempPath, filePath);
    const directoryHandle = await NodeFSP.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
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
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const force = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await waitForExit(child);
  } finally {
    clearTimeout(force);
  }
}

const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);

/** Windows only. Written by the CLI to ask for a stop, because there is no SIGTERM. */
const stopRequestPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_REQUEST_FILE);

/** Windows only. Present exactly while a self-supervising launcher is running. */
const pidFilePath = (baseDir: string) => NodePath.join(baseDir, "runtime", SERVICE_PID_FILE);

export interface LauncherOptions {
  /**
   * Windows only. Whether this launcher must restart its own child and watch
   * for stop requests. Defaults to the flag the generated logon script sets,
   * which systemd never sets.
   */
  readonly selfSupervise?: boolean;
  /** Overridable so tests do not sit through the real wait. */
  readonly restartDelayMs?: number;
}

export class Launcher {
  readonly #baseDir: string;
  readonly #statePath: string;
  readonly #selfSupervise: boolean;
  readonly #restartDelayMs: number;
  #state: ServiceState;
  #child: ManagedChild | null = null;
  #timer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopping = false;
  #done = false;
  /** Windows only. Restart times inside the current window. */
  #restartAttempts: Array<number> = [];
  /** Windows only. Used to tell a fresh stop request from a leftover one. */
  #startedAt = 0;
  /** Windows only. Modification time of a request already judged stale. */
  #dismissedRequestAt: number | undefined;
  /**
   * Windows only. Recovery clears a stale stop marker, so acting on a request
   * before it runs would let recovery wipe the marker the stop just wrote. The
   * child would then read "a replacement server is coming" while none is.
   */
  #recovered = false;
  #stopWatcher: NodeFS.FSWatcher | undefined;
  #stopPoll: NodeJS.Timeout | undefined;
  /** Windows only. Lets a stop cut a restart backoff short instead of queueing behind it. */
  #restartWait: { readonly timer: NodeJS.Timeout; readonly resolve: () => void } | undefined;
  readonly #completion = Promise.withResolvers<void>();

  constructor(baseDir: string, state: ServiceState, options?: LauncherOptions) {
    this.#baseDir = baseDir;
    this.#statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    this.#state = state;
    this.#selfSupervise = options?.selfSupervise ?? isSelfSupervising();
    this.#restartDelayMs = options?.restartDelayMs ?? RESTART_DELAY_MS;
  }

  async run(): Promise<void> {
    const onSigterm = () => void this.stop("SIGTERM");
    const onSigint = () => void this.stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    const supervising = this.#selfSupervise;
    let owned = false;
    this.#startedAt = Date.now();
    // The first start counts toward the burst, the way systemd counts it.
    this.#restartAttempts = [this.#startedAt];
    try {
      if (supervising) {
        // Claimed before anything else, and never swallowed on failure. The CLI
        // reads an absent pid file as proof nothing is running, so a live
        // launcher without one would let an install rewrite the runtime
        // underneath it and start a second server on the same database.
        owned = await this.#claimPidFile();
        if (!owned) {
          // Another launcher is already running, which happens when the Startup
          // shortcut fires twice. Leave it alone and exit.
          process.stderr.write("[service-launcher] another launcher is already running\n");
          return;
        }
        this.#watchStopRequest();
      }
      this.#enqueue(() => this.#recover());
      this.#enqueue(async () => {
        this.#recovered = true;
      });
      await this.#completion.promise;
    } finally {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      this.#stopWatchingStopRequest();
      if (owned) {
        // Removing these before run() returns is how the CLI learns the stop
        // finished. Doing it after would race the process exiting.
        await NodeFSP.rm(stopRequestPath(this.#baseDir), { force: true }).catch(() => undefined);
        await this.#releasePidFile();
      }
    }
  }

  /**
   * Windows only. Claims the pid file exclusively. Returns false when another
   * live launcher already owns it, which is what stops a Startup shortcut that
   * fires twice from running two servers against one database.
   */
  async #claimPidFile(): Promise<boolean> {
    const target = pidFilePath(this.#baseDir);
    const bootTimeMs = currentBootTimeMs();
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await NodeFSP.open(target, "wx", 0o600);
        try {
          await handle.writeFile(
            encodeServiceLauncherPresence({ pid: process.pid, bootTimeMs }),
            "utf8",
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        return true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        const owner = await this.#readPidFile();
        // A live owner wins, even when it is this very process. Two Launcher
        // instances sharing a process would still be two servers on one
        // database, so there is nothing to exempt. But only trust the process
        // id while the file is from this boot: ids are recycled across reboots,
        // and believing a stranger would keep the service down indefinitely.
        if (
          owner !== undefined &&
          serviceLauncherPresenceIsFromThisBoot(owner, bootTimeMs) &&
          processIsAlive(owner.pid)
        ) {
          return false;
        }
        // Leftover, from a dead owner or an earlier boot. Clear it and retry.
        await NodeFSP.rm(target, { force: true });
      }
    }
    return false;
  }

  async #readPidFile(): Promise<ServiceLauncherPresence | undefined> {
    const contents = await NodeFSP.readFile(pidFilePath(this.#baseDir), "utf8").catch(() => "");
    return decodeServiceLauncherPresence(contents);
  }

  /** Windows only. Only clears the file if this process still owns it. */
  async #releasePidFile(): Promise<void> {
    if ((await this.#readPidFile())?.pid !== process.pid) return;
    await NodeFSP.rm(pidFilePath(this.#baseDir), { force: true }).catch(() => undefined);
  }

  /**
   * Windows only. Watches for the CLI's stop request, because Windows has no
   * SIGTERM. The stop it triggers is not graceful: the child is terminated
   * without running its shutdown finalizer.
   */
  #watchStopRequest(): void {
    const target = stopRequestPath(this.#baseDir);
    const check = () => {
      if (!this.#recovered || this.#stopRequested || this.#stopping) return;
      void NodeFSP.stat(target).then(
        async (stats) => {
          if (this.#stopRequested || this.#stopping) return;
          if (this.#dismissedRequestAt === stats.mtimeMs) return;
          if (stats.mtimeMs >= this.#startedAt - STOP_REQUEST_GRACE_MS) {
            await this.stop("SIGTERM");
            return;
          }
          // Left behind by a stop nobody completed. Remember it rather than
          // deleting it: the CLI reads a vanished pid file as proof that a
          // launcher stopped, and deleting files here must never look like that.
          this.#dismissedRequestAt = stats.mtimeMs;
        },
        () => undefined,
      );
    };
    try {
      this.#stopWatcher = NodeFS.watch(NodePath.dirname(target), () => check());
      // An error event with no listener is an uncaught exception, and Windows
      // emits EPERM here when the watched directory goes away. The poll below
      // is the real delivery guarantee, so losing the watcher costs nothing.
      this.#stopWatcher.on("error", () => undefined);
    } catch {
      // Best effort, for the same reason.
    }
    this.#stopPoll = setInterval(check, STOP_REQUEST_WATCH_INTERVAL_MS);
    this.#stopPoll.unref();
    check();
  }

  #stopWatchingStopRequest(): void {
    this.#stopWatcher?.close();
    this.#stopWatcher = undefined;
    clearInterval(this.#stopPoll);
    this.#stopPoll = undefined;
  }

  /**
   * Windows only. Waits out the restart backoff, but returns early when a stop
   * arrives. The wait runs inside a queued transition, so sleeping through it
   * would delay the stop by the full delay and eat the CLI's patience.
   */
  #waitBeforeRestart(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#restartWait = undefined;
        resolve();
      }, this.#restartDelayMs);
      this.#restartWait = {
        timer,
        resolve: () => {
          clearTimeout(timer);
          this.#restartWait = undefined;
          resolve();
        },
      };
    });
  }

  /** Windows only. False once the burst limit is reached inside the window. */
  #recordRestartAttempt(): boolean {
    const now = Date.now();
    this.#restartAttempts = this.#restartAttempts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (this.#restartAttempts.length >= RESTART_BURST) return false;
    this.#restartAttempts.push(now);
    return true;
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
    if (child !== undefined) await terminateChild(child);
    this.#completion.reject(error);
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    // This must happen synchronously at signal receipt. A queued update
    // transition may already be terminating the active child, and that child
    // needs to see the marker in its shutdown finalizer. KillMode=mixed also
    // ensures systemd signals the launcher before the rest of the cgroup.
    try {
      NodeFS.writeFileSync(stopMarkerPath(this.#baseDir), "", { mode: 0o600 });
    } catch {
      // Err toward keeping the tunnel; the next link or unlink reconciles it.
    }
    if (this.#stopRequested || this.#stopping) {
      await this.#completion.promise.catch(() => undefined);
      return;
    }
    this.#stopRequested = true;
    // Windows only. A restart backoff holds the transition queue, so a stop
    // queued behind it would wait the full delay before it even started.
    this.#restartWait?.resolve();
    this.#clearTimer();
    this.#enqueue(async () => {
      // Let an update transition already in progress start its replacement
      // before this queued stop tears it down. That replacement owns the
      // pre-activation tunnel cleanup path and observes the marker above.
      this.#stopping = true;
      const child = this.#child?.process;
      this.#child = null;
      if (child !== undefined) await terminateChild(child, signal);
      this.#done = true;
      this.#completion.resolve();
    });
    await this.#completion.promise.catch(() => undefined);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #recover(): Promise<void> {
    // A fresh launcher means servers are running again: any stop marker from
    // a previous explicit stop is stale and must not make a future update
    // handoff release its tunnel.
    await NodeFSP.rm(stopMarkerPath(this.#baseDir), { force: true }).catch(() => undefined);
    const update = this.#state.update;
    if (update?.status !== "pending") {
      if (update !== undefined) {
        await discardDatabaseBackup(this.#baseDir, update.id).catch(() => undefined);
      }
      await this.#startChild(this.#state.activeVersion, "active", update);
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
    // The previous child is dead here, so all three SQLite files are quiescent.
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
    const child = NodeChildProcess.spawn(process.execPath, [paths.entryPath, "serve"], {
      env: { ...process.env, [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
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
      await terminateChild(child);
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

    const pending: PendingServiceUpdate = {
      id: NodeCrypto.randomUUID(),
      fromVersion: child.version,
      targetVersion: message.targetVersion,
      dbPath: message.dbPath,
      status: "pending",
    };
    const next: ServiceState = { ...this.#state, update: pending };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    await sendMessage(child.process, { type: "update-accepted", updateId: pending.id });
    this.#timer = setTimeout(() => this.#enqueue(() => this.#beginTrial(child)), HANDOFF_DELAY_MS);
  }

  async #beginTrial(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "active" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    this.#child = null;
    await terminateChild(child.process);
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
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    child.role = "active";
    await discardDatabaseBackup(this.#baseDir, committed.id).catch(() => undefined);
    await sendMessage(child.process, { type: "committed", updateId: committed.id });
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
    // Windows only. Nothing supervises a Startup folder entry, so the launcher
    // does what Restart=always does on Linux, and gives up on the same terms.
    // Without the flag this still throws, so the Linux path is unchanged.
    if (this.#selfSupervise && this.#recordRestartAttempt()) {
      await this.#waitBeforeRestart();
      if (this.#stopping || this.#done || this.#stopRequested) return;
      await this.#startChild(this.#state.activeVersion, "active", this.#state.update);
      return;
    }
    throw new Error(`Active child exited unexpectedly (${String(code ?? signal ?? "unknown")}).`);
  }

  async #returnToPrevious(
    pending: PendingServiceUpdate,
    status: "rolled-back" | "failed",
    reason: string,
    child?: ManagedChild,
  ): Promise<void> {
    if (child !== undefined) {
      this.#child = null;
      await terminateChild(child.process);
    }
    await restoreDatabaseBackup(this.#baseDir, pending);
    const outcome = terminalUpdate({ pending, status, reason });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.fromVersion,
      update: outcome,
    };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    await discardDatabaseBackup(this.#baseDir, pending.id).catch(() => undefined);
    await this.#startChild(next.activeVersion, "active", outcome);
  }
}

async function main(): Promise<void> {
  const baseDir = process.env.T3CODE_HOME?.trim();
  if (baseDir === undefined || baseDir === "") {
    throw new Error("T3CODE_HOME is required by the T3 Code service launcher.");
  }
  const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
  const state = await readServiceState(statePath);
  await new Launcher(baseDir, state).run();
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    process.stderr.write(`[service-launcher] ${error.message}\n`);
    process.exitCode = 1;
  });
}
