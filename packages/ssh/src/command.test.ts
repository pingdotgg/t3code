import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import {
  baseSshArgs,
  getLastNonEmptyOutputLine,
  parseSshResolveOutput,
  remoteStateKey,
  runSshCommand,
} from "./command.ts";
import { SshCommandError } from "./errors.ts";

const encoder = new TextEncoder();

const makeFailedProcess = (input: { readonly stdout: string; readonly stderr?: string }) => {
  const stdoutStream = Stream.make(encoder.encode(input.stdout));
  const stderrStream = input.stderr ? Stream.make(encoder.encode(input.stderr)) : Stream.empty;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: stderrStream,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeNeverFinishingProcess = () => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

describe("ssh command", () => {
  it.effect("parses resolved ssh config output into a target", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseSshResolveOutput(
          "devbox",
          ["hostname devbox.example.com", "user julius", "port 2222", ""].join("\n"),
        ),
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
      );
    }),
  );

  it.effect("builds interactive ssh args without forcing batch mode", () =>
    Effect.sync(() => {
      assert.deepEqual(
        baseSshArgs(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { batchMode: "no" },
        ),
        ["-o", "BatchMode=no", "-o", "ConnectTimeout=10", "-p", "2222"],
      );
    }),
  );

  // Remote servers store state under this key, so it must not change across releases.
  it.effect("derives a stable remote state key", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* remoteStateKey({
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        }),
        "711bc738002d72fd",
      );
      assert.equal(
        yield* remoteStateKey({
          alias: "fixture",
          hostname: "fixture",
          username: null,
          port: null,
        }),
        "326264c4f08c8a0c",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the last non-empty ssh output line", () =>
    Effect.sync(() => {
      assert.equal(
        getLastNonEmptyOutputLine(
          ["Welcome to the host", "", '{"credential":"pairing-token"}', ""].join("\n"),
        ),
        '{"credential":"pairing-token"}',
      );
    }),
  );

  it.effect("includes stdout in non-zero command failures when stderr is empty", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeFailedProcess({ stdout: "Pairing token creation failed\n" })),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { remoteCommandArgs: ["sh", "-s"] },
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.message, "Pairing token creation failed");
        assert.equal(result.failure.stdout, "Pairing token creation failed\n");
        assert.equal(result.failure.stderr, "");
      }
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("redacts credentials from stdout in non-zero command failures", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeFailedProcess({ stdout: '{"credential":"pairing-secret"}\n' })),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { remoteCommandArgs: ["sh", "-s"] },
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.message, '{"credential":"[redacted]"}');
        assert.equal(result.failure.stdout, '{"credential":"[redacted]"}\n');
      }
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("fails commands that never finish", () => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeNeverFinishingProcess()));
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          runSshCommand(
            {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 2222,
            },
            { timeoutMs: 1 },
          ),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "SSH command timed out after 1ms.");
      }
    }).pipe(Effect.provide(layerProcess));
  });
});
