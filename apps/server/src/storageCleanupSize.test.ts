import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  ResourceMonitorBinary,
  ResourceMonitorBinaryNotFound,
} from "./resourceTelemetry/ResourceMonitorBinary.ts";
import { make } from "./storageCleanupSize.ts";

const fixture = Effect.fn(function* (
  options: {
    responses?: readonly string[];
    output?: Stream.Stream<Uint8Array>;
    exitCode?: number;
  } = {},
) {
  const queue = yield* Queue.unbounded<string>();
  const commands: string[] = [];
  let killed = 0;
  let spawned = 0;
  const responses = options.responses ?? [
    '{"version":1,"bytes":4096,"done":false}\n',
    '{"version":1,"bytes":8192,"done":true}\n',
  ];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      spawned++;
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (ChildProcess.isStandardCommand(command)) {
        assert.strictEqual(command.command, "/native/helper");
        assert.deepStrictEqual(command.args, ["--storage-scan", "/worktree with spaces"]);
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
        isRunning: Effect.succeed(true),
        kill: () =>
          Effect.sync(() => {
            killed++;
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) => {
          commands.push(new TextDecoder().decode(bytes));
          const response = responses[commands.length - 1];
          return response === undefined
            ? Effect.void
            : Queue.offer(queue, response).pipe(Effect.asVoid);
        }),
        stdout: options.output ?? Stream.fromQueue(queue).pipe(Stream.encodeText),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const scanner = yield* make.pipe(
    Effect.provideService(ResourceMonitorBinary, { resolve: Effect.succeed("/native/helper") }),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  return { scanner, commands, killed: () => killed, spawned: () => spawned, spawner };
});

it.effect("requests native batches only as the consumer resumes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const paused = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const batches: number[] = [];
    const scan = yield* f.scanner.measure("/worktree with spaces").pipe(
      Stream.runForEach((progress) =>
        Effect.gen(function* () {
          batches.push(progress.bytes);
          if (!progress.done) {
            yield* Deferred.succeed(paused, undefined);
            yield* Deferred.await(resume);
          }
        }),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(paused);
    assert.deepStrictEqual(f.commands, ["next\n"]);
    assert.strictEqual(f.killed(), 0);
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(scan);
    assert.deepStrictEqual(batches, [4096, 8192]);
    assert.deepStrictEqual(f.commands, ["next\n", "next\n"]);
    assert.strictEqual(f.killed(), 1);
    assert.strictEqual(f.spawned(), 1);
  }).pipe(Effect.scoped),
);

it.effect("cancels the native process when the consumer stops early", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const batches = yield* f.scanner
      .measure("/worktree with spaces")
      .pipe(Stream.take(1), Stream.runCollect);
    assert.deepStrictEqual(batches, [{ bytes: 4096, done: false }]);
    assert.deepStrictEqual(f.commands, ["next\n"]);
    assert.strictEqual(f.killed(), 1);
  }),
);

for (const [name, options] of [
  ["native filesystem error", { responses: ['{"version":1,"error":"permission denied"}\n'] }],
  ["incompatible protocol", { responses: ['{"version":2,"bytes":1,"done":true}\n'] }],
  ["malformed output", { responses: ["invalid json\n"] }],
  ["invalid byte count", { responses: ['{"version":1,"bytes":-1,"done":true}\n'] }],
  ["premature EOF", { output: Stream.empty }],
  [
    "EOF after partial progress",
    { output: Stream.encodeText(Stream.make('{"version":1,"bytes":10,"done":false}\n')) },
  ],
  ["nonzero exit", { responses: ['{"version":1,"bytes":1,"done":true}\n'], exitCode: 2 }],
] as const) {
  it.effect(`reports ${name} as unavailable instead of a completed measurement`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(options);
      const result = yield* f.scanner
        .measure("/worktree with spaces")
        .pipe(Stream.runCollect, Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.path, "/worktree with spaces");
        if (name === "native filesystem error") {
          assert.strictEqual(result.failure.stage, "scan");
          assert.strictEqual(result.failure.cause, "permission denied");
          assert.notInclude(result.failure.message, "permission denied");
        }
        if (name === "premature EOF") {
          assert.strictEqual(result.failure.reason, "premature-exit");
          assert.strictEqual(result.failure.cause, undefined);
        }
        if (name === "nonzero exit") {
          assert.strictEqual(result.failure.stage, "exit");
          assert.strictEqual(result.failure.exitCode, 2);
          assert.strictEqual(result.failure.cause, undefined);
        }
      }
      assert.strictEqual(f.killed(), 1);
    }),
  );
}

it.effect("does not fall back when the native binary is missing", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const scanner = yield* make.pipe(
      Effect.provideService(ResourceMonitorBinary, {
        resolve: Effect.fail(
          new ResourceMonitorBinaryNotFound({
            platform: "linux",
            architecture: "x64",
            candidates: [],
          }),
        ),
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.spawner),
    );
    const result = yield* scanner
      .measure("/worktree with spaces")
      .pipe(Stream.runCollect, Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.stage, "resolve");
    assert.strictEqual(f.spawned(), 0);
  }),
);
