import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 1 s, the histogram resolution.
const stalled: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: ms(5_950),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
  heapUsedBytes: 512 * 1024 * 1024,
  elapsedMs: 30_000,
  loadAverage: 219.43,
  cpuCount: 18,
};
const quiet: EventLoopMonitor.EventLoopReadings = { ...stalled, delayMaxNs: ms(2_950) };

const monitor = (
  samples: Array<EventLoopMonitor.EventLoopReadings>,
  stallLog: EventLoopMonitor.StallLogOptions = { filePath: "\0", maxBytes: 1 },
) =>
  Layer.build(
    EventLoopMonitor.layerWith(
      Effect.succeed(Effect.sync(() => samples.shift() ?? quiet)),
      stallLog,
    ),
  );

describe("EventLoopMonitor", () => {
  it.effect("records a warning span only for samples that saw a stall", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* Effect.gen(function* () {
        yield* monitor([stalled, quiet, stalled]);
        yield* TestClock.adjust("60 seconds");
        assert.lengthOf(spans, 0);
        yield* TestClock.adjust("30 seconds");
      }).pipe(Effect.scoped, Effect.withTracer(tracer));

      assert.deepStrictEqual(
        spans.map((span) => span.name),
        ["server.eventLoop.stall"],
      );
      const [span] = spans;
      assert.deepStrictEqual(Object.fromEntries(span!.attributes), {
        delayMaxMs: 4_950,
        utilization: 0.18,
        cpuUserMs: 310,
        cpuSystemMs: 96,
        majorPageFaults: 8_412,
        minorPageFaults: 20_031,
        involuntaryContextSwitches: 57,
        rssMb: 1536,
      });
      assert.deepStrictEqual(
        span!.events.map(([name, , attributes]) => [name, attributes["effect.logLevel"]]),
        [["event loop stalled for 4950 ms", "WARN"]],
      );
    }),
  );

  it.effect("reports a long stall when a client connects, before the next timed sample", () =>
    Effect.gen(function* () {
      const long = { ...stalled, delayMaxNs: ms(13_000), activeMs: 13_000 };
      const context = yield* monitor([quiet, stalled, long]);
      const eventLoop = Context.get(context, EventLoopMonitor.EventLoopMonitor);
      // The startup sample is skipped, so a connect before it reads nothing.
      assert.isUndefined(yield* eventLoop.latestNoticeableStall);

      yield* TestClock.adjust("30 seconds");
      // Under 5 s: logged, but not worth telling a client about.
      assert.isUndefined(yield* eventLoop.latestNoticeableStall);
      assert.deepStrictEqual(yield* eventLoop.latestNoticeableStall, {
        detectedAt: "1970-01-01T00:00:30.000Z",
        durationMs: 12_000,
        loadAverage: 219.4,
        cpuCount: 18,
      });

      // Too old to explain a drop now.
      yield* TestClock.adjust("301 seconds");
      assert.isUndefined(yield* eventLoop.latestNoticeableStall);
    }).pipe(Effect.scoped),
  );

  it.effect("exports the server's memory, CPU and event loop from each sample", () =>
    Effect.gen(function* () {
      yield* monitor([quiet, stalled]);
      yield* TestClock.adjust("60 seconds");

      const gauges = Object.fromEntries(
        (yield* Metric.snapshot).flatMap((snapshot) =>
          snapshot.id.startsWith("t3_server_") && snapshot.type === "Gauge"
            ? [[snapshot.id, snapshot.state.value]]
            : [],
        ),
      );
      assert.deepStrictEqual(gauges, {
        t3_server_resident_bytes: 1536 * 1024 * 1024,
        t3_server_heap_used_bytes: 512 * 1024 * 1024,
        t3_server_event_loop_utilization: 0.176,
        t3_server_event_loop_delay_max: 4_950,
        // 406 ms of CPU over 30 s of wall time.
        t3_server_cpu_utilization: 406 / 30_000,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps each stall as one line in a capped stall log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-" });
      const filePath = `${directory}/event-loop-stalls.ndjson`;
      yield* monitor([stalled, stalled, stalled, { ...stalled, delayMaxNs: ms(7_000) }], {
        filePath,
        maxBytes: 300,
      });
      yield* TestClock.adjust("120 seconds");

      const lines = (yield* fs.readFileString(filePath)).trim().split("\n");
      assert.deepStrictEqual(
        lines.map((line) => JSON.parse(line)),
        [
          {
            time: "1970-01-01T00:02:00.000Z",
            delayMaxMs: 6_000,
            utilization: 0.18,
            cpuUserMs: 310,
            cpuSystemMs: 96,
            majorPageFaults: 8_412,
            minorPageFaults: 20_031,
            involuntaryContextSwitches: 57,
            rssMb: 1536,
          },
        ],
      );
      assert.lengthOf((yield* fs.readFileString(`${filePath}.1`)).trim().split("\n"), 1);
      assert.isFalse(yield* fs.exists(`${filePath}.2`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("warns when a stall cannot be written to the stall log", () => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(Array.isArray(message) ? message[0] : message);
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-" });
      yield* monitor([stalled, stalled], { filePath, maxBytes: 1024 * 1024 });
      yield* TestClock.adjust("60 seconds");
      assert.deepStrictEqual(warnings, [
        "event loop stalled for 4950 ms",
        "event loop stall log write failed",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it("ignores delay the loop spent idle, such as a system sleep", () => {
    // Waking from sleep reads as a long gap, but the loop was idle in poll for it.
    const asleep: EventLoopMonitor.EventLoopReadings = {
      ...stalled,
      delayMaxNs: ms(600_000),
      activeMs: 900,
    };
    assert.isUndefined(EventLoopMonitor.stallMs(asleep));
    assert.strictEqual(EventLoopMonitor.stallMs({ ...asleep, activeMs: 600_000 }), 599_000);
  });
});
