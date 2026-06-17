import type {
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";

export interface ProcessResourceMonitorShape {
  readonly readHistory: (
    input: ServerProcessResourceHistoryInput,
  ) => Effect.Effect<ServerProcessResourceHistoryResult>;
}

export class ProcessResourceMonitor extends Context.Service<
  ProcessResourceMonitor,
  ProcessResourceMonitorShape
>()("t3/diagnostics/ProcessResourceMonitor") {}

export const make = Effect.fn("makeProcessResourceMonitor")(function* () {
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const readHistory: ProcessResourceMonitorShape["readHistory"] = (input) =>
    telemetry.readHistory(input).pipe(
      Effect.map((history) => {
        const topProcesses = history.topProcesses.map((entry) => ({
          processKey: `${entry.identity.pid}:${entry.identity.startTimeMs}`,
          pid: entry.identity.pid,
          ppid: entry.ppid,
          command: entry.command || entry.name || "unknown",
          depth: entry.depth,
          isServerRoot: entry.category === "server",
          firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt,
          currentCpuPercent: entry.currentCpuPercent,
          avgCpuPercent: entry.avgCpuPercent,
          maxCpuPercent: entry.maxCpuPercent,
          cpuSecondsApprox: entry.cpuTimeMs / 1_000,
          currentRssBytes: entry.currentRssBytes,
          maxRssBytes: entry.peakRssBytes,
          sampleCount: entry.sampleCount,
        }));
        return {
          readAt: history.readAt,
          windowMs: history.windowMs,
          bucketMs: history.bucketMs,
          sampleIntervalMs: history.sampleIntervalMs,
          retainedSampleCount: history.retainedSampleCount,
          totalCpuSecondsApprox: topProcesses.reduce(
            (total, entry) => total + entry.cpuSecondsApprox,
            0,
          ),
          buckets: history.buckets.map((bucket) => ({
            startedAt: bucket.startedAt,
            endedAt: bucket.endedAt,
            avgCpuPercent: bucket.avgCpuPercent,
            maxCpuPercent: bucket.maxCpuPercent,
            maxRssBytes: bucket.maxRssBytes,
            maxProcessCount: bucket.maxProcessCount,
          })),
          topProcesses,
          error: history.health.native.lastError.pipe(
            Option.map((message) => ({
              failureTag: "ProcessDiagnosticsQueryFailedError" as const,
              message,
            })),
          ),
        };
      }),
    );

  return ProcessResourceMonitor.of({ readHistory });
});

export const layer = Layer.effect(ProcessResourceMonitor, make());
