// @effect-diagnostics nodeBuiltinImport:off - only node:perf_hooks exposes the event loop delay histogram.
import * as NodePerfHooks from "node:perf_hooks";

import { RotatingFileSink } from "@t3tools/shared/logging";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";

// Subtract the histogram resolution to exclude idle delay; stalls can undercount by that much.
// Sample startup more closely, then reduce wakeups so an idle backend stays idle.
const STARTUP = { resolutionMs: 100, stallThresholdMs: 250, sampleIntervalMs: 1000 };
const STEADY = { resolutionMs: 1000, stallThresholdMs: 2000, sampleIntervalMs: 30_000 };
const STARTUP_SAMPLES = 30;
const SLEEP_CHECK_MS = 5000;
const STALL_LOG_MAX_BYTES = 256 * 1024;

/** Delay in ns, active time in ms, CPU in µs. */
export interface EventLoopReadings {
  readonly delayMaxNs: number;
  /** Timer drift also covers startup and the histogram's first gap after reset. */
  readonly tickDelayMs?: number;
  readonly activeMs: number;
  readonly utilization: number;
  readonly usage: Pick<
    NodeJS.ResourceUsage,
    | "userCPUTime"
    | "systemCPUTime"
    | "majorPageFault"
    | "minorPageFault"
    | "involuntaryContextSwitches"
  >;
  readonly rssBytes: number;
  readonly steady?: boolean;
}

// Node skips the first gap after a reset, so a stall right at a sample boundary can be missed.
const makeNodeSampler = Effect.gen(function* () {
  const monitor = (resolution: number) => {
    const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution });
    histogram.enable();
    return histogram;
  };
  let histogram = monitor(STARTUP.resolutionMs);
  yield* Effect.addFinalizer(() => Effect.sync(() => histogram.disable()));
  let samplesRead = 0;
  let elu = NodePerfHooks.performance.eventLoopUtilization();
  let usage = process.resourceUsage();
  let sampledAt = NodePerfHooks.performance.now();
  // Cover stalls before the histogram's first wakeup.
  const armedAt = sampledAt;
  let startupDelayMs = 0;
  // @effect-diagnostics-next-line globalTimersInEffect:off -- The native boot probe must arm before Effect scheduling can run startup work.
  const startupProbe = setTimeout(() => {
    startupDelayMs = Math.max(0, NodePerfHooks.performance.now() - armedAt - STARTUP.resolutionMs);
  }, STARTUP.resolutionMs);
  yield* Effect.addFinalizer(() => Effect.sync(() => clearTimeout(startupProbe)));

  // @effect-diagnostics-next-line returnEffectInGen:off - the read effect is the result.
  return Effect.sync(() => {
    const nextElu = NodePerfHooks.performance.eventLoopUtilization();
    const nextUsage = process.resourceUsage();
    const now = NodePerfHooks.performance.now();
    const loop = NodePerfHooks.performance.eventLoopUtilization(nextElu, elu);
    const steady = samplesRead >= STARTUP_SAMPLES;
    const intervalMs = (steady ? STEADY : STARTUP).sampleIntervalMs;
    const readings: EventLoopReadings = {
      delayMaxNs: histogram.max,
      tickDelayMs: Math.max(startupDelayMs, now - sampledAt - intervalMs, 0),
      activeMs: loop.active,
      utilization: loop.utilization,
      usage: {
        userCPUTime: nextUsage.userCPUTime - usage.userCPUTime,
        systemCPUTime: nextUsage.systemCPUTime - usage.systemCPUTime,
        majorPageFault: nextUsage.majorPageFault - usage.majorPageFault,
        minorPageFault: nextUsage.minorPageFault - usage.minorPageFault,
        involuntaryContextSwitches:
          nextUsage.involuntaryContextSwitches - usage.involuntaryContextSwitches,
      },
      rssBytes: process.memoryUsage.rss(),
      ...(steady ? { steady } : {}),
    };
    samplesRead += 1;
    if (samplesRead === STARTUP_SAMPLES) {
      histogram.disable();
      histogram = monitor(STEADY.resolutionMs);
    } else {
      histogram.reset();
    }
    startupDelayMs = 0;
    elu = nextElu;
    usage = nextUsage;
    sampledAt = now;
    return readings;
  });
});

/**
 * Returns the stall to report for one sample in ms, or undefined when there was none.
 */
export const stallMs = ({
  delayMaxNs,
  tickDelayMs = 0,
  activeMs,
  usage,
  steady,
}: EventLoopReadings) => {
  const { resolutionMs, stallThresholdMs } = steady ? STEADY : STARTUP;
  const delayMs = Math.round(Math.max(delayMaxNs / 1e6 - resolutionMs, tickDelayMs));
  if (delayMs <= stallThresholdMs) return undefined;
  // System sleep produces an idle gap. CPU time covers startup before ELU counts active time;
  // short stalls bypass this check because those readings can lag.
  const busyMs = Math.max(activeMs, (usage.userCPUTime + usage.systemCPUTime) / 1000);
  if (delayMs > SLEEP_CHECK_MS && busyMs < delayMs / 2) return undefined;
  return delayMs;
};

const encodeStallLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export interface StallLogOptions {
  readonly filePath: string;
  readonly maxBytes: number;
}

export const layerWith = (
  makeSampler: Effect.Effect<Effect.Effect<EventLoopReadings>, never, Scope.Scope>,
  stallLog: StallLogOptions,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sample = yield* makeSampler;
      const stallSink = yield* Effect.try(
        () =>
          new RotatingFileSink({
            filePath: stallLog.filePath,
            maxBytes: stallLog.maxBytes,
            maxFiles: 1,
            throwOnError: true,
          }),
      ).pipe(
        Effect.catch(() =>
          Effect.logWarning("event loop stall log unavailable", {
            filePath: stallLog.filePath,
          }).pipe(Effect.as(undefined)),
        ),
      );
      const tick = Effect.gen(function* () {
        const readings = yield* sample;
        const delayMaxMs = stallMs(readings);
        if (delayMaxMs === undefined) return;
        const { utilization, usage, rssBytes } = readings;
        const attributes = {
          delayMaxMs,
          utilization: Math.round(utilization * 100) / 100,
          cpuUserMs: Math.round(usage.userCPUTime / 1000),
          cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
          majorPageFaults: usage.majorPageFault,
          minorPageFaults: usage.minorPageFault,
          involuntaryContextSwitches: usage.involuntaryContextSwitches,
          rssMb: Math.round(rssBytes / 1024 / 1024),
        };
        yield* Effect.logWarning(`event loop stalled for ${delayMaxMs} ms`).pipe(
          Effect.withSpan("server.eventLoop.stall", { root: true, level: "Warn", attributes }),
        );
        if (stallSink !== undefined) {
          const time = DateTime.formatIso(yield* DateTime.now);
          yield* encodeStallLine({ time, ...attributes }).pipe(
            Effect.flatMap((line) => Effect.try(() => stallSink.write(`${line}\n`))),
            Effect.catch(() =>
              Effect.logWarning("event loop stall log write failed", {
                filePath: stallLog.filePath,
              }),
            ),
          );
        }
      });
      const sampleAfter = (intervalMs: number) =>
        Effect.sleep(intervalMs).pipe(Effect.andThen(tick));
      yield* Effect.gen(function* () {
        for (let sample = 0; sample < STARTUP_SAMPLES; sample++) {
          yield* sampleAfter(STARTUP.sampleIntervalMs);
        }
        return yield* sampleAfter(STEADY.sampleIntervalMs).pipe(Effect.forever);
      }).pipe(Effect.forkScoped);
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerWith(makeNodeSampler, {
      filePath: path.join(path.dirname(serverTracePath), "event-loop-stalls.ndjson"),
      maxBytes: STALL_LOG_MAX_BYTES,
    });
  }),
);
