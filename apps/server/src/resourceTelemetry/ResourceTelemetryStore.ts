import type {
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessSummary,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { ProcessDelta } from "./Model.ts";
import { processIdentityKey } from "./Model.ts";

const RETENTION_MS = 60 * 60_000;
const MAX_AGGREGATE_SAMPLES = 3_600;
const MAX_PROCESS_SAMPLES = 20_000;

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

interface StoreState {
  readonly aggregateSamples: ReadonlyArray<AggregateSample>;
  readonly processSamples: ReadonlyArray<ProcessSample>;
  readonly latest: ResourceTelemetrySnapshot;
}

export interface ResourceTelemetryStoreShape {
  readonly updateLatest: (snapshot: ResourceTelemetrySnapshot) => Effect.Effect<void>;
  readonly record: (
    snapshot: ResourceTelemetrySnapshot,
    deltas: ReadonlyArray<ProcessDelta>,
  ) => Effect.Effect<void>;
  readonly readHistory: (
    input: ResourceTelemetryHistoryInput,
  ) => Effect.Effect<ResourceTelemetryHistory>;
}

export class ResourceTelemetryStore extends Context.Service<
  ResourceTelemetryStore,
  ResourceTelemetryStoreShape
>()("t3/resourceTelemetry/ResourceTelemetryStore") {}

function trimByTime<A extends { readonly sampledAtMs: number }>(
  values: ReadonlyArray<A>,
  nowMs: number,
  max: number,
): ReadonlyArray<A> {
  const retained = values.filter((value) => value.sampledAtMs >= nowMs - RETENTION_MS);
  return retained.length <= max ? retained : retained.slice(retained.length - max);
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

export const make = Effect.fn("resourceTelemetry.resourceTelemetryStore.make")(function* (
  initial: ResourceTelemetrySnapshot,
) {
  const state = yield* Ref.make<StoreState>({
    aggregateSamples: [],
    processSamples: [],
    latest: initial,
  });

  const record: ResourceTelemetryStoreShape["record"] = (snapshot, deltas) =>
    Ref.update(state, (current) => {
      const sampledAtMs = DateTime.toEpochMillis(snapshot.readAt);
      const deltasByIdentity = new Map(
        deltas.map((processDelta) => [processDelta.identityKey, processDelta]),
      );
      const aggregateDelta = deltas.reduce(
        (total, process) => ({
          ioReadBytes: total.ioReadBytes + process.ioReadBytes,
          ioWriteBytes: total.ioWriteBytes + process.ioWriteBytes,
        }),
        { ioReadBytes: 0, ioWriteBytes: 0 },
      );
      return {
        latest: snapshot,
        aggregateSamples: trimByTime(
          [
            ...current.aggregateSamples,
            {
              sampledAtMs,
              cpuPercent: snapshot.groups.allT3.currentCpuPercent,
              rssBytes: snapshot.groups.allT3.currentRssBytes,
              processCount: snapshot.groups.allT3.processCount,
              ioReadBytes: aggregateDelta.ioReadBytes,
              ioWriteBytes: aggregateDelta.ioWriteBytes,
            },
          ],
          sampledAtMs,
          MAX_AGGREGATE_SAMPLES,
        ),
        processSamples: trimByTime(
          [
            ...current.processSamples,
            ...snapshot.processes.map((process) => {
              const processDelta = deltasByIdentity.get(
                processIdentityKey(process.identity.pid, process.identity.startTimeMs),
              );
              return {
                sampledAtMs,
                process,
                cpuTimeMs: processDelta?.cpuTimeMs ?? 0,
                ioReadBytes: processDelta?.ioReadBytes ?? 0,
                ioWriteBytes: processDelta?.ioWriteBytes ?? 0,
              };
            }),
          ],
          sampledAtMs,
          MAX_PROCESS_SAMPLES,
        ),
      };
    });

  const updateLatest: ResourceTelemetryStoreShape["updateLatest"] = (snapshot) =>
    Ref.update(state, (current) => ({
      ...current,
      latest: snapshot,
    }));

  const readHistory: ResourceTelemetryStoreShape["readHistory"] = (input) =>
    Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const readAtMs = DateTime.toEpochMillis(readAt);
      const windowMs = Math.max(1_000, Math.min(RETENTION_MS, input.windowMs));
      const bucketMs = Math.max(1_000, Math.min(windowMs, input.bucketMs));
      const current = yield* Ref.get(state);
      const minSampledAtMs = readAtMs - windowMs;
      const aggregateSamples = current.aggregateSamples.filter(
        (sample) => sample.sampledAtMs >= minSampledAtMs,
      );
      const processSamples = current.processSamples.filter(
        (sample) => sample.sampledAtMs >= minSampledAtMs,
      );

      return {
        readAt,
        windowMs,
        bucketMs,
        sampleIntervalMs: current.latest.sampleIntervalMs,
        retainedSampleCount: current.aggregateSamples.length + current.processSamples.length,
        buckets: buildBuckets({
          samples: aggregateSamples,
          nowMs: readAtMs,
          windowMs,
          bucketMs,
        }),
        topProcesses: summarizeProcesses(processSamples),
        health: current.latest.health,
      };
    });

  return ResourceTelemetryStore.of({ updateLatest, record, readHistory });
});

export const layer = (initial: ResourceTelemetrySnapshot) =>
  Layer.effect(ResourceTelemetryStore, make(initial));
