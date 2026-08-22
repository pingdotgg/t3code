// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The contributor-run observer owns one exact native subprocess and bounded lifecycle timers outside the measured app tree.
import * as NodeChildProcess from "node:child_process";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeReadline from "node:readline";

import {
  RESOURCE_MONITOR_PROTOCOL_VERSION,
  ResourceMonitorEvent,
  type ResourceMonitorCapabilities,
  type ResourceMonitorCommand,
  type ResourceMonitorErrorEvent,
  type ResourceMonitorHelloEvent,
  type ResourceMonitorProcessSample,
  type ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type ProcessOwnership = "app" | "harness";

export type ProcessOwnerKind =
  | "electron-main"
  | "server"
  | "provider"
  | "terminal"
  | "internal-monitor"
  | "app-helper"
  | "runner"
  | "observer"
  | "replay-provider"
  | "terminal-controller";

export interface DeclaredProcessRoot {
  readonly identity: { readonly pid: number; readonly startTimeMs: number };
  readonly ownership: ProcessOwnership;
  readonly kind: ProcessOwnerKind;
  readonly label: string;
}

export interface ObservedResourceSnapshot {
  /** Standalone observer clock; never subtracted from renderer/driver clocks. */
  readonly monotonicTimeMs: number;
  readonly snapshot: ResourceMonitorSnapshotEvent;
}

export interface ClassifiedProcessSample {
  readonly process: ResourceMonitorProcessSample;
  readonly root: DeclaredProcessRoot;
}

export interface ClassifiedResourceSnapshot {
  readonly monotonicTimeMs: number;
  readonly sequence: number;
  readonly sampledAtUnixMs: number;
  readonly collectionDurationMicros: number;
  readonly included: ReadonlyArray<ClassifiedProcessSample>;
  readonly excluded: ReadonlyArray<ClassifiedProcessSample>;
  readonly unknown: ReadonlyArray<ResourceMonitorProcessSample>;
  readonly identityFailures: ReadonlyArray<string>;
}

/** Native sysinfo samples report start times at whole-second precision. */
export const PROCESS_IDENTITY_START_TIME_PRECISION_MS = 1_000;

export function processIdentityMatches(
  process: Pick<ResourceMonitorProcessSample, "pid" | "startTimeMs">,
  expected: { readonly pid: number; readonly startTimeMs: number },
): boolean {
  return (
    process.pid === expected.pid &&
    process.startTimeMs ===
      expected.startTimeMs - (expected.startTimeMs % PROCESS_IDENTITY_START_TIME_PRECISION_MS)
  );
}

function declaredIdentityMatches(
  left: { readonly pid: number; readonly startTimeMs: number },
  right: { readonly pid: number; readonly startTimeMs: number },
): boolean {
  return left.pid === right.pid && left.startTimeMs === right.startTimeMs;
}

/**
 * Classifies by declared roots and ancestry, never by executable names. PID
 * identity includes start time so a reused PID cannot inherit prior ownership.
 */
export function classifyResourceSnapshot(
  observed: ObservedResourceSnapshot,
  roots: ReadonlyArray<DeclaredProcessRoot>,
): ClassifiedResourceSnapshot {
  const byPid = new Map(observed.snapshot.processes.map((process) => [process.pid, process]));
  const declaredByPid = new Map<number, DeclaredProcessRoot[]>();
  for (const root of roots) {
    const entries = declaredByPid.get(root.identity.pid) ?? [];
    entries.push(root);
    declaredByPid.set(root.identity.pid, entries);
  }
  const included: ClassifiedProcessSample[] = [];
  const excluded: ClassifiedProcessSample[] = [];
  const unknown: ResourceMonitorProcessSample[] = [];
  const identityFailures: string[] = [];

  const rootForProcess = (
    process: ResourceMonitorProcessSample,
  ): DeclaredProcessRoot | undefined => {
    const visited = new Set<number>();
    let current: ResourceMonitorProcessSample | undefined = process;
    while (current !== undefined && !visited.has(current.pid)) {
      visited.add(current.pid);
      const declarations = declaredByPid.get(current.pid) ?? [];
      const matching = declarations.find((root) => processIdentityMatches(current!, root.identity));
      if (matching !== undefined) return matching;
      if (declarations.length > 0) {
        identityFailures.push(
          `PID ${current.pid} was declared with a different start time (observed ${current.startTimeMs})`,
        );
        return undefined;
      }
      current = byPid.get(current.ppid);
    }
    return undefined;
  };

  for (const process of observed.snapshot.processes) {
    const root = rootForProcess(process);
    if (root === undefined) {
      unknown.push(process);
      continue;
    }
    const classified = { process, root };
    if (root.ownership === "app") included.push(classified);
    else excluded.push(classified);
  }
  return {
    monotonicTimeMs: observed.monotonicTimeMs,
    sequence: observed.snapshot.sequence,
    sampledAtUnixMs: observed.snapshot.sampledAtUnixMs,
    collectionDurationMicros: observed.snapshot.collectionDurationMicros,
    included,
    excluded,
    unknown,
    identityFailures: [...new Set(identityFailures)],
  };
}

export interface ResourceCadenceValidation {
  readonly valid: boolean;
  readonly requestedIntervalMs: number;
  readonly expectedSampleCount: number;
  readonly receivedSampleCount: number;
  readonly achievedIntervalMs: number | null;
  readonly maximumGapMs: number;
  readonly coverageRatio: number;
  readonly reasons: ReadonlyArray<string>;
}

export function validateResourceCadence(options: {
  readonly samples: ReadonlyArray<ObservedResourceSnapshot>;
  readonly requestedIntervalMs: number;
  readonly windowStartTimeMs: number;
  readonly windowEndTimeMs: number;
  readonly monitorErrors?: ReadonlyArray<ResourceMonitorErrorEvent | string>;
}): ResourceCadenceValidation {
  const durationMs = Math.max(0, options.windowEndTimeMs - options.windowStartTimeMs);
  const expectedSampleCount =
    options.requestedIntervalMs > 0 ? Math.floor(durationMs / options.requestedIntervalMs) : 0;
  const samples = options.samples
    .filter(
      (sample) =>
        sample.monotonicTimeMs >= options.windowStartTimeMs &&
        sample.monotonicTimeMs <= options.windowEndTimeMs,
    )
    .toSorted((left, right) => left.monotonicTimeMs - right.monotonicTimeMs);
  const gaps: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    gaps.push(samples[index]!.monotonicTimeMs - samples[index - 1]!.monotonicTimeMs);
  }
  const maximumGapMs = gaps.length === 0 ? 0 : Math.max(...gaps);
  const coverageRatio = expectedSampleCount === 0 ? 0 : samples.length / expectedSampleCount;
  const achievedIntervalMs =
    samples.length < 2
      ? null
      : (samples.at(-1)!.monotonicTimeMs - samples[0]!.monotonicTimeMs) / (samples.length - 1);
  const reasons: string[] = [];
  if (!(options.requestedIntervalMs > 0)) reasons.push("requested cadence must be positive");
  if (coverageRatio < 0.95) reasons.push("fewer than 95% of expected resource samples arrived");
  if (maximumGapMs > options.requestedIntervalMs * 2) {
    reasons.push("a resource sample gap exceeded twice the requested cadence");
  }
  for (const error of options.monitorErrors ?? []) {
    reasons.push(
      typeof error === "string"
        ? `resource monitor error: ${error}`
        : `resource monitor error: ${error.code}`,
    );
  }
  return {
    valid: reasons.length === 0,
    requestedIntervalMs: options.requestedIntervalMs,
    expectedSampleCount,
    receivedSampleCount: samples.length,
    achievedIntervalMs,
    maximumGapMs,
    coverageRatio,
    reasons,
  };
}

function percentile(values: ReadonlyArray<number>, quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export interface ProcessFamilyMetrics {
  readonly valid: boolean;
  readonly peakResidentBytes: number;
  readonly quiescentCpuP95Pct: number | null;
  readonly processCountPeak: number;
  readonly ioSemantics: ReadonlyArray<ResourceMonitorProcessSample["ioSemantics"]>;
  readonly samples: ReadonlyArray<{
    readonly monotonicTimeMs: number;
    readonly residentBytes: number;
    readonly cpuPercent: number;
    readonly processCount: number;
  }>;
  readonly reasons: ReadonlyArray<string>;
}

export function deriveProcessFamilyMetrics(options: {
  readonly samples: ReadonlyArray<ObservedResourceSnapshot>;
  readonly roots: ReadonlyArray<DeclaredProcessRoot>;
  readonly quiescentWindow?: { readonly startTimeMs: number; readonly endTimeMs: number };
}): ProcessFamilyMetrics {
  const classified = options.samples.map((sample) =>
    classifyResourceSnapshot(sample, options.roots),
  );
  const reasons = classified.flatMap((sample) => [
    ...sample.identityFailures,
    ...sample.unknown.map(
      (process) => `process ${process.pid}:${process.startTimeMs} has no declared ownership`,
    ),
  ]);
  if (classified.length === 0) reasons.push("no resource samples were collected");
  const samples = classified.map((sample) => ({
    monotonicTimeMs: sample.monotonicTimeMs,
    residentBytes: sample.included.reduce(
      (total, classifiedProcess) => total + classifiedProcess.process.residentBytes,
      0,
    ),
    cpuPercent: sample.included.reduce(
      (total, classifiedProcess) => total + classifiedProcess.process.cpuPercent,
      0,
    ),
    processCount: sample.included.length,
  }));
  const quiescentSamples =
    options.quiescentWindow === undefined
      ? []
      : samples.filter(
          (sample) =>
            sample.monotonicTimeMs >= options.quiescentWindow!.startTimeMs &&
            sample.monotonicTimeMs <= options.quiescentWindow!.endTimeMs,
        );
  const ioSemantics = new Set<ResourceMonitorProcessSample["ioSemantics"]>();
  for (const sample of classified) {
    for (const process of sample.included) ioSemantics.add(process.process.ioSemantics);
  }
  return {
    valid: reasons.length === 0,
    peakResidentBytes: samples.reduce(
      (maximum, sample) => Math.max(maximum, sample.residentBytes),
      0,
    ),
    quiescentCpuP95Pct:
      options.quiescentWindow === undefined || quiescentSamples.length === 0
        ? null
        : percentile(
            quiescentSamples.map((sample) => sample.cpuPercent),
            0.95,
          ),
    processCountPeak: samples.reduce(
      (maximum, sample) => Math.max(maximum, sample.processCount),
      0,
    ),
    ioSemantics: [...ioSemantics].toSorted(),
    samples,
    reasons: [...new Set(reasons)],
  };
}

export interface ObserverOverheadCharacterization {
  readonly valid: boolean;
  readonly cpuP95Pct: number;
  readonly collectionDurationP95Ms: number;
  readonly reasons: ReadonlyArray<string>;
}

export function characterizeObserverOverhead(options: {
  readonly observerCpuPercent: ReadonlyArray<number>;
  readonly collectionDurationMicros: ReadonlyArray<number>;
  readonly requestedIntervalMs: number;
}): ObserverOverheadCharacterization {
  const cpuP95Pct = percentile(options.observerCpuPercent, 0.95);
  const collectionDurationP95Ms = percentile(options.collectionDurationMicros, 0.95) / 1_000;
  const reasons: string[] = [];
  if (options.observerCpuPercent.length === 0 || options.collectionDurationMicros.length === 0) {
    reasons.push("observer overhead control run had no samples");
  }
  if (cpuP95Pct > 1) reasons.push("observer p95 CPU exceeded 1% of one logical core");
  if (collectionDurationP95Ms >= options.requestedIntervalMs * 0.25) {
    reasons.push("observer collection p95 reached 25% of the requested cadence");
  }
  return { valid: reasons.length === 0, cpuP95Pct, collectionDurationP95Ms, reasons };
}

export interface StandaloneResourceMonitor {
  readonly pid: number;
  readonly capabilities: ResourceMonitorCapabilities;
  readonly samples: ReadonlyArray<ObservedResourceSnapshot>;
  readonly errors: ReadonlyArray<ResourceMonitorErrorEvent | string>;
  setSampleInterval(sampleIntervalMs: number): void;
  stop(): Promise<void>;
}

const decodeMonitorEvent = Schema.decodeUnknownSync(ResourceMonitorEvent);

function sendCommand(
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  command: ResourceMonitorCommand,
): void {
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

export function resourceMonitorConfiguration(options: {
  readonly roots: ReadonlyArray<DeclaredProcessRoot>;
  readonly primaryRoot: DeclaredProcessRoot;
  readonly sampleIntervalMs: number;
}): Extract<ResourceMonitorCommand, { readonly type: "configure" }> {
  if (options.primaryRoot.ownership !== "app") {
    throw new Error("resource monitor primary root must be app-owned");
  }
  const appRoots = options.roots.filter((root) => root.ownership === "app");
  if (
    !appRoots.some((root) => declaredIdentityMatches(root.identity, options.primaryRoot.identity))
  ) {
    throw new Error("resource monitor primary root must be present in declared roots");
  }
  return {
    version: RESOURCE_MONITOR_PROTOCOL_VERSION,
    type: "configure",
    rootPid: options.primaryRoot.identity.pid,
    sampleIntervalMs: options.sampleIntervalMs,
    externalProcesses: appRoots
      .filter((root) => !declaredIdentityMatches(root.identity, options.primaryRoot.identity))
      .map((root) => ({ ...root.identity })),
  };
}

export interface ResourceMonitorShutdownTimeouts {
  readonly gracefulMs: number;
  readonly terminateMs: number;
  readonly killMs: number;
}

const DEFAULT_RESOURCE_MONITOR_SHUTDOWN_TIMEOUTS: ResourceMonitorShutdownTimeouts = {
  gracefulMs: 5_000,
  terminateMs: 2_000,
  killMs: 2_000,
};

function childHasExited(child: NodeChildProcess.ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForOwnedChildExit(
  child: NodeChildProcess.ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), Math.max(0, timeoutMs));
    child.once("exit", onExit);
    // Cover an exit that raced between the first check and listener install.
    if (childHasExited(child)) finish(true);
  });
}

/**
 * Stops only the supplied child handle. Every lifecycle stage is bounded, and
 * a child that survives SIGKILL is reported instead of being awaited forever.
 */
export async function stopOwnedResourceMonitorProcess(
  child: NodeChildProcess.ChildProcess,
  requestGracefulShutdown: () => void,
  timeouts: ResourceMonitorShutdownTimeouts = DEFAULT_RESOURCE_MONITOR_SHUTDOWN_TIMEOUTS,
): Promise<void> {
  if (childHasExited(child)) return;
  try {
    requestGracefulShutdown();
  } catch {
    // A closed protocol pipe only skips the graceful request; the exact child
    // handle still proceeds through bounded signal escalation below.
  }
  if (await waitForOwnedChildExit(child, timeouts.gracefulMs)) return;
  child.kill("SIGTERM");
  if (await waitForOwnedChildExit(child, timeouts.terminateMs)) return;
  child.kill("SIGKILL");
  if (await waitForOwnedChildExit(child, timeouts.killMs)) return;
  throw new Error(
    `resource monitor PID ${child.pid ?? "unknown"} survived bounded SIGKILL cleanup`,
  );
}

/**
 * Spawns the native monitor as a harness-owned sibling of the app. Only
 * app-owned roots are configured, so the observer, runner, replay provider,
 * and workload controllers cannot enter the application totals.
 */
export async function startStandaloneResourceMonitor(options: {
  readonly executablePath: string;
  readonly roots: ReadonlyArray<DeclaredProcessRoot>;
  readonly primaryRoot: DeclaredProcessRoot;
  readonly sampleIntervalMs: number;
  readonly handshakeTimeoutMs?: number;
}): Promise<StandaloneResourceMonitor> {
  const configuration = resourceMonitorConfiguration(options);
  const child = NodeChildProcess.spawn(options.executablePath, [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  // The protocol reports structured failures on stdout. Drain stderr so a
  // defensive native diagnostic can never fill its pipe and stall sampling.
  child.stderr.resume();
  child.stdin.on("error", () => {
    // Exit and protocol health are surfaced through the owned child/events.
  });
  const samples: ObservedResourceSnapshot[] = [];
  const errors: Array<ResourceMonitorErrorEvent | string> = [];
  let stopping = false;
  let hello: ResourceMonitorHelloEvent | undefined;
  let resolveHello: (() => void) | undefined;
  let rejectHello: ((error: Error) => void) | undefined;
  let resolveFirstSample: (() => void) | undefined;
  let rejectFirstSample: ((error: Error) => void) | undefined;
  const helloPromise = new Promise<void>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const firstSamplePromise = new Promise<void>((resolve, reject) => {
    resolveFirstSample = resolve;
    rejectFirstSample = reject;
  });
  const lines = NodeReadline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event: ReturnType<typeof decodeMonitorEvent>;
    try {
      event = decodeMonitorEvent(JSON.parse(line));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (hello === undefined) rejectHello?.(failure);
      else errors.push(`resource monitor output decode failed: ${failure.message}`);
      return;
    }
    switch (event.type) {
      case "hello":
        hello = event;
        resolveHello?.();
        return;
      case "snapshot":
        samples.push({ monotonicTimeMs: NodePerfHooks.performance.now(), snapshot: event });
        resolveFirstSample?.();
        return;
      case "error":
        errors.push(event);
        return;
      case "historyChunk":
        return;
    }
  });
  child.once("error", (error) => {
    if (hello === undefined) rejectHello?.(error);
    else {
      rejectFirstSample?.(error);
      errors.push(`resource monitor process error: ${error.message}`);
    }
  });
  child.once("exit", (code) => {
    if (hello === undefined) {
      rejectHello?.(new Error(`resource monitor exited with code ${code ?? -1}`));
    } else if (!stopping) {
      rejectFirstSample?.(new Error(`resource monitor exited with code ${code ?? -1}`));
      errors.push(`resource monitor exited unexpectedly with code ${code ?? -1}`);
    }
  });
  const timeoutMs = options.handshakeTimeoutMs ?? 5_000;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      helloPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`resource monitor handshake timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    try {
      await stopOwnedResourceMonitorProcess(child, () =>
        sendCommand(child, { version: RESOURCE_MONITOR_PROTOCOL_VERSION, type: "shutdown" }),
      );
    } catch (cleanupError) {
      lines.close();
      const startupMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `resource monitor startup failed (${startupMessage}) and its owned child did not clean up`,
        { cause: cleanupError },
      );
    }
    lines.close();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (hello === undefined) throw new Error("resource monitor omitted hello event");
  sendCommand(child, configuration);
  sendCommand(child, {
    version: RESOURCE_MONITOR_PROTOCOL_VERSION,
    type: "setStreaming",
    enabled: true,
  });
  let firstSampleTimeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      firstSamplePromise,
      new Promise<never>((_, reject) => {
        firstSampleTimeout = setTimeout(
          () => reject(new Error(`resource monitor first sample timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    try {
      await stopOwnedResourceMonitorProcess(child, () =>
        sendCommand(child, { version: RESOURCE_MONITOR_PROTOCOL_VERSION, type: "shutdown" }),
      );
    } finally {
      lines.close();
    }
    throw error;
  } finally {
    if (firstSampleTimeout !== undefined) clearTimeout(firstSampleTimeout);
  }

  let stopped = false;
  return {
    pid: child.pid!,
    capabilities: hello.capabilities,
    get samples() {
      return samples;
    },
    get errors() {
      return errors;
    },
    setSampleInterval(sampleIntervalMs) {
      if (stopped) throw new Error("resource monitor is stopped");
      sendCommand(child, {
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "setSampleInterval",
        sampleIntervalMs,
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) {
        lines.close();
        return;
      }
      try {
        await stopOwnedResourceMonitorProcess(child, () =>
          sendCommand(child, { version: RESOURCE_MONITOR_PROTOCOL_VERSION, type: "shutdown" }),
        );
      } finally {
        lines.close();
      }
    },
  };
}
