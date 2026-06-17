import type {
  DesktopElectronProcessMetric,
  DesktopHostTelemetrySnapshot,
  ResourceMonitorProcessSample,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryAggregate,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MAX_DELTA_INTERVAL_MS = 30_000;
const ELECTRON_IDENTITY_TOLERANCE_MS = 2_000;

export interface ProcessState {
  readonly process: ResourceTelemetryProcess;
  readonly sampledAtMs: number;
}

export interface GroupCounters {
  readonly cpuTimeMs: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
  readonly processStarts: number;
  readonly processExits: number;
}

export interface TelemetryCounters {
  readonly backend: GroupCounters;
  readonly electron: GroupCounters;
  readonly monitor: GroupCounters;
  readonly allT3: GroupCounters;
}

export interface ProcessDelta {
  readonly identityKey: string;
  readonly category: ResourceTelemetryProcessCategory;
  readonly cpuTimeMs: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

export interface MergeProcessesInput {
  readonly serverPid: number;
  readonly sidecarPid: Option.Option<number>;
  readonly fallbackSampledAtMs: number;
  readonly nativeSnapshot: Option.Option<ResourceMonitorSnapshotEvent>;
  readonly desktopSnapshot: Option.Option<DesktopHostTelemetrySnapshot>;
  readonly electronRootPids?: ReadonlySet<number>;
  readonly previous: ReadonlyMap<string, ProcessState>;
  readonly counters: TelemetryCounters;
  readonly updatePrevious: boolean;
}

export interface MergeProcessesResult {
  readonly sampledAtMs: number;
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly previous: ReadonlyMap<string, ProcessState>;
  readonly counters: TelemetryCounters;
  readonly groups: {
    readonly backend: ResourceTelemetryAggregate;
    readonly electron: ResourceTelemetryAggregate;
    readonly monitor: ResourceTelemetryAggregate;
    readonly allT3: ResourceTelemetryAggregate;
  };
  readonly deltas: ReadonlyArray<ProcessDelta>;
}

export const emptyGroupCounters = (): GroupCounters => ({
  cpuTimeMs: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  processStarts: 0,
  processExits: 0,
});

export const emptyTelemetryCounters = (): TelemetryCounters => ({
  backend: emptyGroupCounters(),
  electron: emptyGroupCounters(),
  monitor: emptyGroupCounters(),
  allT3: emptyGroupCounters(),
});

export function processIdentityKey(pid: number, startTimeMs: number): string {
  return `${pid}:${startTimeMs}`;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function categoryGroup(
  category: ResourceTelemetryProcessCategory,
): "backend" | "electron" | "monitor" {
  if (category === "resource-monitor") return "monitor";
  if (category.startsWith("electron-")) return "electron";
  return "backend";
}

function electronCategory(metric: DesktopElectronProcessMetric): ResourceTelemetryProcessCategory {
  switch (metric.type) {
    case "Browser":
      return "electron-main";
    case "Tab":
      return "electron-renderer";
    case "GPU":
      return "electron-gpu";
    default:
      return "electron-utility";
  }
}

function inferredElectronCategory(
  process: ResourceMonitorProcessSample,
): ResourceTelemetryProcessCategory {
  const command = process.command.toLowerCase();
  if (command.includes("--type=renderer")) return "electron-renderer";
  if (command.includes("--type=gpu-process")) return "electron-gpu";
  return "electron-utility";
}

function matchElectronMetric(
  process: ResourceMonitorProcessSample,
  metricsByPid: ReadonlyMap<number, DesktopElectronProcessMetric>,
): DesktopElectronProcessMetric | undefined {
  const metric = metricsByPid.get(process.pid);
  if (!metric) return undefined;
  return Math.abs(metric.creationTimeMs - process.startTimeMs) <= ELECTRON_IDENTITY_TOLERANCE_MS
    ? metric
    : undefined;
}

function syntheticNativeSample(
  metric: DesktopElectronProcessMetric,
  sampledAtMs: number,
): ResourceMonitorProcessSample {
  return {
    pid: metric.pid,
    ppid: 0,
    startTimeMs: metric.creationTimeMs,
    runTimeMs: Math.max(0, sampledAtMs - metric.creationTimeMs),
    name: metric.name ?? metric.serviceName ?? metric.type,
    command: metric.name ?? metric.serviceName ?? metric.type,
    status: "Running",
    cpuPercent: metric.cpuPercent,
    cpuTimeMs: Math.max(0, Math.round((metric.cumulativeCpuSeconds ?? 0) * 1_000)),
    residentBytes: metric.workingSetBytes,
    virtualBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioSemantics: "storage",
  };
}

function processDepths(
  processes: ReadonlyArray<ResourceMonitorProcessSample>,
  roots: ReadonlySet<number>,
): ReadonlyMap<number, number> {
  const childrenByParent = new Map<number, number[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process.pid);
    childrenByParent.set(process.ppid, children);
  }

  const depths = new Map<number, number>();
  const queue = [...roots].map((pid) => ({ pid, depth: 0 }));
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || depths.has(current.pid)) continue;
    depths.set(current.pid, current.depth);
    for (const childPid of childrenByParent.get(current.pid) ?? []) {
      queue.push({ pid: childPid, depth: current.depth + 1 });
    }
  }
  return depths;
}

function isElectronDescendant(
  pid: number,
  processesByPid: ReadonlyMap<number, ResourceMonitorProcessSample>,
  electronPids: ReadonlySet<number>,
): boolean {
  const visited = new Set<number>();
  let currentPid = pid;
  while (!visited.has(currentPid)) {
    visited.add(currentPid);
    if (electronPids.has(currentPid)) return true;
    const current = processesByPid.get(currentPid);
    if (!current || current.ppid <= 0 || current.ppid === currentPid) return false;
    currentPid = current.ppid;
  }
  return false;
}

function hasElectronAncestor(
  process: ResourceMonitorProcessSample,
  processesByPid: ReadonlyMap<number, ResourceMonitorProcessSample>,
  electronPids: ReadonlySet<number>,
): boolean {
  const visited = new Set<number>();
  let currentPid = process.ppid;
  while (currentPid > 0 && !visited.has(currentPid)) {
    visited.add(currentPid);
    if (electronPids.has(currentPid)) return true;
    const current = processesByPid.get(currentPid);
    if (!current || current.ppid === currentPid) return false;
    currentPid = current.ppid;
  }
  return false;
}

function orderProcessTree(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  rootPids: ReadonlyArray<number>,
): ReadonlyArray<ResourceTelemetryProcess> {
  const processesByPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const childrenByParent = new Map<number, ResourceTelemetryProcess[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process);
    childrenByParent.set(process.ppid, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.identity.pid - right.identity.pid);
  }

  const ordered: ResourceTelemetryProcess[] = [];
  const visited = new Set<number>();
  const visit = (process: ResourceTelemetryProcess): void => {
    if (visited.has(process.identity.pid)) return;
    visited.add(process.identity.pid);
    ordered.push(process);
    for (const child of childrenByParent.get(process.identity.pid) ?? []) {
      visit(child);
    }
  };

  for (const rootPid of rootPids) {
    const root = processesByPid.get(rootPid);
    if (root) visit(root);
  }
  for (const process of processes.toSorted(
    (left, right) => left.depth - right.depth || left.identity.pid - right.identity.pid,
  )) {
    visit(process);
  }
  return ordered;
}

function delta(input: {
  readonly current: number;
  readonly previous: number;
  readonly elapsedMs: number;
}): number {
  if (
    input.elapsedMs <= 0 ||
    input.elapsedMs > MAX_DELTA_INTERVAL_MS ||
    input.current < input.previous
  ) {
    return 0;
  }
  return input.current - input.previous;
}

function incrementCounters(counters: GroupCounters, update: Partial<GroupCounters>): GroupCounters {
  return {
    cpuTimeMs: counters.cpuTimeMs + (update.cpuTimeMs ?? 0),
    ioReadBytes: counters.ioReadBytes + (update.ioReadBytes ?? 0),
    ioWriteBytes: counters.ioWriteBytes + (update.ioWriteBytes ?? 0),
    processStarts: counters.processStarts + (update.processStarts ?? 0),
    processExits: counters.processExits + (update.processExits ?? 0),
  };
}

function applyLifecycleCounters(input: {
  readonly counters: TelemetryCounters;
  readonly deltas: ReadonlyArray<ProcessDelta>;
  readonly current: ReadonlyMap<string, ProcessState>;
  readonly previous: ReadonlyMap<string, ProcessState>;
}): TelemetryCounters {
  let backend = input.counters.backend;
  let electron = input.counters.electron;
  let monitor = input.counters.monitor;
  let allT3 = input.counters.allT3;
  for (const processDelta of input.deltas) {
    const group = categoryGroup(processDelta.category);
    switch (group) {
      case "backend":
        backend = incrementCounters(backend, processDelta);
        break;
      case "electron":
        electron = incrementCounters(electron, processDelta);
        break;
      case "monitor":
        monitor = incrementCounters(monitor, processDelta);
        break;
    }
    allT3 = incrementCounters(allT3, processDelta);
  }

  for (const [identityKey, current] of input.current) {
    if (input.previous.has(identityKey)) continue;
    const group = categoryGroup(current.process.category);
    switch (group) {
      case "backend":
        backend = incrementCounters(backend, { processStarts: 1 });
        break;
      case "electron":
        electron = incrementCounters(electron, { processStarts: 1 });
        break;
      case "monitor":
        monitor = incrementCounters(monitor, { processStarts: 1 });
        break;
    }
    allT3 = incrementCounters(allT3, { processStarts: 1 });
  }

  for (const [identityKey, previous] of input.previous) {
    if (input.current.has(identityKey)) continue;
    const group = categoryGroup(previous.process.category);
    switch (group) {
      case "backend":
        backend = incrementCounters(backend, { processExits: 1 });
        break;
      case "electron":
        electron = incrementCounters(electron, { processExits: 1 });
        break;
      case "monitor":
        monitor = incrementCounters(monitor, { processExits: 1 });
        break;
    }
    allT3 = incrementCounters(allT3, { processExits: 1 });
  }

  return { backend, electron, monitor, allT3 };
}

function aggregate(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  counters: GroupCounters,
): ResourceTelemetryAggregate {
  return {
    processCount: processes.length,
    currentCpuPercent: processes.reduce((total, process) => total + process.cpuPercent, 0),
    cpuTimeMs: counters.cpuTimeMs,
    currentRssBytes: processes.reduce((total, process) => total + process.residentBytes, 0),
    peakRssBytes: processes.reduce((total, process) => total + process.peakResidentBytes, 0),
    ioReadBytes: counters.ioReadBytes,
    ioWriteBytes: counters.ioWriteBytes,
    ioReadBytesPerSecond: processes.reduce(
      (total, process) => total + process.ioReadBytesPerSecond,
      0,
    ),
    ioWriteBytesPerSecond: processes.reduce(
      (total, process) => total + process.ioWriteBytesPerSecond,
      0,
    ),
    processStarts: counters.processStarts,
    processExits: counters.processExits,
  };
}

export function mergeProcesses(input: MergeProcessesInput): MergeProcessesResult {
  const nativeProcesses = Option.match(input.nativeSnapshot, {
    onNone: () => [] as ReadonlyArray<ResourceMonitorProcessSample>,
    onSome: (snapshot) => snapshot.processes,
  });
  const electronMetrics = Option.match(input.desktopSnapshot, {
    onNone: () => [] as ReadonlyArray<DesktopElectronProcessMetric>,
    onSome: (snapshot) => snapshot.electronProcesses,
  });
  const sampledAtMs = Option.match(input.nativeSnapshot, {
    onNone: () =>
      Option.match(input.desktopSnapshot, {
        onNone: () => input.fallbackSampledAtMs,
        onSome: (snapshot) => snapshot.sampledAtUnixMs,
      }),
    onSome: (snapshot) => snapshot.sampledAtUnixMs,
  });
  const nativeByPid = new Map(nativeProcesses.map((process) => [process.pid, process]));
  const metricsByPid = new Map<number, DesktopElectronProcessMetric>();
  for (const metric of electronMetrics) {
    const nativeProcess = nativeByPid.get(metric.pid);
    if (!nativeProcess) {
      nativeByPid.set(metric.pid, syntheticNativeSample(metric, sampledAtMs));
      metricsByPid.set(metric.pid, metric);
      continue;
    }
    if (
      Math.abs(metric.creationTimeMs - nativeProcess.startTimeMs) <= ELECTRON_IDENTITY_TOLERANCE_MS
    ) {
      metricsByPid.set(metric.pid, metric);
    }
  }
  const processes = [...nativeByPid.values()];
  const processesByPid = new Map(processes.map((process) => [process.pid, process]));
  const explicitElectronRootPids = input.electronRootPids ?? new Set<number>();
  const electronPids = new Set([...metricsByPid.keys(), ...explicitElectronRootPids]);
  const electronRootPids = [
    ...explicitElectronRootPids,
    ...[...electronPids]
      .filter((pid) => {
        if (explicitElectronRootPids.has(pid)) return false;
        const process = processesByPid.get(pid);
        return process === undefined
          ? true
          : !hasElectronAncestor(process, processesByPid, electronPids);
      })
      .toSorted((left, right) => left - right),
  ].filter((pid, index, values) => values.indexOf(pid) === index);
  const rootPids = [input.serverPid, ...electronRootPids];
  const roots = new Set(rootPids);
  const depths = processDepths(processes, roots);
  const childrenByParent = new Map<number, number[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process.pid);
    childrenByParent.set(process.ppid, children);
  }

  const nextPrevious = new Map<string, ProcessState>();
  const processDeltas: ProcessDelta[] = [];
  const normalized = processes.map((process): ResourceTelemetryProcess => {
    const identityKey = processIdentityKey(process.pid, process.startTimeMs);
    const previous = input.previous.get(identityKey);
    const elapsedMs = previous ? sampledAtMs - previous.sampledAtMs : 0;
    const cpuTimeDelta = previous
      ? delta({
          current: process.cpuTimeMs,
          previous: previous.process.cpuTimeMs,
          elapsedMs,
        })
      : 0;
    const ioReadDelta = previous
      ? delta({
          current: process.ioReadBytes,
          previous: previous.process.ioReadBytes,
          elapsedMs,
        })
      : 0;
    const ioWriteDelta = previous
      ? delta({
          current: process.ioWriteBytes,
          previous: previous.process.ioWriteBytes,
          elapsedMs,
        })
      : 0;
    const electronMetric = matchElectronMetric(process, metricsByPid);
    const category: ResourceTelemetryProcessCategory =
      process.pid === input.serverPid
        ? "server"
        : Option.contains(input.sidecarPid, process.pid)
          ? "resource-monitor"
          : explicitElectronRootPids.has(process.pid)
            ? "electron-main"
            : electronMetric
              ? electronCategory(electronMetric)
              : isElectronDescendant(process.pid, processesByPid, electronPids)
                ? inferredElectronCategory(process)
                : "server-child";
    const firstSeenAt = previous?.process.firstSeenAt ?? DateTime.makeUnsafe(sampledAtMs);
    const preservePreviousRates = !input.updatePrevious && previous !== undefined;
    const cpuPercent = preservePreviousRates
      ? previous.process.cpuPercent
      : previous && elapsedMs > 0 && elapsedMs <= MAX_DELTA_INTERVAL_MS
        ? (cpuTimeDelta / elapsedMs) * 100
        : finiteNonNegative(process.cpuPercent);
    const normalizedProcess: ResourceTelemetryProcess = {
      identity: {
        pid: process.pid,
        startTimeMs: process.startTimeMs,
      },
      ppid: process.ppid,
      childPids: [...(childrenByParent.get(process.pid) ?? [])].toSorted(
        (left, right) => left - right,
      ),
      depth: depths.get(process.pid) ?? 0,
      name: process.name,
      command: process.command,
      status: process.status,
      category,
      ...(electronMetric ? { electronType: electronMetric.type } : {}),
      ...(electronMetric?.serviceName ? { electronServiceName: electronMetric.serviceName } : {}),
      cpuPercent: finiteNonNegative(cpuPercent),
      cpuTimeMs: process.cpuTimeMs,
      residentBytes: process.residentBytes,
      peakResidentBytes: Math.max(
        process.residentBytes,
        electronMetric?.peakWorkingSetBytes ?? 0,
        previous?.process.peakResidentBytes ?? 0,
      ),
      virtualBytes: process.virtualBytes,
      ioReadBytes: process.ioReadBytes,
      ioWriteBytes: process.ioWriteBytes,
      ioReadBytesPerSecond: preservePreviousRates
        ? previous.process.ioReadBytesPerSecond
        : elapsedMs > 0
          ? finiteNonNegative((ioReadDelta * 1_000) / elapsedMs)
          : 0,
      ioWriteBytesPerSecond: preservePreviousRates
        ? previous.process.ioWriteBytesPerSecond
        : elapsedMs > 0
          ? finiteNonNegative((ioWriteDelta * 1_000) / elapsedMs)
          : 0,
      ioSemantics: process.ioSemantics,
      ...(electronMetric ? { idleWakeupsPerSecond: electronMetric.idleWakeupsPerSecond } : {}),
      runTimeMs: process.runTimeMs,
      firstSeenAt,
      lastSeenAt: DateTime.makeUnsafe(sampledAtMs),
    };
    nextPrevious.set(identityKey, {
      process: normalizedProcess,
      sampledAtMs,
    });
    processDeltas.push({
      identityKey,
      category,
      cpuTimeMs: cpuTimeDelta,
      ioReadBytes: ioReadDelta,
      ioWriteBytes: ioWriteDelta,
    });
    return normalizedProcess;
  });
  const ordered = orderProcessTree(normalized, rootPids);

  const counters = input.updatePrevious
    ? applyLifecycleCounters({
        counters: input.counters,
        deltas: processDeltas,
        current: nextPrevious,
        previous: input.previous,
      })
    : input.counters;
  const backendProcesses = ordered.filter(
    (process) => categoryGroup(process.category) === "backend",
  );
  const electronProcesses = ordered.filter(
    (process) => categoryGroup(process.category) === "electron",
  );
  const monitorProcesses = ordered.filter(
    (process) => categoryGroup(process.category) === "monitor",
  );

  return {
    sampledAtMs,
    processes: ordered,
    previous: input.updatePrevious ? nextPrevious : input.previous,
    counters,
    groups: {
      backend: aggregate(backendProcesses, counters.backend),
      electron: aggregate(electronProcesses, counters.electron),
      monitor: aggregate(monitorProcesses, counters.monitor),
      allT3: aggregate(ordered, counters.allT3),
    },
    deltas: processDeltas,
  };
}
