// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
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
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { AgentScope, AgentScopeThreadId, RAISE_OOM_SCORE_LINE } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "./stderr.ts";
import {
  collectSessionConfigOptionValues,
  decideToolCallUpdateEmission,
  extractModelConfigId,
  findModelConfigOption,
  findSessionConfigOption,
  mergeToolCallState,
  toolCallProgressLength,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./runtimeModel.ts";

import {
  AcpProcessGroupTerminationError,
  defaultCgroupOwnerIsAlive,
  defaultReadCgroupPopulated,
  isAcpProcessGroupTerminationError,
  isSafeCgroupPath,
  makeLinuxCgroupController,
  parseCgroup2Mounts,
  parseUnifiedCgroupPath,
  resolveLinuxCgroupTargetCommand,
  sweepStaleLinuxCgroupSiblings,
  tryCreateLinuxCgroupLease,
  wrapCommandForLinuxCgroup,
} from "./acpLinuxCgroup.ts";
import type {
  AcpLinuxCgroupController,
  AcpLinuxCgroupLease,
  AcpOwnedPosixProcess,
  AcpPosixOwnershipRoot,
  AcpPosixProcessIdentity,
  AcpPosixProcessTreeController,
} from "./acpLinuxCgroup.ts";

// OS-state polls need wall time; TestClock sleep requires explicit advancement.
export const wallClock = Clock.Clock.defaultValue();
export const withWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
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
    let lastRemovalFailure: { readonly cause: unknown } | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!lease.exists()) return;
      const killed = yield* Effect.try(() => lease.kill()).pipe(Effect.result);
      if (Result.isFailure(killed)) {
        const cause = killed.failure.cause;
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") return yield* failure("kill", cause);
        if (!lease.exists()) return;
        yield* Effect.sleep("10 millis");
        continue;
      }
      const populated = yield* Effect.try(() => lease.populated()).pipe(Effect.result);
      if (Result.isFailure(populated)) {
        const cause = populated.failure.cause;
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" && !lease.exists()) return;
        if (code === "ENOENT") {
          yield* Effect.sleep("10 millis");
          continue;
        }
        return yield* failure("read state for", cause);
      }
      if (populated.success) {
        lastRemovalFailure = null;
        yield* Effect.sleep("10 millis");
        continue;
      }
      const removed = yield* Effect.try(() => lease.remove()).pipe(Effect.result);
      if (Result.isFailure(removed)) {
        const cause = removed.failure.cause;
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" && !lease.exists()) return;
        if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "ENOENT") {
          return yield* failure("remove", cause);
        }
        lastRemovalFailure = { cause };
      } else {
        lastRemovalFailure = null;
      }
      if (!lease.exists()) return;
      yield* Effect.sleep("10 millis");
    }
    if (lastRemovalFailure !== null) {
      return yield* failure("remove", lastRemovalFailure.cause);
    }
    return yield* new AcpProcessGroupTerminationError({
      detail: `ACP cgroup ${lease.path} remained present after cgroup cleanup`,
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
  } catch {}
}

export function readLinuxProcessIdentity(pid: number): AcpPosixProcessIdentity | undefined {
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

export function readLinuxChildPids(pid: number): ReadonlyArray<number> {
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
    } catch {}
  }
  return [...childPids];
}

export function makeLinuxProcessTreeController(): AcpPosixProcessTreeController {
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
        input.frontier.delete(child.pid);
        for (const [key, owned] of input.ledger.entries()) {
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

export function samePosixProcessIdentity(
  expected: AcpPosixProcessIdentity,
  observed: AcpPosixProcessIdentity | undefined,
): boolean {
  return (
    observed !== undefined &&
    observed.pid === expected.pid &&
    observed.startTime === expected.startTime
  );
}


export function processIdentityKey(process: AcpPosixProcessIdentity): string {
  return `${process.pid}:${process.startTime}`;
}

export function processDepth(
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
  // Expire stale identities to allow PID reuse; retain the root reservation for finalizer retries.
  for (const [key, owned] of input.ledger.entries()) {
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
  // Parent-chain discovery misses early double-forks; only pre-exec cgroups guarantee ownership.
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
        // Node lacks pidfd_send_signal, so starttime checks still leave a read-to-kill race.
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
    const finalTable = snapshot();
    discover(finalTable);
    const survivors = new Map(finalTable.map((entry) => [entry.pid, entry]));
    const residual = [...ledger.values()].filter((owned) => {
      const observed = survivors.get(owned.pid);
      if (!samePosixProcessIdentity(owned, observed) || observed === undefined) {
        return false;
      }
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
  pid: number,
): Effect.Effect<void, AcpProcessGroupTerminationError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
