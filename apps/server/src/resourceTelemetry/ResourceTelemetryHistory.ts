import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryHealth,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  emptyTelemetryCounters,
  mergeProcesses,
  processIdentityKey,
  type ProcessState,
  type TelemetryCounters,
} from "./Model.ts";

const MAX_HISTORY_WINDOW_MS = 60 * 60_000;

export function normalizeResourceTelemetryHistoryInput(input: {
  readonly windowMs: number;
  readonly bucketMs: number;
}): { readonly windowMs: number; readonly bucketMs: number } {
  const windowMs = Math.max(1_000, Math.min(MAX_HISTORY_WINDOW_MS, input.windowMs));
  return {
    windowMs,
    bucketMs: Math.max(1_000, Math.min(windowMs, input.bucketMs)),
  };
}

interface AggregateSample {
  readonly sampledAtMs: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

interface ProcessSample {
  readonly sampledAtMs: number;
  readonly process: ResourceTelemetryProcess;
  readonly cpuTimeMs: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

export interface BuildResourceTelemetryHistoryInput {
  readonly readAt: DateTime.Utc;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly sampleIntervalMs: number;
  readonly serverPid: number;
  readonly sidecarPid: Option.Option<number>;
  readonly desktopSnapshot: Option.Option<DesktopHostTelemetrySnapshot>;
  readonly snapshots: ReadonlyArray<ResourceMonitorSnapshotEvent>;
  readonly health: ResourceTelemetryHealth;
}

function summarizeProcesses(
  samples: ReadonlyArray<ProcessSample>,
): ReadonlyArray<ResourceTelemetryProcessSummary> {
  const groups = new Map<string, ProcessSample[]>();
  for (const sample of samples) {
    const identityKey = processIdentityKey(
      sample.process.identity.pid,
      sample.process.identity.startTimeMs,
    );
    const current = groups.get(identityKey) ?? [];
    current.push(sample);
    groups.set(identityKey, current);
  }

  return [...groups.values()]
    .map((processSamples): ResourceTelemetryProcessSummary => {
      const sorted = processSamples.toSorted((left, right) => left.sampledAtMs - right.sampledAtMs);
      const first = sorted[0]!;
      const latest = sorted[sorted.length - 1]!;
      const cpuTotal = sorted.reduce((total, sample) => total + sample.process.cpuPercent, 0);
      return {
        identity: latest.process.identity,
        ppid: latest.process.ppid,
        depth: latest.process.depth,
        name: latest.process.name,
        command: latest.process.command,
        category: latest.process.category,
        firstSeenAt: first.process.firstSeenAt,
        lastSeenAt: latest.process.lastSeenAt,
        currentCpuPercent: latest.process.cpuPercent,
        avgCpuPercent: cpuTotal / sorted.length,
        maxCpuPercent: Math.max(...sorted.map((sample) => sample.process.cpuPercent)),
        cpuTimeMs: sorted.reduce((total, sample) => total + sample.cpuTimeMs, 0),
        currentRssBytes: latest.process.residentBytes,
        peakRssBytes: Math.max(...sorted.map((sample) => sample.process.peakResidentBytes)),
        ioReadBytes: sorted.reduce((total, sample) => total + sample.ioReadBytes, 0),
        ioWriteBytes: sorted.reduce((total, sample) => total + sample.ioWriteBytes, 0),
        ioSemantics: latest.process.ioSemantics,
        sampleCount: sorted.length,
      };
    })
    .toSorted(
      (left, right) => right.cpuTimeMs - left.cpuTimeMs || right.peakRssBytes - left.peakRssBytes,
    );
}

function buildBuckets(input: {
  readonly samples: ReadonlyArray<AggregateSample>;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
}): ReadonlyArray<ResourceTelemetryHistoryBucket> {
  const windowStartMs = input.nowMs - input.windowMs;
  const buckets: ResourceTelemetryHistoryBucket[] = [];
  for (let startedAtMs = windowStartMs; startedAtMs < input.nowMs; startedAtMs += input.bucketMs) {
    const endedAtMs = Math.min(input.nowMs, startedAtMs + input.bucketMs);
    const samples = input.samples.filter(
      (sample) =>
        sample.sampledAtMs >= startedAtMs &&
        (endedAtMs === input.nowMs
          ? sample.sampledAtMs <= endedAtMs
          : sample.sampledAtMs < endedAtMs),
    );
    const cpuTotal = samples.reduce((total, sample) => total + sample.cpuPercent, 0);
    buckets.push({
      startedAt: DateTime.makeUnsafe(startedAtMs),
      endedAt: DateTime.makeUnsafe(endedAtMs),
      avgCpuPercent: samples.length === 0 ? 0 : cpuTotal / samples.length,
      maxCpuPercent:
        samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.cpuPercent)),
      maxRssBytes: samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.rssBytes)),
      ioReadBytes: samples.reduce((total, sample) => total + sample.ioReadBytes, 0),
      ioWriteBytes: samples.reduce((total, sample) => total + sample.ioWriteBytes, 0),
      maxProcessCount:
        samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.processCount)),
    });
  }
  return buckets;
}

export function buildResourceTelemetryHistory(
  input: BuildResourceTelemetryHistoryInput,
): ResourceTelemetryHistory {
  const readAtMs = DateTime.toEpochMillis(input.readAt);
  const { windowMs, bucketMs } = normalizeResourceTelemetryHistoryInput(input);
  const windowStartMs = readAtMs - windowMs;
  const snapshots = input.snapshots
    .filter((snapshot) => snapshot.sampledAtUnixMs >= windowStartMs)
    .toSorted((left, right) => left.sampledAtUnixMs - right.sampledAtUnixMs);
  const electronRootPids = Option.match(input.desktopSnapshot, {
    onNone: () => new Set<number>(),
    onSome: (snapshot) => new Set([snapshot.electronPid]),
  });
  const desktopIdentity = Option.map(input.desktopSnapshot, (snapshot) => ({
    ...snapshot,
    electronProcesses: [],
  }));
  const aggregateSamples: AggregateSample[] = [];
  const processSamples: ProcessSample[] = [];
  let previous: ReadonlyMap<string, ProcessState> = new Map();
  let counters: TelemetryCounters = emptyTelemetryCounters();

  for (const snapshot of snapshots) {
    const merged = mergeProcesses({
      serverPid: input.serverPid,
      sidecarPid: input.sidecarPid,
      fallbackSampledAtMs: snapshot.sampledAtUnixMs,
      nativeSnapshot: Option.some(snapshot),
      desktopSnapshot: desktopIdentity,
      electronRootPids,
      previous,
      counters,
      updatePrevious: true,
    });
    previous = merged.previous;
    counters = merged.counters;
    const deltasByIdentity = new Map(
      merged.deltas.map((processDelta) => [processDelta.identityKey, processDelta]),
    );
    aggregateSamples.push({
      sampledAtMs: snapshot.sampledAtUnixMs,
      cpuPercent: merged.groups.allT3.currentCpuPercent,
      rssBytes: merged.groups.allT3.currentRssBytes,
      processCount: merged.groups.allT3.processCount,
      ioReadBytes: merged.deltas.reduce((total, process) => total + process.ioReadBytes, 0),
      ioWriteBytes: merged.deltas.reduce((total, process) => total + process.ioWriteBytes, 0),
    });
    for (const process of merged.processes) {
      const processDelta = deltasByIdentity.get(
        processIdentityKey(process.identity.pid, process.identity.startTimeMs),
      );
      processSamples.push({
        sampledAtMs: snapshot.sampledAtUnixMs,
        process,
        cpuTimeMs: processDelta?.cpuTimeMs ?? 0,
        ioReadBytes: processDelta?.ioReadBytes ?? 0,
        ioWriteBytes: processDelta?.ioWriteBytes ?? 0,
      });
    }
  }

  return {
    readAt: input.readAt,
    windowMs,
    bucketMs,
    sampleIntervalMs: input.sampleIntervalMs,
    retainedSampleCount: aggregateSamples.length + processSamples.length,
    buckets: buildBuckets({ samples: aggregateSamples, nowMs: readAtMs, windowMs, bucketMs }),
    topProcesses: summarizeProcesses(processSamples),
    health: input.health,
  };
}
