import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { listGitTags, resolvePreviousReleaseTag } from "./resolve-previous-release-tag.ts";

const encoder = new TextEncoder();

function mockHandle(options: {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(options.stdout ?? "")),
    stderr: Stream.make(encoder.encode(options.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it.effect("selects the latest earlier stable tag and ignores nightlies", () =>
  Effect.gen(function* () {
    const previous = yield* resolvePreviousReleaseTag("stable", "v1.2.0", [
      "v1.1.0",
      "v1.1.1-nightly.20260619.1",
      "v1.1.2",
      "v1.2.0",
    ]);

    assert.equal(previous, "v1.1.2");
  }),
);

it.effect("accepts legacy nightly tags when selecting the previous nightly", () =>
  Effect.gen(function* () {
    const previous = yield* resolvePreviousReleaseTag("nightly", "v1.2.0-nightly.20260620.2", [
      "nightly-v1.2.0-nightly.20260620.1",
      "v1.1.0-nightly.20260619.9",
    ]);

    assert.equal(previous, "nightly-v1.2.0-nightly.20260620.1");
  }),
);

it.effect("reports the invalid tag with its release channel", () =>
  Effect.gen(function* () {
    const error = yield* resolvePreviousReleaseTag("nightly", "v1.2.0", []).pipe(Effect.flip);

    assert.equal(error._tag, "InvalidReleaseTagError");
    assert.equal(error.channel, "nightly");
    assert.equal(error.currentTag, "v1.2.0");
    assert.equal(error.message, "Invalid nightly release tag 'v1.2.0'.");
  }),
);

it.effect("preserves git tag spawn context and the exact platform cause", () => {
  const cause = PlatformError.systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "spawn",
    description: "git was not found",
  });

  return Effect.gen(function* () {
    const error = yield* listGitTags("/repo").pipe(
      Effect.scoped,
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(cause)),
      ),
      Effect.flip,
    );

    if (error._tag !== "ReleaseTagListProcessError") {
      return assert.fail(`Unexpected error: ${error._tag}`);
    }
    assert.equal(error.operation, "spawn");
    assert.equal(error.executable, "git");
    assert.equal(error.argumentCount, 2);
    assert.equal(error.cwd, "/repo");
    assert.strictEqual(error.cause, cause);
    assert.notProperty(error, "args");
    assert.notInclude(error.message, cause.message);
  });
});

it.effect("reports git tag non-zero exits without manufacturing a cause", () =>
  Effect.gen(function* () {
    const error = yield* listGitTags("/repo").pipe(
      Effect.scoped,
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            mockHandle({
              exitCode: 17,
              stdout: "v1.2.3\n",
              stderr: "fatal: repository unavailable\n",
            }),
          ),
        ),
      ),
      Effect.flip,
    );

    if (error._tag !== "ReleaseTagListProcessExitError") {
      return assert.fail(`Unexpected error: ${error._tag}`);
    }
    assert.equal(error.executable, "git");
    assert.equal(error.argumentCount, 2);
    assert.equal(error.cwd, "/repo");
    assert.equal(error.exitCode, 17);
    assert.equal(error.stdoutLength, 7);
    assert.equal(error.stderrLength, 30);
    assert.notProperty(error, "cause");
    assert.notProperty(error, "stdout");
    assert.notProperty(error, "stderr");
  }),
);
