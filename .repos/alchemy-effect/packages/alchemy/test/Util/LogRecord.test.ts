import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import { emit, onEvent, type Event } from "@/Events.ts";
import {
  type LogRecord,
  logChildLine,
  parseRecord,
  recordOf,
  replayRecord,
} from "@/Util/LogRecord.ts";
import { processTrace } from "@/Util/TraceParent.ts";

const capture = () => {
  const records: Array<LogRecord> = [];
  return {
    records,
    layer: Logger.layer([
      Logger.make<unknown, void>((options) => void records.push(recordOf(options))),
    ]),
  };
};

const phase = (phase: "loading-state" | "computing-plan"): Event => ({
  type: "plan.phase",
  phase,
});

describe("log records", { tags: ["unit", "local"] }, () => {
  it.effect("never throws on values JSON cannot encode", () => {
    const { records, layer } = capture();
    const cyclic: Record<string, unknown> = { big: 1n };
    cyclic.self = cyclic;
    return Effect.logInfo(cyclic).pipe(
      Effect.provide(layer),
      Effect.andThen(
        Effect.sync(() =>
          expect(records[0]).toMatchObject({
            kind: "log",
            data: { message: '{"big":"1","self":"[Circular]"}' },
          }),
        ),
      ),
    );
  });

  it.effect("replays a record with its original time and cause", () => {
    const { records, layer } = capture();
    const record = {
      time: 1767225600000,
      level: "error",
      kind: "log",
      process: "sidecar",
      scope: "global",
      trace: { traceId: "t1", spanId: "s1" },
      attributes: { fqn: "Api", provider: "Cloudflare" },
      data: { message: "boom", cause: "Error: boom\n    at x" },
    } as const;
    return replayRecord(record).pipe(
      Effect.provide(layer),
      Effect.andThen(Effect.sync(() => expect(records[0]).toEqual(record))),
    );
  });
});

describe("events", { tags: ["unit", "local"] }, () => {
  it.effect("reach subscribers whatever the minimum log level", () => {
    const seen: Array<string> = [];
    return emit(phase("loading-state")).pipe(
      onEvent((event) => Effect.sync(() => void seen.push(event.type))),
      Effect.provideService(MinimumLogLevel, "Error"),
      Effect.andThen(Effect.sync(() => expect(seen).toEqual(["plan.phase"]))),
    );
  });

  it.live("are handled in order and before onEvent returns", () => {
    const seen: Array<string> = [];
    return Effect.gen(function* () {
      yield* emit(phase("loading-state"));
      yield* emit(phase("computing-plan"));
    }).pipe(
      onEvent((event) =>
        event.type === "plan.phase" && event.phase === "loading-state"
          ? Effect.sleep("20 millis").pipe(
              Effect.andThen(Effect.sync(() => void seen.push("first"))),
            )
          : Effect.sync(() => void seen.push("second")),
      ),
      Effect.andThen(Effect.sync(() => expect(seen).toEqual(["first", "second"]))),
    );
  });

  it.live("stop a blocked handler when the operation is interrupted", () =>
    Effect.gen(function* () {
      const exit = yield* emit(phase("loading-state")).pipe(
        Effect.andThen(Effect.never),
        onEvent(() => Effect.never),
        Effect.timeout("50 millis"),
        Effect.exit,
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.live("fail the operation when a handler dies", () =>
    Effect.gen(function* () {
      const exit = yield* emit(phase("loading-state")).pipe(
        onEvent(() => Effect.die("handler broke")),
        Effect.exit,
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.live("keep the observed effect on the caller's fiber", () =>
    Effect.gen(function* () {
      let ticks = 0;
      const child = yield* Effect.forkChild(
        Effect.forever(
          Effect.sync(() => void ticks++).pipe(Effect.andThen(Effect.sleep("1 millis"))),
        ),
      ).pipe(onEvent(() => Effect.void));
      yield* Effect.sleep("30 millis");
      // A fiber forked inside `onEvent` outlives it, as it would without it.
      expect(ticks).toBeGreaterThan(1);
      yield* Fiber.interrupt(child);
    }),
  );

  it.live("reject events emitted through captured loggers after cancellation", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      let captured: ReadonlySet<Logger.Logger<unknown, any>> = new Set();
      yield* Effect.gen(function* () {
        captured = yield* Logger.CurrentLoggers;
        yield* Effect.never;
      }).pipe(
        onEvent((event) => Effect.sync(() => void seen.push(event.type))),
        Effect.timeout("20 millis"),
        Effect.exit,
      );
      // An apply session that captured the subscriber keeps emitting.
      yield* emit(phase("loading-state")).pipe(
        Effect.provideService(Logger.CurrentLoggers, captured),
      );
      yield* Effect.sleep("20 millis");
      expect(seen).toEqual([]);
    }),
  );
});

describe("trace", { tags: ["unit", "local"] }, () => {
  it.effect("is the current span inside one and the process trace outside", () => {
    const { records, layer } = capture();
    return Effect.gen(function* () {
      yield* Effect.logInfo("outside");
      yield* Effect.logInfo("inside").pipe(Effect.withSpan("work"));
      const span = yield* Effect.withSpan(Effect.currentSpan, "check");
      expect(records[0]!.trace).toEqual(processTrace);
      expect(records[1]!.trace.traceId).not.toBe(processTrace.traceId);
      expect(span.traceId).toMatch(/^[0-9a-f]+$/);
    }).pipe(Effect.provide(layer));
  });
});

describe("event records", { tags: ["unit", "local"] }, () => {
  const line = (data: object) =>
    JSON.stringify({
      time: 0,
      level: "info",
      kind: "event",
      process: "exec",
      scope: "project",
      trace: { traceId: "t", spanId: "s" },
      attributes: {},
      data,
    });

  it("decodes a known event in full", () => {
    expect(parseRecord(line({ type: "plan.phase", phase: "loading-state" }))?.data).toEqual({
      type: "plan.phase",
      phase: "loading-state",
    });
  });

  it("rejects a known event with the wrong shape", () => {
    expect(parseRecord(line({ type: "plan.phase", phase: 42 }))).toBeUndefined();
  });

  it("keeps an event of a type it doesn't know", () => {
    expect(parseRecord(line({ type: "deploy.future", detail: 1 }))?.data).toEqual({
      type: "deploy.future",
      detail: 1,
    });
  });
});
