import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import { type EventLoopReadings, layerWith } from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 200 ms, the histogram resolution.
const stalled: EventLoopReadings = {
  delayMaxNs: ms(5_150),
  utilization: 0.987,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
};
// Over the threshold as read, but not once the resolution is subtracted.
const quiet: EventLoopReadings = { ...stalled, delayMaxNs: ms(1_150) };

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
      const samples = [quiet, stalled];

      yield* Effect.gen(function* () {
        yield* Layer.build(layerWith(Effect.succeed(Effect.sync(() => samples.shift() ?? quiet))));
        yield* TestClock.adjust("30 seconds");
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
        utilization: 0.99,
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
});
