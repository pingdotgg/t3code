import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import { type EventLoopReadings, layerWith, stallAttributes } from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

const readings = (overrides: Partial<EventLoopReadings>): EventLoopReadings => ({
  delayMaxNs: ms(202),
  delayP99Ns: ms(202),
  delayMeanNs: ms(201),
  utilization: 0.02,
  usage: {
    userCPUTime: 40_000,
    systemCPUTime: 10_000,
    majorPageFault: 0,
    minorPageFault: 12,
    involuntaryContextSwitches: 3,
  },
  rssBytes: 256 * 1024 * 1024,
  ...overrides,
});

const stalled = readings({
  delayMaxNs: ms(5_150),
  delayP99Ns: ms(5_150),
  delayMeanNs: ms(460),
  utilization: 0.987,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
});

const stalledAttributes = {
  delayMaxMs: 4_950,
  delayP99Ms: 4_950,
  delayMeanMs: 260,
  utilization: 0.99,
  cpuUserMs: 310,
  cpuSystemMs: 96,
  majorPageFaults: 8_412,
  minorPageFaults: 20_031,
  involuntaryContextSwitches: 57,
  rssMb: 1536,
};

describe("stallAttributes", () => {
  it("treats an idle loop as no stall", () => {
    assert.isUndefined(stallAttributes(readings({}), 1000));
  });

  it("reports a stall past the threshold without the histogram resolution", () => {
    assert.deepStrictEqual(stallAttributes(stalled, 1000), stalledAttributes);
    assert.isUndefined(stallAttributes(stalled, 5000));
  });
});

describe("EventLoopMonitor", () => {
  it.effect("records a stall span with a warning after one sample interval", () =>
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
        yield* Layer.build(layerWith(Effect.succeed(Effect.succeed(stalled))));
        yield* TestClock.adjust("29 seconds");
        assert.lengthOf(spans, 0);
        yield* TestClock.adjust("1 second");
      }).pipe(Effect.scoped, Effect.withTracer(tracer));

      assert.deepStrictEqual(
        spans.map((span) => span.name),
        ["server.eventLoop.stall"],
      );
      const [span] = spans;
      assert.deepStrictEqual(Object.fromEntries(span!.attributes), stalledAttributes);
      assert.deepStrictEqual(
        span!.events.map(([name, , attributes]) => [name, attributes["effect.logLevel"]]),
        [["event loop stalled for 4950 ms", "WARN"]],
      );
    }),
  );
});
