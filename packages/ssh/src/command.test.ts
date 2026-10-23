import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { parseSshResolveOutput, remoteStateKey, runSshCommand } from "./command.ts";
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

  it.effect("passes an option-shaped alias to ssh as the destination", () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) spawned.push(command.args);
      return Effect.succeed(makeFailedProcess({ stdout: "", stderr: "bad hostname\n" }));
    });
    return runSshCommand(
      { alias: "-oProxyCommand=false", hostname: "devbox", username: null, port: null },
      { remoteCommandArgs: ["sh", "-s"] },
    ).pipe(
      Effect.flip,
      Effect.map(() => {
        assert.deepEqual(spawned[0]?.slice(-4), ["--", "-oProxyCommand=false", "sh", "-s"]);
      }),
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });

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

  it.live.each([
    { name: "default head", keepErrorOutputTail: undefined, exitCode: 1, stderr: "" },
    {
      name: "opt-in tail",
      keepErrorOutputTail: true,
      exitCode: 1,
      stderr: "stderr failure ".repeat(400),
    },
    { name: "successful output", keepErrorOutputTail: true, exitCode: 0, stderr: "" },
  ])("preserves process output: $name", ({ keepErrorOutputTail, exitCode, stderr }) =>
    Effect.gen(function* () {
      const prefix = `HEAD\n${"verbose-prefix ".repeat(400)}`;
      const secret = "synthetic-secret".repeat(400);
      const diagnostic = "\nPANIC: emulator SDK is broken\n";
      const stdout = `${prefix}{"credential":"${secret}"}${diagnostic}`;
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Replace only the SSH endpoint with a real, deterministic process.
      const spawner = ChildProcessSpawner.make(() =>
        nativeSpawner.spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode};`,
          ]),
        ),
      );
      const command = runSshCommand(
        { alias: "synthetic-fixture", hostname: "synthetic-fixture", username: null, port: null },
        keepErrorOutputTail === undefined ? {} : { keepErrorOutputTail },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      if (exitCode === 0) {
        assert.deepEqual(yield* command, { stdout, stderr });
        return;
      }
      const failure = yield* Effect.flip(command);
      assert.instanceOf(failure, SshCommandError);
      assert.equal(failure.exitCode, 1);
      assert.equal(failure.stderr, stderr);
      assert.equal(failure.message, stderr.trim() || failure.stdout?.trim());
      const redacted = `${prefix}{"credential":"[redacted]"}${diagnostic}`;
      assert.equal(
        failure.stdout,
        keepErrorOutputTail
          ? `[truncated]\n${redacted.slice(-4_000)}`
          : `${redacted.slice(0, 4_000)}\n[truncated]`,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
});
