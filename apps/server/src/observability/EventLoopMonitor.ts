// @effect-diagnostics nodeBuiltinImport:off - only node:perf_hooks exposes the event loop delay histogram.
import * as NodePerfHooks from "node:perf_hooks";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { eventLoopDelayMax } from "./Metrics.ts";

// Node's delay histogram wakes a native timer every RESOLUTION_MS and records the
// gap between wakeups, so an idle loop reads about RESOLUTION_MS and a stall of S
// reads between S and S + RESOLUTION_MS. We subtract the resolution, so a delay can
// undercount a stall by up to RESOLUTION_MS. Keeping it at a fifth of the threshold
// catches every stall of 1.2 s or more, at 5 wakeups per second that never enter JS.
const RESOLUTION_MS = 200;
const STALL_THRESHOLD_MS = 1000;
const SAMPLE_INTERVAL = "30 seconds";

/** One sample interval as Node reports it. Delays in ns, CPU times in µs. */
export interface EventLoopReadings {
  readonly delayMaxNs: number;
  readonly delayP99Ns: number;
  readonly delayMeanNs: number;
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
}

const delayMs = (ns: number) => Math.max(0, Math.round(ns / 1e6 - RESOLUTION_MS));

/** Span attributes for an interval whose worst delay passed `thresholdMs`, or undefined. */
export const stallAttributes = (readings: EventLoopReadings, thresholdMs: number) => {
  const delayMaxMs = delayMs(readings.delayMaxNs);
  if (delayMaxMs <= thresholdMs) return undefined;
  return {
    delayMaxMs,
    delayP99Ms: delayMs(readings.delayP99Ns),
    delayMeanMs: delayMs(readings.delayMeanNs),
    utilization: Math.round(readings.utilization * 100) / 100,
    cpuUserMs: Math.round(readings.usage.userCPUTime / 1000),
    cpuSystemMs: Math.round(readings.usage.systemCPUTime / 1000),
    majorPageFaults: readings.usage.majorPageFault,
    minorPageFaults: readings.usage.minorPageFault,
    involuntaryContextSwitches: readings.usage.involuntaryContextSwitches,
    rssMb: Math.round(readings.rssBytes / 1024 / 1024),
  };
};

// Enables the delay histogram for the layer's lifetime. Each read returns the
// readings since the previous read and resets the histogram. Node skips the first
// gap after a reset, so a stall right at a sample boundary can be missed.
const makeNodeSampler = Effect.gen(function* () {
  const histogram = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: RESOLUTION_MS });
      histogram.enable();
      return histogram;
    }),
    (histogram) => Effect.sync(() => histogram.disable()),
  );
  let elu = NodePerfHooks.performance.eventLoopUtilization();
  let usage = process.resourceUsage();

  // @effect-diagnostics-next-line returnEffectInGen:off - the read effect is the result.
  return Effect.sync(() => {
    const nextElu = NodePerfHooks.performance.eventLoopUtilization();
    const nextUsage = process.resourceUsage();
    const readings: EventLoopReadings = {
      delayMaxNs: histogram.max,
      delayP99Ns: histogram.percentile(99),
      delayMeanNs: histogram.mean,
      utilization: NodePerfHooks.performance.eventLoopUtilization(nextElu, elu).utilization,
      usage: {
        userCPUTime: nextUsage.userCPUTime - usage.userCPUTime,
        systemCPUTime: nextUsage.systemCPUTime - usage.systemCPUTime,
        majorPageFault: nextUsage.majorPageFault - usage.majorPageFault,
        minorPageFault: nextUsage.minorPageFault - usage.minorPageFault,
        involuntaryContextSwitches:
          nextUsage.involuntaryContextSwitches - usage.involuntaryContextSwitches,
      },
      rssBytes: process.memoryUsage.rss(),
    };
    histogram.reset();
    elu = nextElu;
    usage = nextUsage;
    return readings;
  });
});

/**
 * Samples event loop health every 30 s and records a `server.eventLoop.stall` span
 * with a warning when the loop stalled for more than a second, so stalls land in
 * the local trace file and Settings > Diagnostics without OTLP. Takes the sampler
 * so tests can inject readings.
 */
export const layerWith = (
  makeSampler: Effect.Effect<Effect.Effect<EventLoopReadings>, never, Scope.Scope>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sample = yield* makeSampler;
      const tick = Effect.gen(function* () {
        const readings = yield* sample;
        yield* Metric.update(eventLoopDelayMax, delayMs(readings.delayMaxNs));
        const attributes = stallAttributes(readings, STALL_THRESHOLD_MS);
        if (attributes === undefined) return;
        // A root span, as the stall has no caller to attach to. Warn level keeps it
        // when T3CODE_TRACE_MIN_LEVEL is raised to cut trace noise.
        yield* Effect.logWarning(`event loop stalled for ${attributes.delayMaxMs} ms`).pipe(
          Effect.withSpan("server.eventLoop.stall", { root: true, level: "Warn", attributes }),
        );
      });
      // Layers build outside any span, so this fiber retains no parent span.
      yield* tick.pipe(
        Effect.repeat(Schedule.spaced(SAMPLE_INTERVAL)),
        Effect.delay(SAMPLE_INTERVAL),
        Effect.forkScoped,
      );
    }),
  );

export const layer = layerWith(makeNodeSampler);
