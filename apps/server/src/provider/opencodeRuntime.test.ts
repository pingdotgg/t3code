import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";

const encoder = new TextEncoder();

function exitedProcess(stdout: string, stderr: string, exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.empty,
    exitCode: Effect.yieldNow.pipe(
      Effect.andThen(Effect.succeed(ChildProcessSpawner.ExitCode(exitCode))),
    ),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

const netService = {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(12_345),
  findAvailablePort: () => Effect.succeed(12_345),
} satisfies NetService.NetServiceShape;

describe("OpenCodeRuntime", () => {
  it.effect("retains SDK status and cause without copying arbitrary response bodies", () => {
    const cause = {
      response: { status: 401 },
      body: { accessToken: "sdk-secret" },
    };

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        OpenCodeRuntime.runOpenCodeSdk("session.get", () => Promise.reject(cause)),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, OpenCodeRuntime.OpenCodeRuntimeError);
        assert.equal(result.failure.operation, "session.get");
        assert.equal(result.failure.detail, "OpenCode SDK request failed.");
        assert.equal(result.failure.responseStatus, 401);
        assert.strictEqual(result.failure.cause, cause);
        assert.notInclude(result.failure.detail, "sdk-secret");
        assert.isFalse("body" in result.failure);
      }
    });
  });

  it.live("records startup output sizes without retaining process streams", () => {
    const stdout = "startup output with a credential sdk-secret";
    const stderr = "startup failed";
    const layer = Layer.mergeAll(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(exitedProcess(stdout, stderr, 17))),
      ),
      Layer.succeed(NetService.NetService, netService),
      Layer.succeed(HostProcessPlatform, "win32"),
    );

    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime.make;
      const result = yield* Effect.result(
        Effect.scoped(
          runtime.startOpenCodeServerProcess({
            binaryPath: "opencode",
            port: 12_345,
          }),
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, OpenCodeRuntime.OpenCodeRuntimeError);
        assert.equal(result.failure.exitCode, 17);
        assert.equal(result.failure.argumentCount, 3);
        assert.equal(result.failure.stdoutBytes, encoder.encode(stdout).byteLength);
        assert.equal(result.failure.stderrBytes, encoder.encode(stderr).byteLength);
        assert.isFalse("stdout" in result.failure);
        assert.isFalse("stderr" in result.failure);
        assert.notInclude(result.failure.detail, "sdk-secret");
      }
    }).pipe(Effect.provide(layer));
  });
});
