import { describe, expect, it } from "@effect/vitest";
import {
  PLUGIN_VIEW_MAX_IN_FLIGHT_CALLS,
  PLUGIN_VIEW_MESSAGE_BURST,
  PluginViewError,
  type PluginViewHostMessage,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makePluginViewBridge, type PluginViewCloseReason } from "./viewBridge.ts";

const VIEW = { pluginId: "acme.board", viewId: "board", title: "Board" };

const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

class SocketClosed extends Schema.TaggedError<SocketClosed>()("SocketClosed", {}) {}

/**
 * A bridge over a recording port. `answer` decides each call; the default
 * echoes the input. `posted` holds what the host sent, decoded.
 */
const mount = Effect.fn("mount")(function* (
  answer: (
    handler: string,
    input: Schema.Json,
  ) => Effect.Effect<Schema.Json, PluginViewError | SocketClosed> = (_handler, input) =>
    Effect.succeed(input),
) {
  const scope = yield* Scope.make();
  const posted: Array<PluginViewHostMessage> = [];
  const closes: Array<PluginViewCloseReason> = [];
  const calls: Array<{ handler: string; input: Schema.Json }> = [];
  let portClosed = false;
  const bridge = yield* makePluginViewBridge({
    view: VIEW,
    port: {
      post: (text) => posted.push(parse(text) as PluginViewHostMessage),
      close: () => {
        portClosed = true;
      },
    },
    call: (handler, input) => {
      calls.push({ handler, input });
      return answer(handler, input);
    },
    onClose: (reason) => closes.push(reason),
  }).pipe(Scope.provide(scope));
  const send = (message: unknown) => bridge.receive(stringify(message), 0);
  return { bridge, scope, posted, closes, calls, send, portClosed: () => portClosed };
});

describe("makePluginViewBridge", () => {
  it.effect("introduces the view, then answers its calls in its own mount only", () =>
    Effect.gen(function* () {
      const { posted, calls, send } = yield* mount((handler, input) =>
        handler === "fail"
          ? Effect.fail(new PluginViewError({ reason: "timeout", message: "Too slow." }))
          : handler === "drop"
            ? Effect.fail(new SocketClosed())
            : handler === "huge"
              ? Effect.succeed("x".repeat(70 * 1024))
              : Effect.succeed({ echo: input }),
      );
      expect(posted).toEqual([{ _tag: "init", ...VIEW }]);

      // Fields beyond the envelope cannot redirect the call.
      send({ _tag: "call", id: 1, handler: "stats", input: [1], installationId: "other" });
      send({ _tag: "call", id: 2, handler: "fail", input: null });
      send({ _tag: "call", id: 3, handler: "drop", input: null });
      send({ _tag: "call", id: 4, handler: "huge", input: null });
      yield* Effect.yieldNow;
      expect(calls[0]).toEqual({ handler: "stats", input: [1] });
      expect(posted.slice(1)).toEqual([
        { _tag: "result", id: 1, value: { echo: [1] } },
        { _tag: "error", id: 2, code: "timeout", message: "Too slow." },
        {
          _tag: "error",
          id: 3,
          code: "unavailable",
          message: "The view's environment could not take the call.",
        },
        { _tag: "error", id: 4, code: "too-large", message: "The answer is too large." },
      ]);
    }),
  );

  it.effect("keeps answers within the message bounds", () =>
    Effect.gen(function* () {
      let deep: Schema.Json = null;
      for (let depth = 0; depth < 40; depth += 1) deep = [deep];
      const { posted, send } = yield* mount((handler) =>
        handler === "deep"
          ? Effect.succeed(deep)
          : handler === "nan"
            ? Effect.succeed(Number.NaN)
            : Effect.fail(
                new PluginViewError({ reason: "call-failed", message: "x".repeat(100_000) }),
              ),
      );
      send({ _tag: "call", id: 1, handler: "deep", input: null });
      send({ _tag: "call", id: 2, handler: "loud", input: null });
      send({ _tag: "call", id: 3, handler: "nan", input: null });
      yield* Effect.yieldNow;
      expect(posted.slice(1)).toEqual([
        { _tag: "error", id: 1, code: "too-deep", message: "The answer is nested too deeply." },
        { _tag: "error", id: 2, code: "too-large", message: "The error is too large." },
        { _tag: "error", id: 3, code: "invalid", message: "The answer is not JSON." },
      ]);
    }),
  );

  it.effect("drops what breaks the bounds and ends the mount after too many", () =>
    Effect.gen(function* () {
      const { bridge, posted, closes, calls, send, portClosed } = yield* mount();
      bridge.receive({ _tag: "call", id: 1, handler: "a", input: null }, 0);
      bridge.receive(stringify({ _tag: "pong", n: 0 }), 1);
      bridge.receive(`"${"x".repeat(64 * 1024)}"`, 0);
      bridge.receive("{not json", 0);
      let deep: unknown = null;
      for (let depth = 0; depth < 40; depth += 1) deep = [deep];
      send({ _tag: "call", id: 1, handler: "a", input: deep });
      send({ _tag: "call", id: 1, handler: "view:other:a", input: null });
      send({ _tag: "connect" });
      expect(
        posted.slice(1).map((message) => message._tag === "violation" && message.reason),
      ).toEqual([
        "not-text",
        "transfer",
        "too-large",
        "not-json",
        "too-deep",
        "invalid",
        "invalid",
      ]);
      expect(closes).toEqual([]);
      send({ _tag: "cancel" });
      expect(closes).toEqual(["violations"]);
      expect(portClosed()).toBe(true);
      // A closed mount reads nothing and sends nothing more.
      const before = posted.length;
      send({ _tag: "call", id: 9, handler: "a", input: null });
      yield* Effect.yieldNow;
      expect(posted.length).toBe(before);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("limits the message rate and the calls in flight", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { posted, send, closes } = yield* mount(() =>
        Deferred.await(gate).pipe(Effect.as(null)),
      );
      for (let id = 1; id <= PLUGIN_VIEW_MAX_IN_FLIGHT_CALLS + 1; id += 1)
        send({ _tag: "call", id, handler: "wait", input: null });
      yield* Effect.yieldNow;
      expect(posted.slice(1)).toEqual([
        {
          _tag: "error",
          id: PLUGIN_VIEW_MAX_IN_FLIGHT_CALLS + 1,
          code: "busy",
          message: "Too many calls are in flight.",
        },
      ]);
      send({ _tag: "call", id: 1, handler: "wait", input: null });
      expect(posted.at(-1)).toEqual({ _tag: "violation", reason: "duplicate-call-id" });

      // The burst is spent after this many messages; a second refills half of it.
      for (
        let index = PLUGIN_VIEW_MAX_IN_FLIGHT_CALLS + 2;
        index < PLUGIN_VIEW_MESSAGE_BURST;
        index += 1
      )
        send({ _tag: "pong", n: 0 });
      // An over-rate call is answered, so the view's promise settles.
      send({ _tag: "call", id: 99, handler: "wait", input: null });
      expect(posted.slice(-2)).toEqual([
        {
          _tag: "error",
          id: 99,
          code: "rate",
          message: "Too many messages; try again shortly.",
        },
        { _tag: "violation", reason: "rate" },
      ]);
      yield* TestClock.adjust("1 second");
      const violations = posted.length;
      for (let index = 0; index < 32; index += 1) send({ _tag: "pong", n: 0 });
      expect(posted.length).toBe(violations);
      expect(closes).toEqual([]);
    }),
  );

  it.effect("cancels and closes calls in flight without delivering their late answers", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const interrupted: Array<string> = [];
      const { bridge, scope, posted, send, closes } = yield* mount((handler) =>
        Deferred.await(gate).pipe(
          Effect.as(handler),
          Effect.onInterrupt(() => Effect.sync(() => interrupted.push(handler))),
        ),
      );
      send({ _tag: "call", id: 1, handler: "first", input: null });
      send({ _tag: "call", id: 2, handler: "second", input: null });
      yield* Effect.yieldNow;
      send({ _tag: "cancel", id: 1 });
      send({ _tag: "cancel", id: 7 });
      yield* Effect.yieldNow;
      expect(interrupted).toEqual(["first"]);
      expect(posted.slice(1)).toEqual([
        { _tag: "error", id: 1, code: "cancelled", message: "The call was cancelled." },
      ]);

      bridge.close();
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.yieldNow;
      expect(interrupted).toEqual(["first", "second"]);
      expect(posted).toHaveLength(2);
      yield* Scope.close(scope, Exit.void);
      expect(closes).toEqual(["closed"]);
    }),
  );

  it.effect("ends a view that stops answering pings", () =>
    Effect.gen(function* () {
      const { posted, send, closes } = yield* mount();
      yield* TestClock.adjust("5 seconds");
      expect(posted.at(-1)).toEqual({ _tag: "ping", n: 1 });
      send({ _tag: "pong", n: 1 });
      yield* TestClock.adjust("5 seconds");
      expect(posted.at(-1)).toEqual({ _tag: "ping", n: 2 });
      // A stale pong does not count for the current ping.
      send({ _tag: "pong", n: 1 });
      expect(closes).toEqual([]);
      yield* TestClock.adjust("5 seconds");
      expect(closes).toEqual(["unresponsive"]);
    }),
  );
});
