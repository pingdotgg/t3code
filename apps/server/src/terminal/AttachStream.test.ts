import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  ThreadId,
  EXTENDED_TERMINAL_REPLAY_BYTES,
  type TerminalAttachStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as TerminalManager from "./Manager.ts";
import * as Layer from "effect/Layer";
import { terminalAttachStream } from "./AttachStream.ts";

const input = {
  threadId: ThreadId.make("thread-1"),
  terminalId: "default",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  replayBytes: EXTENDED_TERMINAL_REPLAY_BYTES,
};
const target = { threadId: input.threadId, terminalId: input.terminalId };

it.effect("delivers every queued output before close when the attach consumer stalls", () =>
  Effect.gen(function* () {
    const subscribed =
      yield* Deferred.make<
        Parameters<TerminalManager.TerminalManager["Service"]["attachStream"]>[1]
      >();
    const consumerStarted = yield* Deferred.make<void>();
    const resumeConsumer = yield* Deferred.make<void>();
    let unsubscribed = false;
    const received: TerminalAttachStreamEvent[] = [];
    const stream = terminalAttachStream(input).pipe(
      Stream.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          attachStream: (_input, listener) =>
            Deferred.succeed(subscribed, listener).pipe(
              Effect.as(() => {
                unsubscribed = true;
              }),
            ),
        }),
      ),
    );
    const consumer = yield* stream.pipe(
      Stream.takeUntil((event) => event.type === "closed"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          received.push(event);
          if (received.length === 1) {
            yield* Deferred.succeed(consumerStarted, undefined);
            yield* Deferred.await(resumeConsumer);
          }
        }),
      ),
      Effect.forkChild,
    );
    const publish = yield* Deferred.await(subscribed);
    yield* publish({ type: "replay-complete", ...target }, "replay");
    yield* Deferred.await(consumerStarted);
    for (let index = 0; index < 32; index += 1) {
      yield* publish({ type: "output", ...target, data: `output-${index}\n` }, "live");
    }
    const producer = yield* publish({ type: "closed", ...target }, "live").pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.succeed(resumeConsumer, undefined);
    yield* Fiber.join(producer);
    yield* Fiber.join(consumer);
    expect(received.map((event) => (event.type === "output" ? event.data : event.type))).toEqual([
      "replay-complete",
      ...Array.from({ length: 32 }, (_, index) => `output-${index}\n`),
      "closed",
    ]);
    expect(unsubscribed).toBe(true);
  }),
);

it.effect("retains extended replay and its completion boundary when the consumer stalls", () =>
  Effect.gen(function* () {
    const subscribed =
      yield* Deferred.make<
        Parameters<TerminalManager.TerminalManager["Service"]["attachStream"]>[1]
      >();
    const replayStarted = yield* Deferred.make<void>();
    const resumeConsumer = yield* Deferred.make<void>();
    const queueFilled = yield* Deferred.make<void>();
    const replayCompleted = yield* Deferred.make<void>();
    const resumeLive = yield* Deferred.make<void>();
    let unsubscribed = false;
    const received: TerminalAttachStreamEvent[] = [];
    const stream = terminalAttachStream(input).pipe(
      Stream.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          attachStream: (request, listener) => {
            expect(request.replayBytes).toBe(EXTENDED_TERMINAL_REPLAY_BYTES);
            return Deferred.succeed(subscribed, listener).pipe(
              Effect.as(() => {
                unsubscribed = true;
              }),
            );
          },
        }),
      ),
    );
    const consumer = yield* stream.pipe(
      Stream.takeUntil((event) => event.type === "output" && event.data === "live-end"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          received.push(event);
          if (event.type === "replay-start") {
            yield* Deferred.succeed(replayStarted, undefined);
            yield* Deferred.await(resumeConsumer);
          } else if (event.type === "replay-complete") {
            yield* Deferred.succeed(replayCompleted, undefined);
            yield* Deferred.await(resumeLive);
          }
        }),
      ),
      Effect.forkChild,
    );
    const publish = yield* Deferred.await(subscribed);
    yield* publish({ type: "replay-start", ...target }, "replay");
    yield* Deferred.await(replayStarted);
    const producer = yield* Effect.gen(function* () {
      for (let index = 0; index < EXTENDED_TERMINAL_REPLAY_BYTES / (64 * 1024); index += 1) {
        yield* publish({ type: "output", ...target, data: "x".repeat(64 * 1024) }, "replay");
        if (index === 31) yield* Deferred.succeed(queueFilled, undefined);
      }
      yield* publish({ type: "replay-complete", ...target }, "replay");
    }).pipe(Effect.forkChild);
    yield* Deferred.await(queueFilled);
    yield* Deferred.succeed(resumeConsumer, undefined);
    yield* Fiber.join(producer);
    yield* Deferred.await(replayCompleted);
    for (let index = 0; index < 32; index += 1) {
      yield* publish({ type: "output", ...target, data: "live" }, "live");
    }
    const liveProducer = yield* publish(
      { type: "output", ...target, data: "live-end" },
      "live",
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(resumeLive, undefined);
    yield* Fiber.join(liveProducer);
    yield* Fiber.join(consumer);
    expect(
      received
        .filter((event) => event.type === "output")
        .map((event) => event.data)
        .join(""),
    ).toBe("x".repeat(EXTENDED_TERMINAL_REPLAY_BYTES) + "live".repeat(32) + "live-end");
    expect(received.filter((event) => event.type !== "output").map((event) => event.type)).toEqual([
      "replay-start",
      "replay-complete",
    ]);
    expect(unsubscribed).toBe(true);
  }),
);

it.effect("unsubscribes and releases blocked output when the transport consumer disconnects", () =>
  Effect.gen(function* () {
    const subscribed =
      yield* Deferred.make<
        Parameters<TerminalManager.TerminalManager["Service"]["attachStream"]>[1]
      >();
    const consumerStarted = yield* Deferred.make<void>();
    let unsubscribed = false;
    const stream = terminalAttachStream(input).pipe(
      Stream.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          attachStream: (_input, listener) =>
            Deferred.succeed(subscribed, listener).pipe(
              Effect.as(() => {
                unsubscribed = true;
              }),
            ),
        }),
      ),
    );
    const consumer = yield* stream.pipe(
      Stream.runForEach(() =>
        Deferred.succeed(consumerStarted, undefined).pipe(Effect.andThen(Effect.never)),
      ),
      Effect.forkChild,
    );
    const publish = yield* Deferred.await(subscribed);
    yield* publish({ type: "replay-complete", ...target }, "replay");
    yield* Deferred.await(consumerStarted);
    for (let index = 0; index < 32; index += 1) {
      yield* publish({ type: "output", ...target, data: "output" }, "live");
    }
    const producer = yield* publish({ type: "output", ...target, data: "blocked" }, "live").pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Fiber.interrupt(consumer);
    yield* Fiber.join(producer);
    expect(unsubscribed).toBe(true);
  }),
);

it.effect("interrupts an attach that is still replaying when the consumer disconnects", () =>
  Effect.gen(function* () {
    const consumerStarted = yield* Deferred.make<void>();
    let replayInterrupted = false;
    const consumer = yield* terminalAttachStream(input).pipe(
      Stream.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          attachStream: (_input, listener) =>
            Effect.gen(function* () {
              for (let index = 0; index < 100; index += 1) {
                yield* listener({ type: "output", ...target, data: "history" }, "replay");
              }
              return () => {};
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  replayInterrupted = true;
                }),
              ),
            ),
        }),
      ),
      Stream.runForEach(() =>
        Deferred.succeed(consumerStarted, undefined).pipe(Effect.andThen(Effect.never)),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(consumerStarted);
    yield* Fiber.interrupt(consumer);
    expect(replayInterrupted).toBe(true);
  }),
);

it.effect.each(["replay", "live"] as const)(
  "disconnects a stalled %s consumer and releases its subscription",
  (phase) =>
    Effect.gen(function* () {
      const subscribed =
        yield* Deferred.make<
          Parameters<TerminalManager.TerminalManager["Service"]["attachStream"]>[1]
        >();
      const consumerStarted = yield* Deferred.make<void>();
      const resumeConsumer = yield* Deferred.make<void>();
      const detached = yield* Deferred.make<void>();
      const clock = yield* Clock.clockWith(Effect.succeed);
      const consumer = yield* terminalAttachStream(input).pipe(
        Stream.provideService(Clock.Clock, clock),
        Stream.provide(
          Layer.mock(TerminalManager.TerminalManager)({
            attachStream: (_input, listener) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(subscribed, listener);
                if (phase === "replay") {
                  for (let index = 0; index < 100; index += 1) {
                    yield* listener({ type: "output", ...target, data: "history" }, "replay");
                  }
                }
                return () => {
                  Deferred.doneUnsafe(detached, Effect.void);
                };
              }).pipe(Effect.onInterrupt(() => Deferred.succeed(detached, undefined))),
          }),
        ),
        Stream.runForEach(() =>
          Deferred.succeed(consumerStarted, undefined).pipe(
            Effect.andThen(Deferred.await(resumeConsumer)),
          ),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      const publish = yield* Deferred.await(subscribed);
      if (phase === "live") yield* publish({ type: "replay-complete", ...target }, "replay");
      yield* Deferred.await(consumerStarted);
      const producer =
        phase === "live"
          ? yield* Effect.gen(function* () {
              for (let index = 0; index < 33; index += 1) {
                yield* publish({ type: "output", ...target, data: "live" }, "live");
              }
            }).pipe(Effect.forkChild({ startImmediately: true }))
          : null;
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(detached);
      if (producer) yield* Fiber.join(producer);
      yield* Deferred.succeed(resumeConsumer, undefined);
      expect(yield* Fiber.join(consumer)).toMatchObject({
        _tag: "TerminalAttachTimeoutError",
        ...target,
      });
    }),
);
