import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  gitRemoteSshAliasToResolve,
  resolveGitRemoteForSourceControl,
  SSH_CONFIG_RESOLVE_TIMEOUT_MS,
} from "./resolveGitRemoteForSourceControl.ts";

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

describe("gitRemoteSshAliasToResolve", () => {
  it("selects undotted SSH aliases and skips real hostnames", () => {
    assert.strictEqual(
      gitRemoteSshAliasToResolve("git@github-personal:owner/repo.git"),
      "github-personal",
    );
    assert.strictEqual(
      gitRemoteSshAliasToResolve("ssh://git@gitlab-work/group/project.git"),
      "gitlab-work",
    );
    assert.strictEqual(gitRemoteSshAliasToResolve("git@github.com:owner/repo.git"), null);
    assert.strictEqual(gitRemoteSshAliasToResolve("https://github.com/owner/repo.git"), null);
  });
});

describe("resolveGitRemoteForSourceControl", () => {
  it.effect("rewrites an SSH alias to the resolved HostName", () =>
    Effect.gen(function* () {
      const rewritten = yield* resolveGitRemoteForSourceControl(
        "git@github-personal:owner/repo.git",
        () => Effect.succeed("github.com"),
      );

      assert.strictEqual(rewritten, "git@github.com:owner/repo.git");
      assert.deepStrictEqual(detectSourceControlProviderFromRemoteUrl(rewritten), {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      });
    }),
  );

  it.effect("leaves the original remote when resolve fails", () =>
    Effect.gen(function* () {
      const original = "git@github-personal:owner/repo.git";
      const rewritten = yield* resolveGitRemoteForSourceControl(original, () =>
        Effect.succeed(null),
      );

      assert.strictEqual(rewritten, original);
      assert.strictEqual(detectSourceControlProviderFromRemoteUrl(rewritten)?.kind, "unknown");
    }),
  );

  it.effect("does not invent github.com and does not resolve dotted hosts", () =>
    Effect.gen(function* () {
      let resolveCalls = 0;
      const resolve = () => {
        resolveCalls += 1;
        return Effect.succeed("evil.example");
      };

      assert.strictEqual(
        yield* resolveGitRemoteForSourceControl("git@github.com:owner/repo.git", resolve),
        "git@github.com:owner/repo.git",
      );
      assert.strictEqual(resolveCalls, 0);
    }),
  );

  it.effect("leaves the original remote when ssh -G fails", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeFailedProcess({ stdout: "", stderr: "ssh: Could not resolve hostname" })),
    );
    const processLayer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const original = "git@github-personal:owner/repo.git";
      const rewritten = yield* resolveGitRemoteForSourceControl(original);

      assert.strictEqual(rewritten, original);
      assert.strictEqual(detectSourceControlProviderFromRemoteUrl(rewritten)?.kind, "unknown");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("leaves the original remote when ssh -G times out", () => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeNeverFinishingProcess()));
    const processLayer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      TestClock.layer(),
    );

    return Effect.gen(function* () {
      const original = "git@github-personal:owner/repo.git";
      const fiber = yield* Effect.forkChild(resolveGitRemoteForSourceControl(original));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(SSH_CONFIG_RESOLVE_TIMEOUT_MS));

      const rewritten = yield* Fiber.join(fiber);

      assert.strictEqual(rewritten, original);
      assert.strictEqual(detectSourceControlProviderFromRemoteUrl(rewritten)?.kind, "unknown");
    }).pipe(Effect.provide(processLayer));
  });
});
