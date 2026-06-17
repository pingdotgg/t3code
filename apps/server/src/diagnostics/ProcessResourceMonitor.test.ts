import { describe, expect, it } from "@effect/vitest";
import type { ResourceTelemetryHistory } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ProcessResourceMonitor from "./ProcessResourceMonitor.ts";

describe("ProcessResourceMonitor", () => {
  it.effect("projects resource telemetry history into the legacy diagnostics contract", () =>
    Effect.gen(function* () {
      const readAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const history: ResourceTelemetryHistory = {
        readAt,
        windowMs: 60_000,
        bucketMs: 10_000,
        sampleIntervalMs: 1_000,
        retainedSampleCount: 2,
        buckets: [
          {
            startedAt: DateTime.makeUnsafe("2026-05-05T09:59:50.000Z"),
            endedAt: readAt,
            avgCpuPercent: 15,
            maxCpuPercent: 25,
            maxRssBytes: 4_096,
            ioReadBytes: 1_024,
            ioWriteBytes: 2_048,
            maxProcessCount: 2,
          },
        ],
        topProcesses: [
          {
            identity: { pid: process.pid, startTimeMs: 100 },
            ppid: 1,
            depth: 0,
            name: "node",
            command: "t3 server",
            category: "server",
            firstSeenAt: DateTime.makeUnsafe("2026-05-05T09:59:55.000Z"),
            lastSeenAt: readAt,
            currentCpuPercent: 5,
            avgCpuPercent: 4,
            maxCpuPercent: 8,
            cpuTimeMs: 1_500,
            currentRssBytes: 2_048,
            peakRssBytes: 4_096,
            ioReadBytes: 1_024,
            ioWriteBytes: 2_048,
            ioSemantics: "storage",
            sampleCount: 2,
          },
        ],
        health: {
          native: {
            status: "degraded",
            lastSampleAt: Option.some(readAt),
            lastError: Option.some("collector stalled"),
          },
          desktop: {
            status: "healthy",
            lastSampleAt: Option.some(readAt),
            lastError: Option.none(),
          },
          sidecarVersion: Option.some("0.1.0"),
          sidecarPid: Option.some(9_000),
          restartCount: 1,
          collectionDurationMicros: 250,
          scannedProcessCount: 80,
          retainedProcessCount: 2,
          inaccessibleProcessCount: 0,
        },
      };
      const telemetry: ResourceTelemetry.ResourceTelemetryShape = {
        latest: Effect.die("unused"),
        changes: Stream.empty,
        readHistory: () => Effect.succeed(history),
        refresh: Effect.die("unused"),
        validateProcessIdentity: () => Effect.die("unused"),
        retry: Effect.die("unused"),
      };
      const layer = ProcessResourceMonitor.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ResourceTelemetry.ResourceTelemetry,
            ResourceTelemetry.ResourceTelemetry.of(telemetry),
          ),
        ),
      );

      const result = yield* Effect.service(ProcessResourceMonitor.ProcessResourceMonitor).pipe(
        Effect.flatMap((monitor) =>
          monitor.readHistory({
            windowMs: 60_000,
            bucketMs: 10_000,
          }),
        ),
        Effect.provide(layer),
      );

      expect(result.totalCpuSecondsApprox).toBe(1.5);
      expect(result.topProcesses).toEqual([
        {
          processKey: `${process.pid}:100`,
          pid: process.pid,
          ppid: 1,
          command: "t3 server",
          depth: 0,
          isServerRoot: true,
          firstSeenAt: DateTime.makeUnsafe("2026-05-05T09:59:55.000Z"),
          lastSeenAt: readAt,
          currentCpuPercent: 5,
          avgCpuPercent: 4,
          maxCpuPercent: 8,
          cpuSecondsApprox: 1.5,
          currentRssBytes: 2_048,
          maxRssBytes: 4_096,
          sampleCount: 2,
        },
      ]);
      expect(result.buckets[0]).toMatchObject({
        avgCpuPercent: 15,
        maxCpuPercent: 25,
        maxRssBytes: 4_096,
        maxProcessCount: 2,
      });
      expect(result.error).toEqual(
        Option.some({
          failureTag: "ProcessDiagnosticsQueryFailedError",
          message: "collector stalled",
        }),
      );
    }),
  );
});
