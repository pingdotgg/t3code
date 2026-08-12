import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  classifyPiRpcRecord,
  decodePiRpcStdout,
  makePiRpcTransport,
  PiRpcProtocolError,
} from "./PiRpcTransport.ts";

const encoder = new TextEncoder();
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const makeFixtureSpawner = ChildProcessSpawner.make(() =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const stdin = Sink.forEach((bytes: Uint8Array) => {
      const command = decodeRecord(new TextDecoder().decode(bytes).trim());
      if (command["type"] !== "get_state") return Effect.void;
      return Effect.all(
        [
          Queue.offer(stdout, encoder.encode('{"type":"agent_start"}\n')),
          Queue.offer(
            stdout,
            encoder.encode(
              `${JSON.stringify({
                type: "response",
                id: command["id"],
                command: "get_state",
                success: true,
                data: { sessionFile: "fixture-session.jsonl" },
              })}\n`,
            ),
          ),
        ],
        { discard: true },
      );
    });

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1234),
      exitCode: Deferred.await(exited),
      isRunning: Effect.succeed(true),
      kill: () =>
        Queue.end(stdout).pipe(
          Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
        ),
      unref: Effect.succeed(Effect.void),
      stdin,
      stdout: Stream.fromQueue(stdout),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  }),
);

describe("classifyPiRpcRecord", () => {
  it.effect("classifies correlated responses, extension UI requests, and events", () =>
    Effect.gen(function* () {
      expect(
        yield* classifyPiRpcRecord({ type: "response", id: "request-1", success: true }),
      ).toMatchObject({ _tag: "response", response: { id: "request-1" } });
      expect(
        yield* classifyPiRpcRecord({
          type: "extension_ui_request",
          id: "input-1",
          method: "input",
        }),
      ).toMatchObject({ _tag: "extension-ui", request: { id: "input-1" } });
      expect(yield* classifyPiRpcRecord({ type: "message_update" })).toMatchObject({
        _tag: "event",
      });
    }),
  );

  it.effect("rejects frames without a usable type and UI requests without an id", () =>
    Effect.gen(function* () {
      const missingType = yield* classifyPiRpcRecord({ id: "request-1" }).pipe(Effect.flip);
      expect(missingType).toBeInstanceOf(PiRpcProtocolError);

      const missingUiId = yield* classifyPiRpcRecord({
        type: "extension_ui_request",
        method: "confirm",
      }).pipe(Effect.flip);
      expect(missingUiId).toBeInstanceOf(PiRpcProtocolError);
    }),
  );
});

describe("decodePiRpcStdout", () => {
  it.effect("uses strict LF framing and preserves Unicode line separators in JSON strings", () =>
    Effect.gen(function* () {
      const payload =
        '{"type":"message_update","text":"first\u2028second\u2029third"}\r\n' +
        '{"type":"response","id":"request-1","success":true}\n';
      const messages = yield* Stream.fromIterable([
        encoder.encode(payload.slice(0, 31)),
        encoder.encode(payload.slice(31)),
      ]).pipe(decodePiRpcStdout, Stream.runCollect);

      expect(Array.from(messages)).toEqual([
        {
          _tag: "event",
          event: { type: "message_update", text: "first second third" },
        },
        {
          _tag: "response",
          response: { type: "response", id: "request-1", success: true },
        },
      ]);
    }),
  );

  it.effect("fails closed for malformed JSON and non-object frames", () =>
    Effect.gen(function* () {
      const malformed = yield* Stream.make(encoder.encode('{"type":\n')).pipe(
        decodePiRpcStdout,
        Stream.runCollect,
        Effect.flip,
      );
      expect(malformed._tag).toBe("PiRpcTransportError");

      const scalar = yield* Stream.make(encoder.encode("42\n")).pipe(
        decodePiRpcStdout,
        Stream.runCollect,
        Effect.flip,
      );
      expect(scalar._tag).toBe("PiRpcProtocolError");
    }),
  );
});

describe("makePiRpcTransport", () => {
  it.effect("correlates responses, streams events, times out, and closes the process", () =>
    Effect.gen(function* () {
      const transport = yield* makePiRpcTransport({
        command: process.execPath,
        args: [],
        cwd: process.cwd(),
        env: process.env,
      });

      const response = yield* transport.request({ type: "get_state" }, 2_000);
      expect(response).toMatchObject({
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionFile: "fixture-session.jsonl" },
      });
      expect(response?.id).toMatch(/^t3-pi-\d+$/u);
      expect(yield* Queue.take(transport.messages)).toEqual({
        _tag: "event",
        event: { type: "agent_start" },
      });

      const timeoutFiber = yield* transport
        .request({ type: "no_response" }, 25)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("25 millis");
      expect(yield* Fiber.join(timeoutFiber)).toBeUndefined();
      expect(yield* transport.isClosed).toBe(false);
      yield* transport.close;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeFixtureSpawner)),
    ),
  );
});
