import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  makePiRpcClient,
  spawnPiRpcClient,
  type PiRpcTransport,
  PiRpcClientError,
} from "./PiRpcClient.ts";
import { encodePiRpcJsonString } from "./PiRpcProtocol.ts";

const encoder = new TextEncoder();
const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeHarness = Effect.fn("makePiRpcClientTestHarness")(function* () {
  const output = yield* Queue.unbounded<Uint8Array>();
  const exitCode = yield* Deferred.make<number>();
  const writes: string[] = [];
  let closeCalls = 0;
  let onWrite: (message: Record<string, unknown>) => Effect.Effect<void> = () => Effect.void;

  const transport: PiRpcTransport = {
    output: Stream.fromQueue(output),
    exitCode: Deferred.await(exitCode),
    write: (line) =>
      Effect.gen(function* () {
        writes.push(line);
        yield* onWrite(decodeUnknownJsonString(line) as Record<string, unknown>);
      }),
    close: Effect.sync(() => {
      closeCalls += 1;
    }),
  };

  const client = yield* makePiRpcClient(transport);

  return {
    client,
    writes,
    emit: (value: unknown) =>
      Queue.offer(output, encoder.encode(`${encodePiRpcJsonString(value)}\n`)),
    emitRaw: (value: string) => Queue.offer(output, encoder.encode(value)),
    exit: (code: number) => Deferred.succeed(exitCode, code),
    setOnWrite: (handler: typeof onWrite) => {
      onWrite = handler;
    },
    closeCalls: () => closeCalls,
  };
});

describe("PiRpcClient", () => {
  it.effect("spawns Pi in RPC mode and exchanges JSONL over stdio", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        let spawnedCommand: unknown;
        const spawner = ChildProcessSpawner.make((command) => {
          spawnedCommand = command;
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(42),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((bytes: Uint8Array) => {
                const request = decodeUnknownJsonString(new TextDecoder().decode(bytes)) as Record<
                  string,
                  unknown
                >;
                return Queue.offer(
                  stdout,
                  encoder.encode(
                    `${encodePiRpcJsonString({
                      type: "response",
                      id: request.id,
                      command: request.type,
                      success: true,
                      data: { sessionId: "pi-session-1" },
                    })}\n`,
                  ),
                );
              }),
              stdout: Stream.fromQueue(stdout),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });

        const client = yield* spawnPiRpcClient({
          binaryPath: "/opt/homebrew/bin/pi",
          cwd: "/tmp/pi-project",
          env: { PI_CODING_AGENT_DIR: "/tmp/pi-home" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const response = yield* client.request({ type: "get_state" });

        expect(response).toMatchObject({ command: "get_state", success: true });
        const command = spawnedCommand as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv };
        };
        expect(command.command).toBe("/opt/homebrew/bin/pi");
        expect(command.args).toEqual(["--mode", "rpc"]);
        expect(command.options.cwd).toBe("/tmp/pi-project");
        expect(command.options.env?.PI_CODING_AGENT_DIR).toBe("/tmp/pi-home");
      }),
    ),
  );

  it.effect("correlates concurrent requests by generated id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        harness.setOnWrite((message) =>
          harness.emit({
            type: "response",
            id: message.id,
            command: message.type,
            success: true,
            data: { echoed: message.type },
          }),
        );

        const [state, models] = yield* Effect.all(
          [
            harness.client.request({ type: "get_state" }),
            harness.client.request({ type: "get_available_models" }),
          ],
          { concurrency: "unbounded" },
        );

        expect(state).toMatchObject({ command: "get_state", success: true });
        expect(models).toMatchObject({ command: "get_available_models", success: true });
        const ids = harness.writes.map(
          (line) => (decodeUnknownJsonString(line) as Record<string, unknown>).id,
        );
        expect(new Set(ids).size).toBe(2);
      }),
    ),
  );

  it.effect("publishes non-response RPC messages as events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const eventFiber = yield* Stream.runHead(harness.client.events).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* harness.emit({ type: "agent_start" });

        const event = yield* Fiber.join(eventFiber);
        expect(event._tag).toBe("Some");
        if (event._tag === "Some") expect(event.value).toEqual({ type: "agent_start" });
      }),
    ),
  );

  it.effect("preserves response events when Pi appends a newer lifecycle event in one chunk", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const eventsFiber = yield* harness.client.events.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* harness.emitRaw(
          [
            encodePiRpcJsonString({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
            }),
            encodePiRpcJsonString({ type: "agent_end", messages: [], willRetry: false }),
            encodePiRpcJsonString({ type: "agent_settled" }),
            "",
          ].join("\n"),
        );

        const events = [...(yield* Fiber.join(eventsFiber))];
        expect(events.map((event) => event.type)).toEqual([
          "message_update",
          "agent_end",
          "agent_settled",
        ]);
      }),
    ),
  );

  it.effect("fails a request when Pi returns an unsuccessful response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        harness.setOnWrite((message) =>
          harness.emit({
            type: "response",
            id: message.id,
            command: message.type,
            success: false,
            error: "model unavailable",
          }),
        );

        const error = yield* harness.client.request({ type: "get_state" }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(PiRpcClientError);
        expect(error.detail).toContain("model unavailable");
      }),
    ),
  );

  it.effect("fails pending requests when the Pi process exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const pending = yield* harness.client.request({ type: "get_state" }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* harness.exit(17);

        const error = yield* Fiber.join(pending).pipe(Effect.flip);
        expect(error.detail).toContain("17");
      }),
    ),
  );

  it.effect("exposes process termination to the owning provider session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const terminated = yield* harness.client.terminated.pipe(Effect.forkChild);

        yield* harness.exit(23);

        const error = yield* Fiber.join(terminated);
        expect(error.operation).toBe("process-exit");
        expect(error.detail).toContain("23");
      }),
    ),
  );

  it.effect("closes its transport when the scope is released", () =>
    Effect.gen(function* () {
      let closeCalls = () => 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          closeCalls = harness.closeCalls;
          expect(closeCalls()).toBe(0);
        }),
      );
      expect(closeCalls()).toBe(1);
    }),
  );

  it.effect("fails pending requests after malformed output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const pending = yield* harness.client.request({ type: "get_state" }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* harness.emitRaw('{"type":\n');

        const error = yield* Fiber.join(pending).pipe(Effect.flip);
        expect(error.detail).toContain("protocol");
      }),
    ),
  );
});
