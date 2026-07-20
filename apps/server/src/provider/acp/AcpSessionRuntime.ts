// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

function formatConfigOptionValue(value: string | boolean): string {
  return JSON.stringify(value);
}

export interface AcpSessionEventStreamBarrier {
  readonly _tag: "EventStreamBarrier";
  readonly acknowledge: Deferred.Deferred<void>;
}

export type AcpSessionRuntimeEvent = AcpParsedSessionEvent | AcpSessionEventStreamBarrier;

const defaultSessionLoadTimeout = Duration.seconds(90);
const defaultSessionLoadReplayIdleGap = Duration.seconds(2);

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly sessionLoadTimeout?: Duration.Input;
  readonly sessionLoadReplayIdleGap?: Duration.Input;
  readonly interruptPromptOnCancel?: boolean;
  /** Optional provider metadata forwarded on `session/cancel`. */
  readonly cancelMeta?: EffectAcpSchema.CancelNotification["_meta"];
  readonly ownDetachedProcessGroup?: boolean;
  readonly ownDescendantProcessGroups?: boolean;
  readonly processGroupPlatform?: NodeJS.Platform;
  readonly processGroupTerminationGrace?: Duration.Input;
  readonly windowsProcessTreeTerminator?: (
    pid: number,
  ) => Effect.Effect<void, AcpProcessGroupTerminationError>;
  readonly posixProcessTreeController?: AcpPosixProcessTreeController;
  readonly linuxCgroupController?: AcpLinuxCgroupController | null;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId?: string;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
  readonly onIncomingRequest?: EffectAcpClient.AcpClientOptions["onIncomingRequest"];
  readonly onTermination?: (error: EffectAcpErrors.AcpError) => Effect.Effect<void>;
  readonly onOutgoingResponseFailure?: EffectAcpClient.AcpClientOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: EffectAcpClient.AcpClientOptions["onOutgoingResponse"];
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export class AcpProcessGroupTerminationError extends Schema.TaggedErrorClass<AcpProcessGroupTerminationError>()(
  "AcpProcessGroupTerminationError",
  {
    detail: Schema.String,
    pid: Schema.optionalKey(Schema.Int),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isAcpProcessGroupTerminationError = Schema.is(AcpProcessGroupTerminationError);

export interface AcpPosixProcessIdentity {
  readonly executable: string | undefined;
  readonly pgid: number;
  readonly pid: number;
  readonly ppid: number;
  readonly sid: number;
  /**
   * Linux `/proc/<pid>/stat` state when known (`R`/`S`/`D`/`Z`/…). Omitted on
   * platforms or fixtures that do not surface it. Zombies (`Z`) are already
   * dead and must not count as residual teardown survivors.
   */
  readonly state?: string;
  readonly startTime: string;
}

export interface AcpPosixProcessTreeController {
  readonly childPidsOf: (pid: number) => ReadonlyArray<number>;
  readonly childrenOf: (pid: number) => ReadonlyArray<AcpPosixProcessIdentity>;
  readonly identity: (pid: number) => AcpPosixProcessIdentity | undefined;
  readonly snapshot: () => ReadonlyArray<AcpPosixProcessIdentity>;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
}

export interface AcpLinuxCgroupLease {
  readonly contains: (pid: number) => boolean;
  readonly exists: () => boolean;
  readonly path: string;
  readonly relativePath: string;
  readonly kill: () => void;
  readonly populated: () => boolean;
  readonly remove: () => void;
}

export interface AcpLinuxCgroupController {
  readonly create: () => AcpLinuxCgroupLease | undefined;
}

export interface AcpPosixOwnershipRoot {
  captureAttempted?: boolean;
  value: AcpOwnedPosixProcess | undefined;
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseUnifiedCgroupPath(contents: string): string | undefined {
  const matches = [...contents.matchAll(/^0::(\/.*)$/gm)];
  return matches.length === 1 ? matches[0]![1] : undefined;
}

export function isSafeCgroupPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.includes("(deleted)") &&
    NodePath.posix.normalize(value) === value
  );
}

export function parseCgroup2Mounts(
  contents: string,
): ReadonlyArray<{ readonly mountPoint: string; readonly root: string }> {
  const mounts: Array<{ readonly mountPoint: string; readonly root: string }> = [];
  for (const line of contents.split("\n")) {
    const [mount, filesystem] = line.split(" - ");
    if (mount === undefined || filesystem?.split(" ")[0] !== "cgroup2") continue;
    const fields = mount.split(" ");
    if (fields.length < 5) continue;
    mounts.push({
      mountPoint: decodeMountInfoPath(fields[4]!),
      root: decodeMountInfoPath(fields[3]!),
    });
  }
  return mounts;
}

export function parseCgroup2Mount(
  contents: string,
): { readonly mountPoint: string; readonly root: string } | undefined {
  return parseCgroup2Mounts(contents)[0];
}

export function wrapCommandForLinuxCgroup(
  lease: AcpLinuxCgroupLease,
  command: string,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return {
    command: process.execPath,
    args: [
      "-e",
      [
        'const fs = require("node:fs");',
        "try {",
        '  fs.writeFileSync(process.argv[1] + "/cgroup.procs", String(process.pid) + "\\n");',
        '  const actual = fs.readFileSync("/proc/self/cgroup", "utf8").split("\\n").find((line) => line.startsWith("0::"))?.slice(3);',
        "  if (actual !== process.argv[2]) process.exit(126);",
        "  const env = { ...process.env };",
        "  delete env.ELECTRON_RUN_AS_NODE;",
        "  delete env.T3_ACP_CGROUP_WRAPPER;",
        "  process.execve(process.argv[3], process.argv.slice(3), env);",
        "} catch { process.exit(125); }",
      ].join("\n"),
      lease.path,
      lease.relativePath,
      command,
      ...args,
    ],
  };
}

export function resolveLinuxCgroupTargetCommand(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  // Match Node spawn PATH fallback when PATH is undefined. An explicitly empty
  // PATH stays empty (lookup only via empty-segment → cwd).
  const pathEnv = environment.PATH === undefined ? "/usr/bin:/bin" : environment.PATH;
  const candidates = command.includes(NodePath.sep)
    ? [NodePath.resolve(cwd, command)]
    : pathEnv
        .split(NodePath.delimiter)
        .map((entry) =>
          NodePath.join(
            entry.length === 0
              ? cwd
              : NodePath.isAbsolute(entry)
                ? entry
                : NodePath.resolve(cwd, entry),
            command,
          ),
        );
  for (const candidate of candidates) {
    try {
      if (!NodeFS.statSync(candidate).isFile()) continue;
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

const STALE_ACP_CGROUP_SIBLING = /^t3-acp-(\d+)-/;

export interface SweepStaleLinuxCgroupSiblingsOptions {
  readonly currentPid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly readPopulated?: (siblingPath: string) => "0" | "1" | undefined;
  readonly remove?: (siblingPath: string) => void;
}

function defaultCgroupOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

function defaultReadCgroupPopulated(siblingPath: string): "0" | "1" | undefined {
  const state = /(?:^|\n)populated ([01])(?:\n|$)/.exec(
    NodeFS.readFileSync(NodePath.join(siblingPath, "cgroup.events"), "utf8"),
  )?.[1];
  return state === "0" || state === "1" ? state : undefined;
}

/** Best-effort removal of empty `t3-acp-<dead-pid>-*` sibling leases under a parent cgroup. */
export function sweepStaleLinuxCgroupSiblings(
  parentPath: string,
  options: SweepStaleLinuxCgroupSiblingsOptions = {},
): void {
  const currentPid = options.currentPid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultCgroupOwnerIsAlive;
  const readPopulated = options.readPopulated ?? defaultReadCgroupPopulated;
  const remove = options.remove ?? ((siblingPath: string) => NodeFS.rmdirSync(siblingPath));
  try {
    for (const entry of NodeFS.readdirSync(parentPath, { withFileTypes: true })) {
      try {
        if (!entry.isDirectory()) continue;
        const match = STALE_ACP_CGROUP_SIBLING.exec(entry.name);
        if (match === null) continue;
        const ownerPid = Number(match[1]);
        if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || ownerPid === currentPid) continue;
        if (isProcessAlive(ownerPid)) continue;
        const siblingPath = NodePath.join(parentPath, entry.name);
        if (NodePath.dirname(siblingPath) !== parentPath) continue;
        if (readPopulated(siblingPath) !== "0") continue;
        remove(siblingPath);
      } catch {
        // Ignore unreadable or busy siblings; never fail lease creation.
      }
    }
  } catch {
    // Ignore readdir failures on the parent path.
  }
}

function tryCreateLinuxCgroupLease(
  currentRelative: string,
  mount: { readonly mountPoint: string; readonly root: string },
): AcpLinuxCgroupLease | undefined {
  if (
    !isSafeCgroupPath(mount.root) ||
    !isSafeCgroupPath(mount.mountPoint) ||
    !(
      mount.root === "/" ||
      currentRelative === mount.root ||
      currentRelative.startsWith(`${mount.root}/`)
    )
  ) {
    return undefined;
  }
  const mountRelative =
    mount.root === "/" ? currentRelative : currentRelative.slice(mount.root.length);
  const currentPath = NodePath.resolve(mount.mountPoint, `.${mountRelative}`);
  const resolvedMount = NodePath.resolve(mount.mountPoint);
  if (currentPath !== resolvedMount && !currentPath.startsWith(`${resolvedMount}${NodePath.sep}`)) {
    return undefined;
  }
  sweepStaleLinuxCgroupSiblings(currentPath);
  const childName = `t3-acp-${process.pid}-${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  const childPath = NodePath.join(currentPath, childName);
  const childRelative = NodePath.posix.join(currentRelative, childName);
  if (NodePath.dirname(childPath) !== currentPath) return undefined;
  try {
    NodeFS.mkdirSync(childPath, { mode: 0o700 });
    NodeFS.accessSync(NodePath.join(childPath, "cgroup.procs"), NodeFS.constants.W_OK);
    NodeFS.accessSync(NodePath.join(childPath, "cgroup.kill"), NodeFS.constants.W_OK);
    NodeFS.accessSync(NodePath.join(childPath, "cgroup.events"), NodeFS.constants.R_OK);
    if (NodeFS.readFileSync(NodePath.join(childPath, "cgroup.type"), "utf8").trim() !== "domain") {
      throw new Error("ACP cgroup is not a domain cgroup");
    }
    if (typeof process.execve !== "function") throw new Error("process.execve is unavailable");
  } catch {
    try {
      NodeFS.rmdirSync(childPath);
    } catch {
      // The unavailable cgroup was never used for a child process.
    }
    return undefined;
  }
  return {
    contains: (pid) =>
      parseUnifiedCgroupPath(NodeFS.readFileSync(`/proc/${pid}/cgroup`, "utf8")) === childRelative,
    exists: () => NodeFS.existsSync(childPath),
    path: childPath,
    relativePath: childRelative,
    kill: () => NodeFS.writeFileSync(NodePath.join(childPath, "cgroup.kill"), "1\n"),
    populated: () => {
      const state = /(?:^|\n)populated ([01])(?:\n|$)/.exec(
        NodeFS.readFileSync(NodePath.join(childPath, "cgroup.events"), "utf8"),
      )?.[1];
      if (state === undefined) throw new Error("ACP cgroup.events has no populated state");
      return state === "1";
    },
    remove: () => {
      const directories = (path: string): ReadonlyArray<string> =>
        NodeFS.readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? [...directories(NodePath.join(path, entry.name)), NodePath.join(path, entry.name)]
            : [],
        );
      for (const directory of directories(childPath)) NodeFS.rmdirSync(directory);
      NodeFS.rmdirSync(childPath);
    },
  };
}

export function makeLinuxCgroupController(): AcpLinuxCgroupController {
  return {
    create: () => {
      let currentRelative: string | undefined;
      let mounts: ReadonlyArray<{ readonly mountPoint: string; readonly root: string }> = [];
      try {
        currentRelative = parseUnifiedCgroupPath(NodeFS.readFileSync("/proc/self/cgroup", "utf8"));
        mounts = parseCgroup2Mounts(NodeFS.readFileSync("/proc/self/mountinfo", "utf8"));
      } catch {
        return undefined;
      }
      if (
        currentRelative === undefined ||
        !currentRelative.startsWith("/") ||
        mounts.length === 0
      ) {
        return undefined;
      }
      if (!isSafeCgroupPath(currentRelative)) return undefined;
      // Prefer the first mount that successfully creates a writable child cgroup.
      // Multi-mount hosts often list a read-only view before the delegated one.
      for (const mount of mounts) {
        const lease = tryCreateLinuxCgroupLease(currentRelative, mount);
        if (lease !== undefined) return lease;
      }
      return undefined;
    },
  };
}

// OS-state polls (cgroup emptiness, process trees) must use wall time. Under
// TestClock, Effect.sleep never resolves unless the test advances the clock.
const wallClock = Clock.Clock.defaultValue();
const withWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Clock.Clock, wallClock);

export function terminateLinuxCgroupLease(
  lease: AcpLinuxCgroupLease,
): Effect.Effect<void, AcpProcessGroupTerminationError> {
  const failure = (name: string, cause: unknown) =>
    new AcpProcessGroupTerminationError({
      cause,
      detail: `Failed to ${name} ACP cgroup ${lease.path}`,
    });
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!lease.exists()) return;
      try {
        lease.kill();
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") return yield* failure("kill", cause);
        if (!lease.exists()) return;
        yield* Effect.sleep("10 millis");
        continue;
      }
      let populated: boolean;
      try {
        populated = lease.populated();
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" && !lease.exists()) return;
        if (code === "ENOENT") {
          yield* Effect.sleep("10 millis");
          continue;
        }
        return yield* failure("read state for", cause);
      }
      if (populated) {
        yield* Effect.sleep("10 millis");
        continue;
      }
      try {
        lease.remove();
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" && !lease.exists()) return;
        if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "ENOENT") {
          return yield* failure("remove", cause);
        }
      }
      if (!lease.exists()) return;
      yield* Effect.sleep("10 millis");
    }
    return yield* new AcpProcessGroupTerminationError({
      detail: `ACP cgroup ${lease.path} remained populated after cgroup.kill`,
    });
  }).pipe(withWallClock);
}

export function signalLinuxCgroupRootTerm(input: {
  readonly controller: AcpPosixProcessTreeController;
  readonly lease: AcpLinuxCgroupLease;
  readonly root: AcpPosixOwnershipRoot;
}): void {
  const root = input.root.value;
  if (root === undefined) return;
  try {
    const observed = input.controller.identity(root.pid);
    if (!samePosixProcessIdentity(root, observed) || !input.lease.contains(root.pid)) return;
    input.controller.signalProcess(root.pid, "SIGTERM");
  } catch {
    // TERM is optional. cgroup.kill remains the authoritative teardown.
  }
}

function readLinuxProcessIdentity(pid: number): AcpPosixProcessIdentity | undefined {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    // After comm: state, ppid, pgrp, session, … starttime (field 22 / index 19).
    const state = fields[0];
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    const sid = Number(fields[3]);
    const startTime = fields[19];
    if (
      state === undefined ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(pgid) ||
      !Number.isSafeInteger(sid) ||
      startTime === undefined
    ) {
      return undefined;
    }
    let executable: string | undefined;
    try {
      executable = NodeFS.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      executable = undefined;
    }
    return { executable, pgid, pid, ppid, sid, startTime, state };
  } catch {
    return undefined;
  }
}

/** Linux zombies keep pid/starttime until reaped; they are not live survivors. */
export function posixProcessIsZombie(process: AcpPosixProcessIdentity): boolean {
  return process.state === "Z";
}

function readLinuxChildPids(pid: number): ReadonlyArray<number> {
  const childPids = new Set<number>();
  let taskIds: ReadonlyArray<string> = [];
  try {
    taskIds = NodeFS.readdirSync(`/proc/${pid}/task`).filter((entry) =>
      /^[1-9][0-9]*$/.test(entry),
    );
  } catch {
    return [];
  }
  for (const taskId of taskIds) {
    try {
      for (const childPid of NodeFS.readFileSync(`/proc/${pid}/task/${taskId}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)) {
        childPids.add(childPid);
      }
    } catch {
      // The task exited while its children were being read.
    }
  }
  return [...childPids];
}

function makeLinuxProcessTreeController(): AcpPosixProcessTreeController {
  return {
    childPidsOf: readLinuxChildPids,
    childrenOf: (pid) =>
      readLinuxChildPids(pid).flatMap((childPid) => {
        const identity = readLinuxProcessIdentity(childPid);
        return identity === undefined ? [] : [identity];
      }),
    identity: readLinuxProcessIdentity,
    snapshot: () =>
      NodeFS.readdirSync("/proc", { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) return [];
        const identity = readLinuxProcessIdentity(Number(entry.name));
        return identity === undefined ? [] : [identity];
      }),
    signalProcess: (pid, signal) => process.kill(pid, signal),
  };
}

export function observePosixOwnershipLedger(input: {
  readonly childQueues: Map<number, Array<number>>;
  readonly controller: AcpPosixProcessTreeController;
  readonly frontier: Map<number, AcpOwnedPosixProcess>;
  readonly ledger: Map<string, AcpOwnedPosixProcess>;
  readonly maxProcesses?: number;
  readonly root: AcpPosixOwnershipRoot;
  readonly rootPid: number;
}): void {
  let rootIdentity: AcpPosixProcessIdentity | undefined = input.root.value;
  if (rootIdentity === undefined) {
    if (input.root.captureAttempted === true) {
      throw new AcpProcessGroupTerminationError({
        detail: `ACP process ${input.rootPid} exited before its ownership ledger was captured`,
      });
    }
    input.root.captureAttempted = true;
    rootIdentity = input.controller.identity(input.rootPid);
    if (rootIdentity === undefined) {
      throw new AcpProcessGroupTerminationError({
        detail: `ACP process ${input.rootPid} exited before its ownership ledger was captured`,
      });
    }
    const parent = input.controller.identity(rootIdentity.ppid);
    const ownedRoot = {
      ...rootIdentity,
      parentExecutable: parent?.executable,
      parentStartTime: parent?.startTime ?? "",
    };
    input.ledger.set(processIdentityKey(rootIdentity), ownedRoot);
    input.frontier.set(rootIdentity.pid, ownedRoot);
    input.root.value = ownedRoot;
  }
  const maxProcesses = Math.max(1, input.maxProcesses ?? Number.POSITIVE_INFINITY);
  let remainingBudget = maxProcesses;
  const pending = [...input.frontier.entries()];
  const visited = new Set<number>();
  while (pending.length > 0 && remainingBudget > 0) {
    const entry = pending.shift();
    if (entry === undefined) continue;
    const [parentPid, parent] = entry;
    input.frontier.delete(parentPid);
    if (visited.has(parent.pid)) continue;
    visited.add(parent.pid);
    remainingBudget -= 1;
    const observedParent = input.controller.identity(parent.pid);
    if (!samePosixProcessIdentity(parent, observedParent)) {
      input.childQueues.delete(parent.pid);
      continue;
    }
    const refreshedParent = { ...parent, ...observedParent };
    input.ledger.set(processIdentityKey(refreshedParent), refreshedParent);
    input.frontier.set(refreshedParent.pid, refreshedParent);
    let queuedChildren = input.childQueues.get(refreshedParent.pid);
    if (queuedChildren === undefined) {
      if (remainingBudget === 0) continue;
      remainingBudget -= 1;
      queuedChildren = [...input.controller.childPidsOf(refreshedParent.pid)];
    }
    while (queuedChildren.length > 0 && remainingBudget > 0) {
      const childPid = queuedChildren.shift();
      if (childPid === undefined) continue;
      remainingBudget -= 1;
      const child = input.controller.identity(childPid);
      if (child === undefined) continue;
      if (child.ppid !== parent.pid) continue;
      let reservedPid = input.frontier.get(child.pid);
      if (reservedPid !== undefined && !samePosixProcessIdentity(reservedPid, child)) {
        // PID reused under an owned parent; drop the stale reservation.
        input.frontier.delete(child.pid);
        for (const [key, owned] of [...input.ledger.entries()]) {
          if (owned.pid === child.pid) input.ledger.delete(key);
        }
        reservedPid = undefined;
      }
      const childKey = processIdentityKey(child);
      const owned =
        reservedPid === undefined
          ? {
              ...child,
              parentExecutable: refreshedParent.executable,
              parentStartTime: refreshedParent.startTime,
            }
          : { ...reservedPid, ...child };
      input.ledger.set(childKey, owned);
      input.frontier.set(child.pid, owned);
    }
    if (queuedChildren.length === 0) input.childQueues.delete(refreshedParent.pid);
    else input.childQueues.set(refreshedParent.pid, queuedChildren);
  }
}

export function observePosixOwnershipLedgerContinuously(input: {
  readonly childQueues: Map<number, Array<number>>;
  readonly controller: AcpPosixProcessTreeController;
  readonly frontier: Map<number, AcpOwnedPosixProcess>;
  readonly ledger: Map<string, AcpOwnedPosixProcess>;
  readonly root: AcpPosixOwnershipRoot;
  readonly rootPid: number;
}): Effect.Effect<never> {
  return Effect.forever(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      yield* Effect.sync(() => observePosixOwnershipLedger({ ...input, maxProcesses: 64 })).pipe(
        Effect.exit,
      );
      const targetInterval = input.frontier.size <= 32 ? 25 : input.frontier.size <= 128 ? 50 : 100;
      const completedAt = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(`${Math.max(5, targetInterval - (completedAt - startedAt))} millis`);
    }),
  ).pipe(withWallClock);
}

export function makePosixProcessTreeController(
  platform: NodeJS.Platform,
): AcpPosixProcessTreeController {
  if (platform === "linux") return makeLinuxProcessTreeController();
  throw new AcpProcessGroupTerminationError({
    detail: `Detached ACP descendant ownership is unsupported on ${platform}`,
  });
}

function samePosixProcessIdentity(
  expected: AcpPosixProcessIdentity,
  observed: AcpPosixProcessIdentity | undefined,
): boolean {
  return (
    observed !== undefined &&
    observed.pid === expected.pid &&
    observed.startTime === expected.startTime
  );
}

export interface AcpOwnedPosixProcess extends AcpPosixProcessIdentity {
  readonly parentExecutable: string | undefined;
  readonly parentStartTime: string;
}

function processIdentityKey(process: AcpPosixProcessIdentity): string {
  return `${process.pid}:${process.startTime}`;
}

function processDepth(
  process: AcpPosixProcessIdentity,
  ledgerByPid: ReadonlyMap<number, AcpOwnedPosixProcess>,
): number {
  let depth = 0;
  let current = process;
  const seen = new Set<number>();
  while (!seen.has(current.pid)) {
    seen.add(current.pid);
    const parent = ledgerByPid.get(current.ppid);
    if (parent === undefined) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

export function capturePosixOwnershipLedger(input: {
  readonly controller: AcpPosixProcessTreeController;
  readonly ledger: Map<string, AcpOwnedPosixProcess>;
  readonly root?: AcpPosixOwnershipRoot;
  readonly rootPid: number;
  readonly table?: ReadonlyArray<AcpPosixProcessIdentity>;
}): ReadonlyArray<AcpPosixProcessIdentity> {
  let table: ReadonlyArray<AcpPosixProcessIdentity>;
  if (input.table === undefined) {
    try {
      table = input.controller.snapshot();
    } catch (cause) {
      throw new AcpProcessGroupTerminationError({
        cause,
        detail: `Failed to snapshot ACP process tree ${input.rootPid}`,
      });
    }
  } else {
    table = input.table;
  }
  const byPid = new Map(table.map((process) => [process.pid, process]));
  let rootIdentity: AcpPosixProcessIdentity | undefined =
    input.root?.value ??
    [...input.ledger.values()].find((process) => process.pid === input.rootPid);
  if (rootIdentity === undefined) {
    rootIdentity = byPid.get(input.rootPid);
    if (rootIdentity === undefined) {
      throw new AcpProcessGroupTerminationError({
        detail: `ACP process ${input.rootPid} exited before its ownership ledger was captured`,
      });
    }
    const ownedRoot = {
      ...rootIdentity,
      parentExecutable: byPid.get(rootIdentity.ppid)?.executable,
      parentStartTime: byPid.get(rootIdentity.ppid)?.startTime ?? "",
    };
    input.ledger.set(processIdentityKey(rootIdentity), ownedRoot);
    if (input.root !== undefined) input.root.value = ownedRoot;
  }
  // Drop non-root ledger entries whose PID is free or whose identity no longer
  // matches the live process at that PID. Either case can block admission of a
  // legitimate child after PID reuse. Keep the root reservation even if the
  // root briefly disappears mid-teardown (finalizer retry still needs it).
  for (const [key, owned] of [...input.ledger.entries()]) {
    if (owned.pid === input.rootPid) continue;
    const live = byPid.get(owned.pid);
    if (live === undefined || !samePosixProcessIdentity(owned, live)) {
      input.ledger.delete(key);
    }
  }
  const children = new Map<number, Array<AcpPosixProcessIdentity>>();
  const retainedByPid = new Map(
    [...input.ledger.values()]
      .filter((owned) => samePosixProcessIdentity(owned, byPid.get(owned.pid)))
      .map((owned) => [owned.pid, owned]),
  );
  for (const process of table) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process);
    children.set(process.ppid, siblings);
  }
  const pending = [...input.ledger.values()].filter((owned) =>
    samePosixProcessIdentity(owned, byPid.get(owned.pid)),
  );
  const visited = new Set<number>();
  while (pending.length > 0) {
    const parent = pending.shift();
    if (parent === undefined || visited.has(parent.pid)) continue;
    visited.add(parent.pid);
    const observedParent = byPid.get(parent.pid);
    if (!samePosixProcessIdentity(parent, observedParent)) continue;
    const refreshedParent = { ...parent, ...observedParent };
    input.ledger.set(processIdentityKey(parent), refreshedParent);
    for (const process of children.get(refreshedParent.pid) ?? []) {
      const reservedPid = retainedByPid.get(process.pid);
      if (reservedPid !== undefined && !samePosixProcessIdentity(reservedPid, process)) continue;
      const owned =
        reservedPid === undefined
          ? {
              ...process,
              parentExecutable: refreshedParent.executable,
              parentStartTime: refreshedParent.startTime,
            }
          : { ...reservedPid, ...process };
      input.ledger.set(processIdentityKey(process), owned);
      retainedByPid.set(process.pid, owned);
      pending.push(owned);
    }
  }
  return table;
}

export function terminatePosixOwnedProcessTree(input: {
  readonly controller: AcpPosixProcessTreeController;
  readonly discoveryPasses?: number;
  readonly grace?: Duration.Input;
  readonly ledger?: Map<string, AcpOwnedPosixProcess>;
  readonly root?: AcpPosixOwnershipRoot;
  readonly rootPid: number;
}): Effect.Effect<void, AcpProcessGroupTerminationError> {
  // This portable fallback can only admit processes whose exact parent chain is
  // visible before it breaks. A descendant that double-forks before discovery
  // requires pre-exec cgroup containment for a hard ownership guarantee.
  const ledger = input.ledger ?? new Map<string, AcpOwnedPosixProcess>();

  const fail = (detail: string, cause?: unknown) =>
    new AcpProcessGroupTerminationError({ detail, ...(cause === undefined ? {} : { cause }) });
  const snapshot = () => {
    try {
      return input.controller.snapshot();
    } catch (cause) {
      throw fail(`Failed to snapshot ACP process tree ${input.rootPid}`, cause);
    }
  };
  const discover = (table: ReadonlyArray<AcpPosixProcessIdentity>) =>
    capturePosixOwnershipLedger({
      controller: input.controller,
      ledger,
      ...(input.root === undefined ? {} : { root: input.root }),
      rootPid: input.rootPid,
      table,
    });
  const signalPhase = (signal: NodeJS.Signals, includeRoot: boolean) => {
    const table = snapshot();
    discover(table);
    const byPid = new Map(table.map((entry) => [entry.pid, entry]));
    const current = input.controller.identity(process.pid);
    if (current === undefined) throw fail("Cannot identify the current T3 process group");
    const ledgerByPid = new Map(
      [...ledger.values()].map((process) => [process.pid, process] as const),
    );
    const pending = [...ledger.values()].filter(
      (candidate) =>
        (includeRoot || candidate.pid !== input.rootPid) &&
        samePosixProcessIdentity(candidate, byPid.get(candidate.pid)),
    );
    const retainedByPid = new Map(
      [...ledger.values()]
        .filter((owned) => samePosixProcessIdentity(owned, byPid.get(owned.pid)))
        .map((owned) => [owned.pid, owned]),
    );
    const signalled = new Set<number>();
    while (pending.length > 0) {
      pending.sort(
        (left, right) => processDepth(right, ledgerByPid) - processDepth(left, ledgerByPid),
      );
      const candidate = pending.shift();
      if (candidate === undefined || signalled.has(candidate.pid)) continue;
      const observed = input.controller.identity(candidate.pid);
      if (
        candidate.pid <= 1 ||
        candidate.pid === process.pid ||
        observed === undefined ||
        observed.pgid === current.pgid ||
        observed.sid === current.sid ||
        !samePosixProcessIdentity(candidate, observed)
      ) {
        continue;
      }
      for (const child of input.controller.childrenOf(candidate.pid)) {
        if (child.ppid !== candidate.pid) continue;
        const reservedPid = retainedByPid.get(child.pid);
        if (reservedPid !== undefined && !samePosixProcessIdentity(reservedPid, child)) continue;
        const owned =
          reservedPid === undefined
            ? {
                ...child,
                parentExecutable: observed.executable,
                parentStartTime: observed.startTime,
              }
            : { ...reservedPid, ...child };
        ledger.set(processIdentityKey(child), owned);
        ledgerByPid.set(child.pid, owned);
        retainedByPid.set(child.pid, owned);
        // Signal newly discovered children in this same pass (fork-during-kill).
        if (
          (includeRoot || child.pid !== input.rootPid) &&
          !signalled.has(child.pid) &&
          samePosixProcessIdentity(owned, input.controller.identity(child.pid))
        ) {
          pending.push(owned);
        }
      }
      try {
        // Linux starttime prevents PID reuse across observations, but Node does
        // not expose pidfd_send_signal. A final read-to-kill race remains.
        input.controller.signalProcess(candidate.pid, signal);
        signalled.add(candidate.pid);
      } catch (cause) {
        if (samePosixProcessIdentity(candidate, input.controller.identity(candidate.pid))) {
          throw fail(`Failed to signal ACP process ${candidate.pid}`, cause);
        }
      }
    }
  };

  return Effect.gen(function* () {
    const passes = Math.max(2, Math.min(input.discoveryPasses ?? 4, 8));
    for (let pass = 0; pass < passes; pass += 1) {
      yield* Effect.try({
        try: () => signalPhase("SIGTERM", false),
        catch: (cause) => cause as AcpProcessGroupTerminationError,
      });
      yield* Effect.sleep("10 millis");
    }
    yield* Effect.try({
      try: () => signalPhase("SIGTERM", true),
      catch: (cause) => cause as AcpProcessGroupTerminationError,
    });
    const grace = input.grace ?? "1 second";
    if (grace !== 0) yield* Effect.sleep(grace);
    for (let pass = 0; pass < passes; pass += 1) {
      yield* Effect.try({
        try: () => signalPhase("SIGKILL", true),
        catch: (cause) => cause as AcpProcessGroupTerminationError,
      });
      yield* Effect.sleep("10 millis");
    }
    const survivors = new Map(snapshot().map((entry) => [entry.pid, entry]));
    const residual = [...ledger.values()].filter((owned) => {
      const observed = survivors.get(owned.pid);
      if (!samePosixProcessIdentity(owned, observed) || observed === undefined) {
        return false;
      }
      // Already-killed zombies still appear in /proc until reaped; not live.
      return !posixProcessIsZombie(observed);
    });
    if (residual.length > 0) {
      return yield* fail(
        `ACP process tree ${input.rootPid} retained owned processes: ${residual.map((entry) => entry.pid).join(", ")}`,
      );
    }
  }).pipe(withWallClock);
}

export function windowsTaskkillResultIsSuccess(exitCode: number, _output?: string): boolean {
  return exitCode === 0;
}

export const terminateWindowsProcessTreeWithTaskkill = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  pid: number,
): Effect.Effect<void, AcpProcessGroupTerminationError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const taskkill = yield* spawner.spawn(
        ChildProcess.make("taskkill", ["/PID", String(pid), "/T", "/F"]),
      );
      const outputFiber = yield* Stream.decodeText(taskkill.all).pipe(
        Stream.mkString,
        Effect.forkScoped,
      );
      const exitCode = Number(yield* taskkill.exitCode);
      const output = yield* Fiber.join(outputFiber);
      // A missing leader cannot prove that inherited descendants exited.
      if (windowsTaskkillResultIsSuccess(exitCode, output)) return;
      const trimmedOutput = output.trim();
      return yield* new AcpProcessGroupTerminationError({
        detail: `taskkill exited ${exitCode} for ACP process tree ${pid}`,
        pid,
        exitCode,
        ...(trimmedOutput.length === 0
          ? {}
          : { cause: trimmedOutput.length > 500 ? trimmedOutput.slice(0, 500) : trimmedOutput }),
      });
    }),
  ).pipe(
    Effect.mapError((cause) =>
      isAcpProcessGroupTerminationError(cause)
        ? cause
        : new AcpProcessGroupTerminationError({
            cause,
            detail: `Failed to run taskkill for ACP process tree ${pid}`,
            pid,
          }),
    ),
  );

export function selectAcpAgentAuthMethod(
  authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod> | undefined,
  preferredMethodId?: string,
): EffectAcpSchema.AuthMethod | undefined {
  const preferred = preferredMethodId?.trim();
  if (preferred) {
    return authMethods?.find((method) => method.id === preferred);
  }
  return authMethods?.find((method) => !("type" in method));
}

function isAcpAuthenticationRequired(error: EffectAcpErrors.AcpError): boolean {
  return error._tag === "AcpRequestError" && error.code === -32000;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.ForkSessionResponse
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
}

export interface AcpSessionActivationOptions {
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
}

export class AcpSessionRuntime extends Context.Service<
  AcpSessionRuntime,
  {
    /**
     * Registers a handler for `session/request_permission`.
     * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
     */
    readonly handleRequestPermission: EffectAcpClient.AcpClient["Service"]["handleRequestPermission"];
    /**
     * Registers a handler for `session/elicitation`.
     * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
     */
    readonly handleElicitation: EffectAcpClient.AcpClient["Service"]["handleElicitation"];
    /**
     * Registers a handler for `fs/read_text_file`.
     * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
     */
    readonly handleReadTextFile: EffectAcpClient.AcpClient["Service"]["handleReadTextFile"];
    /**
     * Registers a handler for `fs/write_text_file`.
     * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
     */
    readonly handleWriteTextFile: EffectAcpClient.AcpClient["Service"]["handleWriteTextFile"];
    /**
     * Registers a handler for `terminal/create`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/create
     */
    readonly handleCreateTerminal: EffectAcpClient.AcpClient["Service"]["handleCreateTerminal"];
    /**
     * Registers a handler for `terminal/output`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/output
     */
    readonly handleTerminalOutput: EffectAcpClient.AcpClient["Service"]["handleTerminalOutput"];
    /**
     * Registers a handler for `terminal/wait_for_exit`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
     */
    readonly handleTerminalWaitForExit: EffectAcpClient.AcpClient["Service"]["handleTerminalWaitForExit"];
    /**
     * Registers a handler for `terminal/kill`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/kill
     */
    readonly handleTerminalKill: EffectAcpClient.AcpClient["Service"]["handleTerminalKill"];
    /**
     * Registers a handler for `terminal/release`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/release
     */
    readonly handleTerminalRelease: EffectAcpClient.AcpClient["Service"]["handleTerminalRelease"];
    /**
     * Registers a handler for `session/update`.
     * @see https://agentclientprotocol.com/protocol/schema#session/update
     */
    readonly handleSessionUpdate: EffectAcpClient.AcpClient["Service"]["handleSessionUpdate"];
    /**
     * Registers a handler for `session/elicitation/complete`.
     * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
     */
    readonly handleElicitationComplete: EffectAcpClient.AcpClient["Service"]["handleElicitationComplete"];
    /**
     * Registers a fallback extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtRequest: EffectAcpClient.AcpClient["Service"]["handleUnknownExtRequest"];
    /**
     * Registers a fallback extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtNotification: EffectAcpClient.AcpClient["Service"]["handleUnknownExtNotification"];
    /**
     * Registers a typed extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtRequest: EffectAcpClient.AcpClient["Service"]["handleExtRequest"];
    /**
     * Registers a typed extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtNotification: EffectAcpClient.AcpClient["Service"]["handleExtNotification"];
    /**
     * Initializes the ACP connection, authenticates, and loads, resumes, or creates the session.
     * Concurrent calls share the same in-flight startup and a failed startup may be retried.
     */
    readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    /** Stream of parsed ACP session events emitted after startup. */
    readonly getEvents: () => Stream.Stream<AcpSessionRuntimeEvent, never>;
    /** Waits until the current event consumer has processed every queued event. */
    readonly drainEvents: Effect.Effect<void>;
    /** Latest mode state observed from session setup and `session/update` notifications. */
    readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
    /** Latest configuration options observed from session setup and configuration writes. */
    readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
    readonly loadSession: (
      sessionId: string,
      options?: AcpSessionActivationOptions,
    ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly resumeSession: (
      sessionId: string,
      options?: AcpSessionActivationOptions,
    ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly forkSession: (
      sessionId: string,
      options?: AcpSessionActivationOptions,
    ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly listSessions: (
      cursor?: string,
    ) => Effect.Effect<EffectAcpSchema.ListSessionsResponse, EffectAcpErrors.AcpError>;
    readonly closeSession: (
      sessionId?: string,
    ) => Effect.Effect<EffectAcpSchema.CloseSessionResponse, EffectAcpErrors.AcpError>;
    /**
     * Sends a prompt turn to the active session.
     * @see https://agentclientprotocol.com/protocol/schema#session/prompt
     */
    readonly prompt: (
      payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
    ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
    /**
     * Sends a real ACP `session/cancel` notification for the active session.
     * @see https://agentclientprotocol.com/protocol/schema#session/cancel
     */
    readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly processContainment:
      | "cgroup-v2"
      | "process-ledger-reduced-guarantee"
      | "process-group"
      | "none";
    /** Terminates the opt-in detached ACP process group and all inherited work. */
    readonly terminateProcessGroup?: Effect.Effect<void, AcpProcessGroupTerminationError>;
    /**
     * Selects the active mode through the negotiated `mode` configuration option.
     * This is a no-op when the requested mode is already active.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
     */
    readonly setMode: (
      modeId: string,
    ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
    /**
     * Updates a session configuration option and the runtime configuration snapshot.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
     */
    readonly setConfigOption: (
      configId: string,
      value: string | boolean,
    ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
    /**
     * Selects the base model through the negotiated model configuration option.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
     */
    readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    /**
     * Selects the active model through the unstable ACP `session/set_model` capability.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_model
     */
    readonly setSessionModel: (
      modelId: string,
    ) => Effect.Effect<EffectAcpSchema.SetSessionModelResponse, EffectAcpErrors.AcpError>;
    /**
     * Sends a generic ACP extension request and records it through the request logger.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly request: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
    /**
     * Sends a generic ACP extension notification.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly notify: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  }
>()("t3/provider/acp/AcpSessionRuntime") {
  static layer(
    options: AcpSessionRuntimeOptions,
  ): Layer.Layer<
    AcpSessionRuntime,
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  > {
    return Layer.effect(AcpSessionRuntime, make(options));
  }
}

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

export const make = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantItemRuntimeId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: "Failed to generate an ACP assistant item runtime identifier.",
            cause,
          }),
      ),
    );
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const startStateRef = yield* Ref.make<AcpStartState>({ _tag: "NotStarted" });
    const promptSerializationSemaphore = yield* Semaphore.make(1);
    const sessionLoadSemaphore = yield* Semaphore.make(1);
    const activePromptFiberRef = yield* Ref.make<
      Option.Option<Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>>
    >(Option.none());
    const sessionLoadGateRef = yield* Ref.make<Option.Option<SessionLoadGate>>(Option.none());

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.tap((result) =>
              logRequest({
                method,
                payload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method,
                payload,
                status: "failed",
                cause,
              }),
            ),
          ),
        ),
      );

    const spawnCommand = yield* resolveSpawnCommand(
      options.spawn.command,
      options.spawn.args,
      options.spawn.env ? { env: options.spawn.env, extendEnv: true } : {},
    );
    const linuxCgroupLease =
      options.ownDescendantProcessGroups === true && options.processGroupPlatform === "linux"
        ? yield* Effect.sync(() => {
            try {
              if (options.linuxCgroupController === null) return undefined;
              return (options.linuxCgroupController ?? makeLinuxCgroupController()).create();
            } catch {
              return undefined;
            }
          })
        : undefined;
    // This is lifecycle containment for inherited provider work. It is not a
    // security boundary against a provider that can modify its delegated cgroup.
    if (linuxCgroupLease !== undefined) {
      yield* Scope.addFinalizer(
        runtimeScope,
        Effect.uninterruptible(terminateLinuxCgroupLease(linuxCgroupLease)).pipe(
          Effect.ignoreCause({ log: true }),
        ),
      );
    }
    const containedTargetCommand =
      linuxCgroupLease === undefined || NodePath.isAbsolute(spawnCommand.command)
        ? spawnCommand.command
        : yield* Effect.gen(function* () {
            const resolved = resolveLinuxCgroupTargetCommand(
              spawnCommand.command,
              options.spawn.cwd ?? options.cwd,
              { ...process.env, ...options.spawn.env },
            );
            if (resolved !== undefined) return resolved;
            return yield* new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause: new Error("Contained ACP command was not found on PATH"),
            });
          });
    const containedSpawnCommand =
      linuxCgroupLease === undefined
        ? spawnCommand
        : {
            ...wrapCommandForLinuxCgroup(
              linuxCgroupLease,
              containedTargetCommand,
              spawnCommand.args,
            ),
            shell: false,
          };
    const spawnEnvironment =
      linuxCgroupLease === undefined
        ? options.spawn.env
        : {
            ...options.spawn.env,
            ELECTRON_RUN_AS_NODE: "1",
            T3_ACP_CGROUP_WRAPPER: "1",
          };
    const child = yield* spawner
      .spawn(
        ChildProcess.make(containedSpawnCommand.command, containedSpawnCommand.args, {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(spawnEnvironment ? { env: spawnEnvironment, extendEnv: true } : {}),
          ...(options.ownDetachedProcessGroup === undefined
            ? {}
            : { detached: options.ownDetachedProcessGroup }),
          shell: containedSpawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    const posixOwnershipLedger = new Map<string, AcpOwnedPosixProcess>();
    const posixOwnershipFrontier = new Map<number, AcpOwnedPosixProcess>();
    const posixOwnershipChildQueues = new Map<number, Array<number>>();
    const posixOwnershipRoot: AcpPosixOwnershipRoot = { value: undefined };
    const posixController =
      options.ownDescendantProcessGroups === true
        ? yield* Effect.try({
            try: () => {
              if (options.posixProcessTreeController !== undefined) {
                return options.posixProcessTreeController;
              }
              if (options.processGroupPlatform === undefined) {
                throw new AcpProcessGroupTerminationError({
                  detail: "POSIX ACP descendant ownership requires a supported host platform",
                });
              }
              return makePosixProcessTreeController(options.processGroupPlatform);
            },
            catch: (cause) =>
              new EffectAcpErrors.AcpSpawnError({ command: options.spawn.command, cause }),
          })
        : undefined;
    if (posixController !== undefined) {
      const observeOwnership = () =>
        observePosixOwnershipLedger({
          childQueues: posixOwnershipChildQueues,
          controller: posixController,
          frontier: posixOwnershipFrontier,
          ledger: posixOwnershipLedger,
          root: posixOwnershipRoot,
          rootPid: Number(child.pid),
        });
      yield* Effect.try({
        try: observeOwnership,
        catch: (cause) =>
          new EffectAcpErrors.AcpSpawnError({ command: options.spawn.command, cause }),
      });
      yield* observePosixOwnershipLedgerContinuously({
        childQueues: posixOwnershipChildQueues,
        controller: posixController,
        frontier: posixOwnershipFrontier,
        ledger: posixOwnershipLedger,
        root: posixOwnershipRoot,
        rootPid: Number(child.pid),
      }).pipe(Effect.forkIn(runtimeScope));
    }

    const signalOwnedProcessGroup = (signal: NodeJS.Signals) =>
      Effect.try({
        try: () => {
          process.kill(-Number(child.pid), signal);
          return true;
        },
        catch: (cause) =>
          new AcpProcessGroupTerminationError({
            cause,
            detail: `Failed to signal ACP process group ${child.pid} with ${signal}`,
          }),
      }).pipe(
        Effect.catch((error) => {
          const cause = error.cause as NodeJS.ErrnoException | undefined;
          return cause?.code === "ESRCH" ? Effect.succeed(false) : Effect.fail(error);
        }),
      );
    const terminateWindowsProcessTree =
      options.windowsProcessTreeTerminator ??
      ((pid: number) => terminateWindowsProcessTreeWithTaskkill(spawner, pid));
    const terminatePosixProcessTree = (grace: Duration.Input, platformOverride?: NodeJS.Platform) =>
      Effect.gen(function* () {
        const platform = platformOverride ?? options.processGroupPlatform;
        if (platform === undefined || platform === "win32") {
          return yield* new AcpProcessGroupTerminationError({
            detail: "POSIX ACP descendant ownership requires a supported host platform",
          });
        }
        const controller = yield* Effect.try({
          try: () => posixController ?? makePosixProcessTreeController(platform),
          catch: (cause) =>
            isAcpProcessGroupTerminationError(cause)
              ? cause
              : new AcpProcessGroupTerminationError({
                  cause,
                  detail: `Failed to initialize ACP descendant ownership on ${platform}`,
                }),
        });
        yield* terminatePosixOwnedProcessTree({
          controller,
          grace,
          ledger: posixOwnershipLedger,
          root: posixOwnershipRoot,
          rootPid: Number(child.pid),
        });
      });
    const terminateOwnedProcessGroupImpl = Effect.gen(function* () {
      if (options.ownDetachedProcessGroup !== true) return;
      if (options.processGroupPlatform === undefined) {
        return yield* new AcpProcessGroupTerminationError({
          detail: "Detached ACP process-group ownership requires a host platform",
        });
      }
      if (options.processGroupPlatform === "win32") {
        return yield* terminateWindowsProcessTree(Number(child.pid));
      }
      if (linuxCgroupLease !== undefined) {
        if (posixController !== undefined) {
          yield* Effect.sync(() =>
            signalLinuxCgroupRootTerm({
              controller: posixController,
              lease: linuxCgroupLease,
              root: posixOwnershipRoot,
            }),
          );
        }
        const grace = options.processGroupTerminationGrace ?? "1 second";
        if (grace !== 0) yield* Effect.sleep(grace);
        return yield* terminateLinuxCgroupLease(linuxCgroupLease);
      }
      if (options.ownDescendantProcessGroups === true) {
        return yield* terminatePosixProcessTree(options.processGroupTerminationGrace ?? "1 second");
      }
      const groupExisted = yield* signalOwnedProcessGroup("SIGTERM");
      if (!groupExisted) return;
      const grace = options.processGroupTerminationGrace ?? "1 second";
      if (grace !== 0) {
        yield* Effect.sleep(grace);
      }
      yield* signalOwnedProcessGroup("SIGKILL");
    }).pipe(withWallClock);
    const terminateProcessGroup = yield* Effect.cached(
      Effect.uninterruptible(terminateOwnedProcessGroupImpl),
    );
    if (options.ownDetachedProcessGroup === true) {
      const hostPlatform = yield* HostProcessPlatform;
      const forceTerminateOwnedProcessGroup =
        hostPlatform === "win32"
          ? terminateWindowsProcessTreeWithTaskkill(spawner, Number(child.pid))
          : linuxCgroupLease !== undefined
            ? terminateLinuxCgroupLease(linuxCgroupLease)
            : options.ownDescendantProcessGroups === true
              ? terminatePosixProcessTree(0, hostPlatform)
              : signalOwnedProcessGroup("SIGKILL").pipe(Effect.asVoid);
      yield* Scope.addFinalizer(
        runtimeScope,
        Effect.uninterruptible(forceTerminateOwnedProcessGroup).pipe(
          Effect.ignoreCause({ log: true }),
        ),
      );
    }

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        ...(options.protocolLogging?.logIncoming !== undefined
          ? { logIncoming: options.protocolLogging.logIncoming }
          : {}),
        ...(options.protocolLogging?.logOutgoing !== undefined
          ? { logOutgoing: options.protocolLogging.logOutgoing }
          : {}),
        ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
        ...(options.onIncomingRequest ? { onIncomingRequest: options.onIncomingRequest } : {}),
        onTermination: (error) =>
          (options.onTermination?.(error) ?? Effect.void).pipe(
            Effect.ensuring(
              Scope.close(runtimeScope, Exit.fail(error)).pipe(Effect.forkDetach, Effect.asVoid),
            ),
          ),
        ...(options.onOutgoingResponseFailure
          ? { onOutgoingResponseFailure: options.onOutgoingResponseFailure }
          : {}),
        ...(options.onOutgoingResponse ? { onOutgoingResponse: options.onOutgoingResponse } : {}),
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

    yield* acp.handleSessionUpdate((notification) =>
      Effect.gen(function* () {
        const gate = yield* Ref.get(sessionLoadGateRef);
        if (Option.isSome(gate) && gate.value.active) {
          if (sessionUpdateCountsAsLoadReplayActivity(notification, gate.value.sessionId)) {
            const lastActivityAtMillis = yield* Clock.currentTimeMillis;
            yield* Ref.set(
              sessionLoadGateRef,
              Option.some({
                ...gate.value,
                lastActivityAtMillis,
              }),
            );
          }
          return;
        }
        if (sessionUpdateIsReplay(notification)) {
          return;
        }
        const startState = yield* Ref.get(startStateRef);
        // One runtime projects one root ACP session. Child-session updates need
        // explicit lineage routing and must never be flattened into this stream.
        if (
          startState._tag !== "Started" ||
          notification.sessionId !== startState.result.sessionId
        ) {
          return;
        }
        yield* handleSessionUpdate({
          queue: eventQueue,
          modeStateRef,
          toolCallsRef,
          assistantSegmentRef,
          assistantItemRuntimeId,
          params: notification,
        });
      }),
    );
    const initializeClientCapabilities = {
      fs: {
        readTextFile: false,
        writeTextFile: false,
        ...options.clientCapabilities?.fs,
      },
      terminal: options.clientCapabilities?.terminal ?? false,
      ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
      ...(options.clientCapabilities?.elicitation
        ? { elicitation: options.clientCapabilities.elicitation }
        : {}),
      ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
    } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

    const getStartedState = Effect.gen(function* () {
      const state = yield* Ref.get(startStateRef);
      if (state._tag === "Started") {
        return state.result;
      }
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "ACP session runtime has not been started",
        cause: "ACP session runtime has not been started",
      });
    });

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
        if (!configOption) {
          return;
        }
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") {
            return;
          }
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected boolean`,
            data: {
              configId: configOption.id,
              expectedType: "boolean",
              receivedValue: value,
            },
          });
        }
        if (typeof value !== "string") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected string`,
            data: {
              configId: configOption.id,
              expectedType: "string",
              receivedValue: value,
            },
          });
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) {
          return;
        }
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
          data: {
            configId: configOption.id,
            allowedValues,
            receivedValue: value,
          },
        });
      });

    const updateConfigOptions = (
      response:
        | EffectAcpSchema.SetSessionConfigOptionResponse
        | EffectAcpSchema.ForkSessionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ): Effect.Effect<void> => Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(response));

    const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
      Ref.update(modeStateRef, (current) =>
        current ? { ...current, currentModeId: modeId } : current,
      );

    const adoptSession = (
      sessionId: string,
      sessionSetupResult:
        | EffectAcpSchema.ForkSessionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ): Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const current = yield* getStartedState;
        const meta = sessionSetupResult._meta;
        const syntheticReplayIdle =
          meta !== null &&
          typeof meta === "object" &&
          !Array.isArray(meta) &&
          (meta as { readonly t3SessionLoadReady?: unknown }).t3SessionLoadReady === "replay_idle";
        const extractedModelConfigId = extractModelConfigId(sessionSetupResult);
        const nextModelConfigId =
          extractedModelConfigId ?? (syntheticReplayIdle ? current.modelConfigId : undefined);
        const nextModeState = parseSessionModeState(sessionSetupResult);
        if (nextModeState !== undefined) {
          yield* Ref.set(modeStateRef, nextModeState);
        } else if (!syntheticReplayIdle) {
          yield* Ref.set(modeStateRef, undefined);
        }
        // Synthetic replay-idle load responses only carry initialize model/mode
        // meta; preserve live configOptions so setConfigOption still validates.
        if (
          sessionSetupResult.configOptions !== undefined &&
          sessionSetupResult.configOptions !== null
        ) {
          yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));
        } else if (!syntheticReplayIdle) {
          yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));
        }
        const nextState = {
          sessionId,
          initializeResult: current.initializeResult,
          sessionSetupResult,
          modelConfigId: nextModelConfigId,
        } satisfies AcpStartedState;
        yield* Ref.set(toolCallsRef, new Map());
        yield* Ref.set(assistantSegmentRef, { nextSegmentIndex: 0 });
        yield* Ref.set(startStateRef, { _tag: "Started", result: nextState });
        return nextState;
      });

    const runLoadSessionWithReplayIdle = (
      loadPayload: EffectAcpSchema.LoadSessionRequest,
      initializeResult: EffectAcpSchema.InitializeResponse,
    ): Effect.Effect<EffectAcpSchema.LoadSessionResponse, EffectAcpErrors.AcpError> =>
      sessionLoadSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const sessionLoadTimeout = Duration.fromInputUnsafe(
            options.sessionLoadTimeout ?? defaultSessionLoadTimeout,
          );
          const sessionLoadReplayIdleGap = Duration.fromInputUnsafe(
            options.sessionLoadReplayIdleGap ?? defaultSessionLoadReplayIdleGap,
          );

          yield* Ref.set(
            sessionLoadGateRef,
            Option.some({
              active: true,
              sessionId: loadPayload.sessionId,
              lastActivityAtMillis: undefined,
              idleGap: sessionLoadReplayIdleGap,
              initializeResult,
            }),
          );

          return yield* Effect.gen(function* () {
            yield* logRequest({
              method: "session/load",
              payload: loadPayload,
              status: "started",
            });

            const idleFiber = yield* waitForSessionLoadReplayIdle({
              gateRef: sessionLoadGateRef,
            }).pipe(Effect.forkIn(runtimeScope));
            const loaded = yield* Effect.raceFirst(
              acp.agent.loadSession(loadPayload),
              Fiber.join(idleFiber),
            ).pipe(
              Effect.ensuring(Fiber.interrupt(idleFiber).pipe(Effect.ignore)),
              Effect.timeoutOption(sessionLoadTimeout),
              Effect.flatMap((result) =>
                Option.match(result, {
                  onNone: () =>
                    Effect.fail(
                      new EffectAcpErrors.AcpTransportError({
                        operation: "call-rpc",
                        method: "session/load",
                        detail:
                          "session/load timed out waiting for RPC response or replay idle gap",
                        cause: undefined,
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
              Effect.tap((result) =>
                logRequest({
                  method: "session/load",
                  payload: loadPayload,
                  status: "succeeded",
                  result,
                }),
              ),
              Effect.onError((cause) =>
                logRequest({
                  method: "session/load",
                  payload: loadPayload,
                  status: "failed",
                  cause,
                }),
              ),
            );

            return loaded;
          }).pipe(Effect.ensuring(Ref.set(sessionLoadGateRef, Option.none())));
        }),
      );

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => getStartedState),
        Effect.flatMap((started) =>
          Ref.get(configOptionsRef).pipe(
            Effect.flatMap((configOptions) => {
              const existing = findSessionConfigOption(configOptions, configId);
              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions,
                } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
              }
              const requestPayload =
                typeof value === "boolean"
                  ? ({
                      sessionId: started.sessionId,
                      configId,
                      type: "boolean",
                      value,
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                  : ({
                      sessionId: started.sessionId,
                      configId,
                      value: String(value),
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
              return runLoggedRequest(
                "session/set_config_option",
                requestPayload,
                acp.agent.setSessionConfigOption(requestPayload),
              ).pipe(Effect.tap((response) => updateConfigOptions(response)));
            }),
          ),
        ),
      );

    const startOnce = Effect.gen(function* () {
      const initializePayload = {
        protocolVersion: 1,
        clientCapabilities: initializeClientCapabilities,
        clientInfo: options.clientInfo,
      } satisfies EffectAcpSchema.InitializeRequest;

      const initializeResult = yield* runLoggedRequest(
        "initialize",
        initializePayload,
        acp.agent.initialize(initializePayload),
      );

      const authenticateAfterRequired = (
        authRequiredError: EffectAcpErrors.AcpError,
      ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
        Effect.gen(function* () {
          const configuredAuthMethodId = options.authMethodId?.trim();
          const authMethod = selectAcpAgentAuthMethod(
            initializeResult.authMethods,
            configuredAuthMethodId,
          );
          if (
            configuredAuthMethodId &&
            initializeResult.authMethods !== undefined &&
            authMethod === undefined
          ) {
            return yield* new EffectAcpErrors.AcpTransportError({
              detail: `ACP agent did not advertise configured authentication method "${configuredAuthMethodId}"`,
              cause: { configuredAuthMethodId, authMethods: initializeResult.authMethods },
            });
          }
          if (authMethod !== undefined && "type" in authMethod) {
            return yield* new EffectAcpErrors.AcpTransportError({
              detail: `ACP authentication method "${authMethod.id}" requires ${authMethod.type} authentication, which cannot run inside a headless provider session`,
              cause: authMethod,
            });
          }

          const authMethodId = authMethod?.id ?? configuredAuthMethodId;
          if (!authMethodId) {
            return yield* authRequiredError;
          }

          const authenticatePayload = {
            methodId: authMethodId,
          } satisfies EffectAcpSchema.AuthenticateRequest;
          yield* runLoggedRequest(
            "authenticate",
            authenticatePayload,
            acp.agent.authenticate(authenticatePayload),
          );
        });

      const setupSession = Effect.gen(function* () {
        let sessionId: string;
        let sessionSetupResult:
          | EffectAcpSchema.LoadSessionResponse
          | EffectAcpSchema.NewSessionResponse
          | EffectAcpSchema.ResumeSessionResponse;
        if (options.resumeSessionId) {
          const loadPayload = {
            sessionId: options.resumeSessionId,
            cwd: options.cwd,
            mcpServers: options.mcpServers ?? [],
          } satisfies EffectAcpSchema.LoadSessionRequest;

          sessionId = options.resumeSessionId;
          sessionSetupResult = yield* runLoadSessionWithReplayIdle(loadPayload, initializeResult);
        } else {
          const createPayload = {
            cwd: options.cwd,
            mcpServers: options.mcpServers ?? [],
          } satisfies EffectAcpSchema.NewSessionRequest;
          const created = yield* runLoggedRequest(
            "session/new",
            createPayload,
            acp.agent.createSession(createPayload),
          );
          sessionId = created.sessionId;
          sessionSetupResult = created;
        }

        return { sessionId, sessionSetupResult };
      });

      const { sessionId, sessionSetupResult } = yield* setupSession.pipe(
        Effect.catch((error) =>
          isAcpAuthenticationRequired(error)
            ? authenticateAfterRequired(error).pipe(Effect.andThen(setupSession))
            : Effect.fail(error),
        ),
      );

      yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
      yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));

      const nextState = {
        sessionId,
        initializeResult,
        sessionSetupResult,
        modelConfigId: extractModelConfigId(sessionSetupResult),
      } satisfies AcpStartedState;
      return nextState;
    });

    const start = Effect.gen(function* () {
      const deferred = yield* Deferred.make<
        AcpSessionRuntimeStartResult,
        EffectAcpErrors.AcpError
      >();
      const effect = yield* Ref.modify(startStateRef, (state) => {
        switch (state._tag) {
          case "Started":
            return [Effect.succeed(state.result), state] as const;
          case "Starting":
            return [Deferred.await(state.deferred), state] as const;
          case "NotStarted":
            return [
              startOnce.pipe(
                Effect.tap((result) =>
                  Ref.set(startStateRef, { _tag: "Started", result }).pipe(
                    Effect.andThen(Deferred.succeed(deferred, result)),
                  ),
                ),
                Effect.onError((cause) =>
                  Deferred.failCause(deferred, cause).pipe(
                    Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                  ),
                ),
              ),
              { _tag: "Starting", deferred } satisfies AcpStartState,
            ] as const;
        }
      });
      return yield* effect;
    });

    return {
      processContainment:
        linuxCgroupLease !== undefined
          ? "cgroup-v2"
          : options.ownDescendantProcessGroups === true
            ? "process-ledger-reduced-guarantee"
            : options.ownDetachedProcessGroup === true
              ? "process-group"
              : "none",
      handleRequestPermission: acp.handleRequestPermission,
      handleElicitation: acp.handleElicitation,
      handleReadTextFile: acp.handleReadTextFile,
      handleWriteTextFile: acp.handleWriteTextFile,
      handleCreateTerminal: acp.handleCreateTerminal,
      handleTerminalOutput: acp.handleTerminalOutput,
      handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
      handleTerminalKill: acp.handleTerminalKill,
      handleTerminalRelease: acp.handleTerminalRelease,
      handleSessionUpdate: acp.handleSessionUpdate,
      handleElicitationComplete: acp.handleElicitationComplete,
      handleUnknownExtRequest: acp.handleUnknownExtRequest,
      handleUnknownExtNotification: acp.handleUnknownExtNotification,
      handleExtRequest: acp.handleExtRequest,
      handleExtNotification: acp.handleExtNotification,
      start: () => start,
      getEvents: () => Stream.fromQueue(eventQueue),
      drainEvents: Effect.gen(function* () {
        const acknowledge = yield* Deferred.make<void>();
        yield* Queue.offer(eventQueue, {
          _tag: "EventStreamBarrier",
          acknowledge,
        });
        yield* Deferred.await(acknowledge);
      }),
      getModeState: Ref.get(modeStateRef),
      getConfigOptions: Ref.get(configOptionsRef),
      loadSession: (sessionId, activationOptions) =>
        start.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId,
              cwd: options.cwd,
              mcpServers: activationOptions?.mcpServers ?? options.mcpServers ?? [],
            } satisfies EffectAcpSchema.LoadSessionRequest;
            return runLoadSessionWithReplayIdle(requestPayload, started.initializeResult);
          }),
          Effect.flatMap((response) => adoptSession(sessionId, response)),
        ),
      resumeSession: (sessionId, activationOptions) =>
        start.pipe(
          Effect.flatMap(() => {
            const requestPayload = {
              sessionId,
              cwd: options.cwd,
              mcpServers: activationOptions?.mcpServers ?? options.mcpServers ?? [],
            } satisfies EffectAcpSchema.ResumeSessionRequest;
            return runLoggedRequest(
              "session/resume",
              requestPayload,
              acp.agent.resumeSession(requestPayload),
            );
          }),
          Effect.flatMap((response) => adoptSession(sessionId, response)),
        ),
      forkSession: (sessionId, activationOptions) =>
        start.pipe(
          Effect.flatMap(() => {
            const requestPayload = {
              sessionId,
              cwd: options.cwd,
              mcpServers: activationOptions?.mcpServers ?? options.mcpServers ?? [],
            } satisfies EffectAcpSchema.ForkSessionRequest;
            return runLoggedRequest(
              "session/fork",
              requestPayload,
              acp.agent.forkSession(requestPayload),
            );
          }),
          Effect.flatMap((response) => adoptSession(response.sessionId, response)),
        ),
      listSessions: (cursor) => {
        const requestPayload = {
          cwd: options.cwd,
          ...(cursor === undefined ? {} : { cursor }),
        } satisfies EffectAcpSchema.ListSessionsRequest;
        return start.pipe(
          Effect.andThen(
            runLoggedRequest(
              "session/list",
              requestPayload,
              acp.agent.listSessions(requestPayload),
            ),
          ),
        );
      },
      closeSession: (sessionId) =>
        start.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId: sessionId ?? started.sessionId,
            } satisfies EffectAcpSchema.CloseSessionRequest;
            return runLoggedRequest(
              "session/close",
              requestPayload,
              acp.agent.closeSession(requestPayload),
            );
          }),
        ),
      prompt: (payload) =>
        promptSerializationSemaphore.withPermit(
          Effect.gen(function* () {
            const started = yield* getStartedState;
            yield* closeActiveAssistantSegment({
              queue: eventQueue,
              assistantSegmentRef,
            });
            const requestPayload = {
              sessionId: started.sessionId,
              ...payload,
            } satisfies EffectAcpSchema.PromptRequest;
            const cancelledResponse = {
              stopReason: "cancelled",
            } satisfies EffectAcpSchema.PromptResponse;
            const promptRpcFiber = yield* runLoggedRequest(
              "session/prompt",
              requestPayload,
              acp.agent.prompt(requestPayload),
            ).pipe(Effect.forkIn(runtimeScope));
            yield* Ref.set(activePromptFiberRef, Option.some(promptRpcFiber));
            return yield* Fiber.join(promptRpcFiber).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.succeed(cancelledResponse)
                  : Effect.failCause(cause),
              ),
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Fiber.interrupt(promptRpcFiber).pipe(Effect.ignore);
                  yield* Ref.set(activePromptFiberRef, Option.none());
                }),
              ),
              Effect.tap(() =>
                closeActiveAssistantSegment({
                  queue: eventQueue,
                  assistantSegmentRef,
                }),
              ),
            );
          }),
        ),
      cancel: getStartedState.pipe(
        Effect.flatMap((started) =>
          options.interruptPromptOnCancel === false
            ? acp.agent.cancel({
                sessionId: started.sessionId,
                ...(options.cancelMeta === undefined ? {} : { _meta: options.cancelMeta }),
              })
            : Effect.gen(function* () {
                const activePromptFiber = yield* Ref.get(activePromptFiberRef);
                if (Option.isSome(activePromptFiber)) {
                  yield* Fiber.interrupt(activePromptFiber.value).pipe(Effect.ignore);
                }
                yield* acp.agent
                  .cancel({
                    sessionId: started.sessionId,
                    ...(options.cancelMeta === undefined ? {} : { _meta: options.cancelMeta }),
                  })
                  .pipe(Effect.ignore, Effect.forkIn(runtimeScope));
              }),
        ),
      ),
      ...(options.ownDetachedProcessGroup === true ? { terminateProcessGroup } : {}),
      setMode: (modeId) =>
        Ref.get(modeStateRef).pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
            }
            return setConfigOption("mode", modeId).pipe(
              Effect.tap(() => updateCurrentModeId(modeId)),
              Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
            );
          }),
        ),
      setConfigOption,
      setModel: (model) =>
        getStartedState.pipe(
          Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
          Effect.asVoid,
        ),
      setSessionModel: (modelId) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId: started.sessionId,
              modelId,
            } satisfies EffectAcpSchema.SetSessionModelRequest;
            return runLoggedRequest(
              "session/set_model",
              requestPayload,
              acp.agent.setSessionModel(requestPayload),
            );
          }),
        ),
      request: (method, payload) =>
        runLoggedRequest(method, payload, acp.raw.request(method, payload)),
      notify: acp.raw.notify,
    } satisfies AcpSessionRuntime["Service"];
  });

export const layer = (
  options: AcpSessionRuntimeOptions,
): Layer.Layer<
  AcpSessionRuntime,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> => Layer.effect(AcpSessionRuntime, make(options));

function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

const handleSessionUpdate = ({
  queue,
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  assistantItemRuntimeId,
  params,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly assistantItemRuntimeId: string;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        yield* closeActiveAssistantSegment({
          queue,
          assistantSegmentRef,
        });
        const { previous, merged } = yield* Ref.modify(toolCallsRef, (current) => {
          const previous = current.get(event.toolCall.toolCallId);
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, nextToolCall);
          }
          return [{ previous, merged: nextToolCall }, next] as const;
        });
        if (!shouldEmitToolCallUpdate(previous, merged)) {
          continue;
        }
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          queue,
          assistantSegmentRef,
          sessionId: params.sessionId,
          assistantItemRuntimeId,
        });
        yield* Queue.offer(queue, {
          ...event,
          itemId,
        });
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}

function shouldEmitToolCallUpdate(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): boolean {
  if (next.status === "completed" || next.status === "failed") {
    return true;
  }
  if (!next.detail) {
    return false;
  }
  return previous === undefined || previous.title !== next.title || previous.detail !== next.detail;
}

const assistantItemId = (sessionId: string, runtimeId: string, segmentIndex: number) =>
  `assistant:${sessionId}:runtime:${runtimeId}:segment:${segmentIndex}`;

const ensureActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
  sessionId,
  assistantItemRuntimeId,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
  readonly assistantItemRuntimeId: string;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      const itemId = assistantItemId(sessionId, assistantItemRuntimeId, current.nextSegmentIndex);
      return [
        {
          itemId,
          startedEvent: {
            _tag: "AssistantItemStarted",
            itemId,
          } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>,
        },
        {
          nextSegmentIndex: current.nextSegmentIndex + 1,
          activeItemId: itemId,
        } satisfies AcpAssistantSegmentState,
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      result.startedEvent
        ? Queue.offer(queue, result.startedEvent).pipe(Effect.as(result.itemId))
        : Effect.succeed(result.itemId),
    ),
  );

const closeActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Ref.modify(assistantSegmentRef, (current) => {
    if (!current.activeItemId) {
      return [undefined, current] as const;
    }
    return [
      {
        _tag: "AssistantItemCompleted",
        itemId: current.activeItemId,
      } satisfies AcpParsedSessionEvent,
      {
        nextSegmentIndex: current.nextSegmentIndex,
      } satisfies AcpAssistantSegmentState,
    ] as const;
  }).pipe(Effect.flatMap((event) => (event ? Queue.offer(queue, event) : Effect.void)));
