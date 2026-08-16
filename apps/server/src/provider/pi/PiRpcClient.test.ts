import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  makePiRpcClient,
  makePiRpcTransport,
  PiRpcCommandError,
  PiRpcProcessExitedError,
  PiRpcProtocolError,
  PiRpcRequestTimeoutError,
} from "./PiRpcClient.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const makeIo = Effect.fn("PiRpcClient.test.makeIo")(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const writes = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();
  return {
    stdout,
    writes,
    io: {
      stdout: Stream.fromQueue(stdout).pipe(
        Stream.mapError((cause) => new PiRpcProtocolError({ detail: "test stdout failed", cause })),
      ),
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Queue.offer(writes, decoder.decode(chunk)).pipe(Effect.asVoid),
      ),
    },
  } as const;
});

const respondTo = (stdout: Queue.Queue<Uint8Array, Cause.Done<void>>, request: string) => {
  const parsed = JSON.parse(request) as { readonly id: string; readonly type: string };
  return Queue.offer(
    stdout,
    bytes(
      `${JSON.stringify({ type: "response", command: parsed.type, success: true, id: parsed.id })}\n`,
    ),
  );
};

describe("PiRpcClient transport", () => {
  it.effect("frames chunks and preserves unicode line separators", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const eventFiber = yield* Stream.runCollect(client.events.pipe(Stream.take(1))).pipe(
        Effect.forkScoped,
      );
      yield* Queue.offer(test.stdout, bytes('{"type":"message","text":"a'));
      yield* Queue.offer(test.stdout, bytes('\u2028b\u2029c"}\r\n'));
      const events = yield* Fiber.join(eventFiber);
      expect(Array.from(events)).toEqual([{ type: "message", text: "a\u2028b\u2029c" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces malformed JSON without blocking a correlated response", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const eventsFiber = yield* Stream.runCollect(client.events.pipe(Stream.take(1))).pipe(
        Effect.forkScoped,
      );
      const stateFiber = yield* client.getState().pipe(Effect.forkScoped);
      const request = yield* Queue.take(test.writes);
      expect(request).toContain('"type":"get_state"');
      yield* Queue.offer(test.stdout, bytes("{not json\n"));
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_state","success":true,"id":"t3-pi-1","data":{"sessionId":"s1"}}\n',
        ),
      );
      const state = yield* Fiber.join(stateFiber);
      expect(state.sessionId).toBe("s1");
      expect(Array.from(yield* Fiber.join(eventsFiber))[0]).toMatchObject({
        _tag: "PiRpcProtocolFailureEvent",
        reason: "MalformedJson",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("tolerates plain and bracket-prefixed extension output before RPC JSON starts", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const eventsFiber = yield* Stream.runCollect(client.events.pipe(Stream.take(2))).pipe(
        Effect.forkScoped,
      );
      yield* Queue.offer(
        test.stdout,
        bytes(
          "[pi-cliproxyapi] discovery from cache: 1 builtin, 30 custom\nMCP extension initialized\n",
        ),
      );
      expect(Array.from(yield* Fiber.join(eventsFiber))).toEqual([
        {
          _tag: "PiRpcOutputLineEvent",
          line: "[pi-cliproxyapi] discovery from cache: 1 builtin, 30 custom",
        },
        { _tag: "PiRpcOutputLineEvent", line: "MCP extension initialized" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("decodes extension commands, prompt templates, and skills", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const commandsFiber = yield* client.getCommands().pipe(Effect.forkScoped);
      const request = yield* Queue.take(test.writes);
      expect(request).toContain('"type":"get_commands"');
      expect(request).toContain('"id":"t3-pi-1"');
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_commands","success":true,"id":"t3-pi-1","data":{"commands":[{"name":"skill:review","description":"Review changes","source":"skill","sourceInfo":{"path":"/tmp/review/SKILL.md","source":"auto","scope":"user","origin":"top-level"}}]}}\n',
        ),
      );
      expect(yield* Fiber.join(commandsFiber)).toEqual({
        commands: [
          {
            name: "skill:review",
            description: "Review changes",
            source: "skill",
            sourceInfo: {
              path: "/tmp/review/SKILL.md",
              source: "auto",
              scope: "user",
              origin: "top-level",
            },
          },
        ],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("decodes cumulative and current context usage separately", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const statsFiber = yield* client.getSessionStats().pipe(Effect.forkScoped);
      const request = yield* Queue.take(test.writes);
      expect(request).toContain('"type":"get_session_stats"');
      expect(request).toContain('"id":"t3-pi-1"');
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_session_stats","success":true,"id":"t3-pi-1","data":{"sessionId":"session-1","tokens":{"input":500,"output":50,"cacheRead":300,"cacheWrite":10,"total":860},"contextUsage":{"tokens":120,"contextWindow":200000,"percent":0.06}}}\n',
        ),
      );
      expect(yield* Fiber.join(statsFiber)).toEqual({
        sessionId: "session-1",
        tokens: { input: 500, output: 50, cacheRead: 300, cacheWrite: 10, total: 860 },
        contextUsage: { tokens: 120, contextWindow: 200_000, percent: 0.06 },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("bounds oversized remainders and resumes at the next line", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io, { maxLineLength: 8 });
      const eventsFiber = yield* Stream.runCollect(client.events.pipe(Stream.take(2))).pipe(
        Effect.forkScoped,
      );
      yield* Queue.offer(test.stdout, bytes("123456789"));
      yield* Queue.offer(test.stdout, bytes('\n{"x":1}\n'));
      expect(Array.from(yield* Fiber.join(eventsFiber))).toEqual([
        expect.objectContaining({ reason: "LineTooLong" }),
        { x: 1 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("accepts fragmented Pi event lines larger than the former production limit", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const eventsFiber = yield* Stream.runCollect(client.events.pipe(Stream.take(1))).pipe(
        Effect.forkScoped,
      );
      const text = "x".repeat(1024 * 1024 + 1);
      const line = `{"type":"message","text":"${text}"}\n`;
      const splitAt = 1024 * 1024 + 1;
      yield* Queue.offer(test.stdout, bytes(line.slice(0, splitAt)));
      yield* Queue.offer(test.stdout, bytes(line.slice(splitAt)));
      expect((yield* Fiber.join(eventsFiber))[0]).toEqual({ type: "message", text });
    }).pipe(Effect.scoped),
  );

  it.effect("reports command failures without poisoning later requests", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const failedFiber = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(test.writes);
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_state","success":false,"id":"t3-pi-1","error":"no state"}\n',
        ),
      );
      expect(yield* Fiber.join(failedFiber)).toBeInstanceOf(PiRpcCommandError);

      const nextFiber = yield* client.getState().pipe(Effect.forkScoped);
      yield* Queue.take(test.writes);
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_state","success":true,"id":"t3-pi-2","data":{"sessionId":"s2"}}\n',
        ),
      );
      expect((yield* Fiber.join(nextFiber)).sessionId).toBe("s2");
    }).pipe(Effect.scoped),
  );

  it.effect("sends extension UI responses without waiting for an acknowledgement", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      yield* client.respondToExtensionUi({ id: "ui-1", confirmed: true });
      expect(yield* Queue.take(test.writes)).toBe(
        '{"type":"extension_ui_response","id":"ui-1","confirmed":true}\n',
      );
    }).pipe(Effect.scoped),
  );

  it.effect("writes sequential and concurrent requests as complete NDJSON lines", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);

      const first = yield* client.prompt("first").pipe(Effect.forkScoped);
      const firstWrite = yield* Queue.take(test.writes);
      expect(firstWrite.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(firstWrite)).not.toThrow();
      yield* respondTo(test.stdout, firstWrite);
      yield* Fiber.join(first);

      const withImage = yield* client
        .prompt("inspect", [{ type: "image", data: "cG5n", mimeType: "image/png" }], "steer")
        .pipe(Effect.forkScoped);
      const imageWrite = yield* Queue.take(test.writes);
      expect(imageWrite).toContain('"type":"prompt"');
      expect(imageWrite).toContain('"message":"inspect"');
      expect(imageWrite).toContain(
        '"images":[{"type":"image","data":"cG5n","mimeType":"image/png"}]',
      );
      expect(imageWrite).toContain('"streamingBehavior":"steer"');
      yield* respondTo(test.stdout, imageWrite);
      yield* Fiber.join(withImage);

      const concurrent = yield* Effect.all([client.prompt("second"), client.prompt("third")], {
        concurrency: "unbounded",
      }).pipe(Effect.forkScoped);
      const writes = [yield* Queue.take(test.writes), yield* Queue.take(test.writes)];
      for (const write of writes) {
        expect(write.endsWith("\n")).toBe(true);
        expect(write.split("\n")).toHaveLength(2);
        expect(() => JSON.parse(write)).not.toThrow();
        yield* respondTo(test.stdout, write);
      }
      yield* Fiber.join(concurrent);
      expect(
        writes.map((write) => (JSON.parse(write) as { message: string }).message).sort(),
      ).toEqual(["second", "third"]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails new requests immediately after close", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io, { requestTimeoutMs: 120_000 });
      yield* client.close();
      expect(yield* client.getState().pipe(Effect.flip)).toBeInstanceOf(PiRpcProcessExitedError);
      expect(Option.isNone(yield* Queue.poll(test.writes))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("fails new requests immediately after stdout ends", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io, { requestTimeoutMs: 120_000 });
      const pending = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(test.writes);
      yield* Queue.end(test.stdout);
      expect(yield* Fiber.join(pending)).toBeInstanceOf(PiRpcProcessExitedError);
      expect(yield* client.getState().pipe(Effect.flip)).toBeInstanceOf(PiRpcProcessExitedError);
      expect(Option.isNone(yield* Queue.poll(test.writes))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("times out requests and ignores their late responses", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io, { requestTimeoutMs: 1 });
      const timedOutFiber = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(test.writes);
      yield* TestClock.adjust("2 millis");
      expect(yield* Fiber.join(timedOutFiber)).toBeInstanceOf(PiRpcRequestTimeoutError);

      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_state","success":true,"id":"t3-pi-1","data":{"sessionId":"late"}}\n',
        ),
      );
      const nextFiber = yield* client.getState().pipe(Effect.forkScoped);
      yield* Queue.take(test.writes);
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_state","success":true,"id":"t3-pi-2","data":{"sessionId":"current"}}\n',
        ),
      );
      expect((yield* Fiber.join(nextFiber)).sessionId).toBe("current");
    }).pipe(Effect.scoped),
  );
});

describe("PiRpcClient process", () => {
  it.effect("keeps the spawned child stdin open between request streams", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
      let spawnOptions: unknown;
      const spawner = ChildProcessSpawner.make((command) => {
        spawnOptions = command.options;
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });

      yield* makePiRpcClient({ command: "fake-pi" }).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      expect(spawnOptions).toMatchObject({ stdin: { stream: "pipe", endOnDone: false } });
    }).pipe(Effect.scoped),
  );
});
