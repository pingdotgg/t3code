import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { collectSources, runCommand } from "./mobile-native-static-check.ts";

const assertPlatformError = (cause: unknown, reasonTag: string) => {
  assert.isNotNull(cause);
  assert.equal(typeof cause, "object");
  assert.equal((cause as { readonly _tag?: unknown })._tag, "PlatformError");
  assert.equal(
    (cause as { readonly reason?: { readonly _tag?: unknown } }).reason?._tag,
    reasonTag,
  );
};

const processHandle = (
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const provideSpawner = (spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"]) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn));

const runSwiftLint = runCommand("swiftlint", ["lint", "--strict"], "/repo/apps/mobile").pipe(
  Effect.provideService(HostProcess.HostProcessPlatform, "linux"),
);

it.layer(NodeServices.layer)("mobile native source discovery", (it) => {
  it.effect("preserves the failed discovery operation, path, and exact cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-native-static-check-" });
      const missingDirectory = path.join(root, "missing");

      const error = yield* collectSources(missingDirectory, root).pipe(Effect.flip);

      assert.equal(error._tag, "NativeStaticCheckSourceDiscoveryError");
      assert.equal(error.operation, "read-directory");
      assert.equal(error.path, missingDirectory);
      assertPlatformError(error.cause, "NotFound");
      assert.equal(error.message, "Native source discovery operation 'read-directory' failed.");
    }),
  );
});

it.effect("preserves process spawn context and the exact cause", () => {
  const cause = PlatformError.systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "spawn",
    description: "swiftlint was not found",
  });

  return Effect.gen(function* () {
    const error = yield* runSwiftLint.pipe(
      Effect.provide(provideSpawner(() => Effect.fail(cause))),
      Effect.flip,
    );

    if (error._tag !== "NativeStaticCheckProcessError") {
      return assert.fail(`Unexpected error: ${error._tag}`);
    }
    assert.equal(error.operation, "spawn");
    assert.equal(error.command, "swiftlint");
    assert.equal(error.argumentCount, 2);
    assert.equal(error.cwd, "/repo/apps/mobile");
    assert.equal(error.shell, false);
    assert.equal(error.cause, cause);
    assert.equal(
      error.message,
      "Native static check process operation 'spawn' failed for command 'swiftlint'.",
    );
    assert.notProperty(error, "args");
  });
});

it.effect("preserves process wait context and the exact cause", () => {
  const cause = PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "exitCode",
    description: "status unavailable",
  });

  return Effect.gen(function* () {
    const error = yield* runSwiftLint.pipe(
      Effect.provide(provideSpawner(() => Effect.succeed(processHandle(Effect.fail(cause))))),
      Effect.flip,
    );

    if (error._tag !== "NativeStaticCheckProcessError") {
      return assert.fail(`Unexpected error: ${error._tag}`);
    }
    assert.equal(error.operation, "wait-for-exit");
    assert.equal(error.command, "swiftlint");
    assert.equal(error.argumentCount, 2);
    assert.equal(error.cwd, "/repo/apps/mobile");
    assert.equal(error.shell, false);
    assert.equal(error.cause, cause);
    assert.equal(
      error.message,
      "Native static check process operation 'wait-for-exit' failed for command 'swiftlint'.",
    );
    assert.notProperty(error, "args");
  });
});

it.effect("reports non-zero exits without manufacturing a cause", () =>
  Effect.gen(function* () {
    const error = yield* runSwiftLint.pipe(
      Effect.provide(
        provideSpawner(() =>
          Effect.succeed(processHandle(Effect.succeed(ChildProcessSpawner.ExitCode(2)))),
        ),
      ),
      Effect.flip,
    );

    if (error._tag !== "NativeStaticCheckCommandError") {
      return assert.fail(`Unexpected error: ${error._tag}`);
    }
    assert.equal(error.command, "swiftlint");
    assert.equal(error.argumentCount, 2);
    assert.equal(error.cwd, "/repo/apps/mobile");
    assert.equal(error.shell, false);
    assert.equal(error.exitCode, 2);
    assert.notProperty(error, "cause");
    assert.notProperty(error, "args");
  }),
);
