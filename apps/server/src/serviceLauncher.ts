// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
// This file is shipped as a standalone bundle and copied to a stable path by
// `t3 service update`. Keep runtime imports limited to Node built-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  PendingServiceUpdate,
  ServiceLauncherChildMessage,
  ServiceLauncherContext,
  ServiceLauncherParentMessage,
  ServiceState,
  ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";

const LAUNCHER_PROTOCOL = 1;
const STATE_SCHEMA_VERSION = 1;
const HANDOFF_EXIT_CODE = 75;
const HANDOFF_TIMEOUT_MS = 30_000;
const PREPARED_TIMEOUT_MS = 120_000;
const TERMINATE_GRACE_MS = 5_000;
const CONTEXT_ENV = "T3_SERVICE_LAUNCHER_CONTEXT";
const STATE_FILE = "service-state.json";
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

type TerminalStatus = "committed" | "rolled-back" | "failed";
type ChildRole = "active" | "trial";

interface ManagedChild {
  readonly generation: number;
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`service state '${key}' must be a non-empty string.`);
  }
  return value;
}

function exactVersion(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!EXACT_VERSION_PATTERN.test(value)) {
    throw new Error(`service state '${key}' is not an exact version.`);
  }
  return value;
}

function isoTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`service state '${key}' is not an ISO timestamp.`);
  }
  return value;
}

function decodeUpdate(value: unknown): ServiceUpdateRecord {
  const record = asRecord(value, "service state update");
  const id = requiredString(record, "id");
  const fromVersion = exactVersion(record, "fromVersion");
  const targetVersion = exactVersion(record, "targetVersion");
  const status = record.status;

  if (status === "pending") {
    return {
      id,
      fromVersion,
      targetVersion,
      status,
      requestedAt: isoTimestamp(record, "requestedAt"),
    };
  }
  if (status !== "committed" && status !== "rolled-back" && status !== "failed") {
    throw new Error("service state update status is unsupported.");
  }
  const reason = record.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "")) {
    throw new Error("service state update reason must be a non-empty string when present.");
  }
  return {
    id,
    fromVersion,
    targetVersion,
    status,
    ...(typeof reason === "string" ? { reason } : {}),
    completedAt: isoTimestamp(record, "completedAt"),
  };
}

/** Strictly decodes the only durable document understood by launcher v1. */
export function decodeServiceState(value: unknown): ServiceState {
  const record = asRecord(value, "service state");
  if (record.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error("service state schema is unsupported.");
  }
  if (record.launcherProtocol !== LAUNCHER_PROTOCOL) {
    throw new Error("service launcher protocol is unsupported.");
  }
  const activeVersion = exactVersion(record, "activeVersion");
  const update = record.update === undefined ? undefined : decodeUpdate(record.update);

  if (update !== undefined && compareExactVersions(update.targetVersion, update.fromVersion) <= 0) {
    throw new Error("service state update does not select a newer target version.");
  }

  if (update?.status === "pending" && update.fromVersion !== activeVersion) {
    throw new Error("pending update does not start from the active version.");
  }
  if (update?.status === "committed" && update.targetVersion !== activeVersion) {
    throw new Error("committed update does not select its target version.");
  }
  if (
    (update?.status === "rolled-back" || update?.status === "failed") &&
    update.fromVersion !== activeVersion
  ) {
    throw new Error("failed update does not retain its previous version.");
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    launcherProtocol: LAUNCHER_PROTOCOL,
    activeVersion,
    ...(update === undefined ? {} : { update }),
  };
}

interface ParsedVersion {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: ReadonlyArray<string>;
}

function parseVersion(version: string): ParsedVersion {
  if (!EXACT_VERSION_PATTERN.test(version)) {
    throw new Error(`'${version}' is not an exact version.`);
  }
  const withoutBuild = version.split("+", 1)[0] ?? version;
  const prereleaseIndex = withoutBuild.indexOf("-");
  const corePart = prereleaseIndex === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseIndex);
  const prereleasePart =
    prereleaseIndex === -1 ? undefined : withoutBuild.slice(prereleaseIndex + 1);
  const core = corePart.split(".");
  return {
    core: [BigInt(core[0] ?? "0"), BigInt(core[1] ?? "0"), BigInt(core[2] ?? "0")],
    prerelease: prereleasePart === undefined ? [] : prereleasePart.split("."),
  };
}

/** SemVer precedence for exact versions. Build metadata is intentionally ignored. */
export function compareExactVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.core.length; index += 1) {
    const leftPart = a.core[index] ?? 0n;
    const rightPart = b.core[index] ?? 0n;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  return decodeServiceState(JSON.parse(contents) as unknown);
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

function childMessage(value: unknown): ServiceLauncherChildMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.type === "request-update" &&
    typeof record.fromVersion === "string" &&
    typeof record.targetVersion === "string"
  ) {
    return {
      type: record.type,
      fromVersion: record.fromVersion,
      targetVersion: record.targetVersion,
    };
  }
  if (record.type === "prepared" && typeof record.updateId === "string") {
    return { type: record.type, updateId: record.updateId };
  }
  return null;
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
    completedAt: new Date().toISOString(),
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

async function terminateChild(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await waitForExit(child);
  } finally {
    clearTimeout(force);
  }
}

export class Launcher {
  readonly #baseDir: string;
  readonly #statePath: string;
  #state: ServiceState;
  #child: ManagedChild | null = null;
  #generation = 0;
  #handoffTimer: NodeJS.Timeout | undefined;
  #preparedTimer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #finished = false;
  #stopping = false;
  readonly #completion: Promise<void>;
  #resolveCompletion!: () => void;
  #rejectCompletion!: (error: Error) => void;

  constructor(baseDir: string, state: ServiceState) {
    this.#baseDir = baseDir;
    this.#statePath = NodePath.join(baseDir, "runtime", STATE_FILE);
    this.#state = state;
    this.#completion = new Promise<void>((resolve, reject) => {
      this.#resolveCompletion = resolve;
      this.#rejectCompletion = reject;
    });
  }

  async run(): Promise<void> {
    const onSigterm = () => void this.stop("SIGTERM");
    const onSigint = () => void this.stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    try {
      await this.#recover();
      await this.#completion;
    } finally {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    }
  }

  #enqueue(transition: () => Promise<void>): void {
    this.#transitions = this.#transitions.then(transition, transition).catch((cause: unknown) => {
      this.#fatal(cause instanceof Error ? cause : new Error(String(cause)));
    });
  }

  #fatal(error: Error): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#clearTimers();
    const child = this.#child?.process;
    this.#child = null;
    if (child?.connected) child.disconnect();
    child?.unref();
    this.#rejectCompletion(error);
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    if (this.#finished || this.#stopping) return;
    this.#stopping = true;
    this.#clearTimers();
    const child = this.#child?.process;
    this.#child = null;
    if (child !== undefined) {
      child.kill(signal);
      await waitForExit(child);
    }
    this.#finished = true;
    this.#resolveCompletion();
  }

  #clearTimers(): void {
    clearTimeout(this.#handoffTimer);
    clearTimeout(this.#preparedTimer);
    this.#handoffTimer = undefined;
    this.#preparedTimer = undefined;
  }

  async #recover(): Promise<void> {
    const update = this.#state.update;
    if (update?.status !== "pending") {
      await this.#startChild(this.#state.activeVersion, "active", update);
      return;
    }
    if (!(await runtimeExists(this.#baseDir, update.targetVersion))) {
      await this.#rollback(update, "target-runtime-missing");
      return;
    }
    await this.#startChild(update.targetVersion, "trial", update);
  }

  async #startChild(version: string, role: ChildRole, update?: ServiceUpdateRecord): Promise<void> {
    if (!(await runtimeExists(this.#baseDir, version))) {
      throw new Error(`Selected t3@${version} runtime is missing or incomplete.`);
    }
    const paths = runtimePaths(this.#baseDir, version);
    const context: ServiceLauncherContext = {
      protocol: LAUNCHER_PROTOCOL,
      activeVersion: this.#state.activeVersion,
      childVersion: version,
      trial: role === "trial",
      ...(update === undefined ? {} : { update }),
    };
    const child = NodeChildProcess.spawn(process.execPath, [paths.entryPath, "serve"], {
      env: { ...process.env, [CONTEXT_ENV]: JSON.stringify(context) },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        child.on("error", (error) => this.#fatal(error));
        resolve();
      });
    });

    const managed: ManagedChild = {
      generation: ++this.#generation,
      version,
      role,
      process: child,
    };
    this.#child = managed;
    child.on("message", (value) => {
      const message = childMessage(value);
      if (message !== null) this.#enqueue(() => this.#handleMessage(managed, message));
    });
    child.once("exit", (code, signal) =>
      this.#enqueue(() => this.#handleExit(managed, code, signal)),
    );

    if (role === "trial") {
      this.#preparedTimer = setTimeout(
        () => this.#enqueue(() => this.#handlePreparedTimeout(managed)),
        PREPARED_TIMEOUT_MS,
      );
    }
  }

  async #handleMessage(child: ManagedChild, message: ServiceLauncherChildMessage): Promise<void> {
    if (this.#child?.generation !== child.generation || this.#stopping) return;
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
    if (
      message.fromVersion !== child.version ||
      message.fromVersion !== this.#state.activeVersion
    ) {
      await reject("The requesting server is not the selected active version.");
      return;
    }
    if (this.#state.update?.status === "pending") {
      await reject("Another server update is already pending.");
      return;
    }
    if (!EXACT_VERSION_PATTERN.test(message.targetVersion)) {
      await reject("The requested target is not an exact version.");
      return;
    }
    if (compareExactVersions(message.targetVersion, message.fromVersion) <= 0) {
      await reject("Remote updates must select a newer server version.");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, message.targetVersion))) {
      await reject("The requested target runtime is missing or incomplete.");
      return;
    }

    const pending: PendingServiceUpdate = {
      id: NodeCrypto.randomUUID(),
      fromVersion: message.fromVersion,
      targetVersion: message.targetVersion,
      status: "pending",
      requestedAt: new Date().toISOString(),
    };
    const next: ServiceState = { ...this.#state, update: pending };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    await sendMessage(child.process, { type: "update-accepted", update: pending });
    this.#handoffTimer = setTimeout(
      () => this.#enqueue(() => this.#handleHandoffTimeout(child)),
      HANDOFF_TIMEOUT_MS,
    );
  }

  async #handleHandoffTimeout(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (
      this.#child?.generation !== child.generation ||
      child.role !== "active" ||
      pending?.status !== "pending"
    ) {
      return;
    }
    this.#handoffTimer = undefined;
    const failed = terminalUpdate({ pending, status: "failed", reason: "handoff-timeout" });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.fromVersion,
      update: failed,
    };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    this.#child = null;
    await terminateChild(child.process);
    await this.#startChild(next.activeVersion, "active", failed);
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
        await this.#rollback(pending, "invalid-prepared", child);
        return;
      }
      throw new Error("Trial child reported prepared for an unexpected update.");
    }
    clearTimeout(this.#preparedTimer);
    this.#preparedTimer = undefined;
    const committed = terminalUpdate({ pending, status: "committed" });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.targetVersion,
      update: committed,
    };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    child.role = "active";
    await sendMessage(child.process, { type: "committed", update: committed });
  }

  async #handlePreparedTimeout(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (
      this.#child?.generation !== child.generation ||
      child.role !== "trial" ||
      pending?.status !== "pending"
    ) {
      return;
    }
    this.#preparedTimer = undefined;
    await this.#rollback(pending, "prepared-timeout", child);
  }

  async #handleExit(
    child: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.#child?.generation !== child.generation || this.#stopping) return;
    this.#child = null;
    if (child.role === "trial") {
      clearTimeout(this.#preparedTimer);
      this.#preparedTimer = undefined;
      const pending = this.#state.update;
      if (pending?.status !== "pending") {
        throw new Error("Trial child exited without matching pending state.");
      }
      await this.#rollback(pending, `candidate-exited:${String(code ?? signal ?? "unknown")}`);
      return;
    }

    clearTimeout(this.#handoffTimer);
    this.#handoffTimer = undefined;
    const pending = this.#state.update;
    if (code === HANDOFF_EXIT_CODE && pending?.status === "pending") {
      await this.#startChild(pending.targetVersion, "trial", pending);
      return;
    }
    if (pending?.status === "pending") {
      const failed = terminalUpdate({
        pending,
        status: "failed",
        reason: `active-exited-before-handoff:${String(code ?? signal ?? "unknown")}`,
      });
      const next: ServiceState = {
        ...this.#state,
        activeVersion: pending.fromVersion,
        update: failed,
      };
      await writeServiceState(this.#statePath, next);
      this.#state = next;
    }
    throw new Error(
      code === HANDOFF_EXIT_CODE
        ? "Active child exited 75 without a matching pending update."
        : `Active child exited unexpectedly (${String(code ?? signal ?? "unknown")}).`,
    );
  }

  async #rollback(
    pending: PendingServiceUpdate,
    reason: string,
    child?: ManagedChild,
  ): Promise<void> {
    const rolledBack = terminalUpdate({ pending, status: "rolled-back", reason });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.fromVersion,
      update: rolledBack,
    };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    if (child !== undefined) {
      this.#child = null;
      await terminateChild(child.process);
    }
    await this.#startChild(next.activeVersion, "active", rolledBack);
  }
}

async function main(): Promise<void> {
  const baseDir = process.env.T3CODE_HOME?.trim();
  if (baseDir === undefined || baseDir === "") {
    throw new Error("T3CODE_HOME is required by the T3 Code service launcher.");
  }
  const statePath = NodePath.join(baseDir, "runtime", STATE_FILE);
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
