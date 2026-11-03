// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const wallClock = Clock.Clock.defaultValue();
const withWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Clock.Clock, wallClock);
export class AcpProcessGroupTerminationError extends Schema.TaggedError<AcpProcessGroupTerminationError>()(
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

export interface AcpPosixProcessIdentity {
  readonly executable: string | undefined;
  readonly pgid: number;
  readonly pid: number;
  readonly ppid: number;
  readonly sid: number;
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

export interface AcpPosixOwnershipRoot {
  captureAttempted?: boolean;
  value: AcpOwnedPosixProcess | undefined;
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
    } catch {}
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
