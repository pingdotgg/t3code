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
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  baseSshArgs,
  getLastNonEmptyOutputLine,
  isSshEnvironmentNameConfiguredForSend,
  parseSshResolveOutput,
  parseSshSendEnvironmentPatterns,
  resolveRemoteT3CliPackageSpec,
  resolveSshTarget,
  runSshCommand,
  sshEnvironmentVariablesEqual,
} from "./command.ts";
import { SshCommandError, SshInvalidTargetError } from "./errors.ts";

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

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(encoder.encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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
  it.effect("compares SSH environment overlays without exposing them in connection keys", () =>
    Effect.sync(() => {
      assert.isTrue(
        sshEnvironmentVariablesEqual(
          { AWS_PROFILE: "production", TOKEN: "secret" },
          { TOKEN: "secret", AWS_PROFILE: "production" },
        ),
      );
      assert.isFalse(sshEnvironmentVariablesEqual({ TOKEN: "old" }, { TOKEN: "replacement" }));
      assert.isFalse(sshEnvironmentVariablesEqual(undefined, { EMPTY_VALUE: "" }));
    }),
  );

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

  it.effect("matches exact and wildcard SendEnv entries, including removals", () =>
    Effect.sync(() => {
      const patterns = parseSshSendEnvironmentPatterns(
        ["sendenv TOKEN", "sendenv LC_*", "sendenv -LC_SECRET", ""].join("\n"),
      );
      assert.deepEqual(patterns, ["TOKEN", "LC_*", "-LC_SECRET"]);
      assert.isTrue(isSshEnvironmentNameConfiguredForSend("TOKEN", patterns));
      assert.isTrue(isSshEnvironmentNameConfiguredForSend("LC_ALL", patterns));
      assert.isFalse(isSshEnvironmentNameConfiguredForSend("LC_SECRET", patterns));
      assert.isFalse(isSshEnvironmentNameConfiguredForSend("OTHER", patterns));
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

  it.effect("resolves the remote t3 package spec from the desktop release channel", () =>
    Effect.sync(() => {
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.17",
          updateChannel: "latest",
        }),
        "t3@0.0.17",
      );
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.17-nightly.20260415.44",
          updateChannel: "nightly",
        }),
        "t3@0.0.17-nightly.20260415.44",
      );
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.0-dev",
          updateChannel: "nightly",
          isDevelopment: true,
        }),
        "t3@nightly",
      );
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.0-dev",
          updateChannel: "latest",
          isDevelopment: true,
        }),
        "t3@nightly",
      );
    }),
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
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer);

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
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("adds target environment variables to the local ssh process", () => {
    let spawnedEnvironment: Readonly<Record<string, string | undefined>> | undefined;
    const spawner = ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly options: {
          readonly env?: Readonly<Record<string, string | undefined>>;
          readonly extendEnv?: boolean;
        };
      };
      spawnedEnvironment = childProcess.options.env;
      assert.equal(childProcess.options.extendEnv, true);
      return Effect.succeed(makeFailedProcess({ stdout: "", stderr: "expected failure" }));
    });
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      yield* Effect.result(
        runSshCommand(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
            environmentVariables: {
              AWS_PROFILE: "production",
              EMPTY_VALUE: "",
            },
          },
          { remoteCommandArgs: ["true"] },
        ),
      );

      assert.equal(spawnedEnvironment?.AWS_PROFILE, "production");
      assert.equal(spawnedEnvironment?.EMPTY_VALUE, "");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("validates SendEnv before resolving SSH config with the forwarded variables", () => {
    const spawnedEnvironments: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      spawnedEnvironments.push(
        command._tag === "StandardCommand" ? command.options.env : undefined,
      );
      return Effect.succeed(
        makeSuccessfulProcess(
          ["hostname devbox.example.com", "user julius", "port 2222", "sendenv TOKEN", ""].join(
            "\n",
          ),
        ),
      );
    });
    const processLayer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const target = yield* resolveSshTarget("devbox", { TOKEN: "forwarded-value" });

      assert.isUndefined(spawnedEnvironments[0]?.TOKEN);
      assert.isUndefined(spawnedEnvironments[1]?.TOKEN);
      assert.equal(spawnedEnvironments[2]?.TOKEN, "forwarded-value");
      assert.deepEqual(target, {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
        environmentVariables: { TOKEN: "forwarded-value" },
      });
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("validates SendEnv with the managed remote command", () => {
    const spawnedArgs: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawnedArgs.push(args);
      const commandSpecificConfig = args.includes("sh");
      return Effect.succeed(
        makeSuccessfulProcess(
          [
            "hostname devbox.example.com",
            "user julius",
            "port 2222",
            ...(commandSpecificConfig ? ["sendenv TOKEN"] : []),
            "",
          ].join("\n"),
        ),
      );
    });
    const processLayer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const target = yield* resolveSshTarget("devbox", { TOKEN: "forwarded-value" });

      assert.equal(spawnedArgs.length, 3);
      assert.notInclude(spawnedArgs[0] ?? [], "sh");
      assert.include(spawnedArgs[1] ?? [], "sh");
      assert.include(spawnedArgs[2] ?? [], "sh");
      assert.equal(target.environmentVariables?.TOKEN, "forwarded-value");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("rejects variables not selected by SendEnv", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(
          ["hostname devbox.example.com", "user julius", "port 2222", "sendenv LANG", ""].join(
            "\n",
          ),
        ),
      ),
    );
    const processLayer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const error = yield* resolveSshTarget("devbox", { TOKEN: "value" }).pipe(Effect.flip);
      assert.instanceOf(error, SshInvalidTargetError);
      assert.include(error.message, "Add TOKEN to SendEnv for devbox");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("rejects a variable removed from SendEnv by the forwarded environment", () => {
    let resolveCount = 0;
    const spawner = ChildProcessSpawner.make(() => {
      resolveCount += 1;
      return Effect.succeed(
        makeSuccessfulProcess(
          resolveCount <= 2
            ? "hostname devbox.example.com\nsendenv TOKEN\n"
            : "hostname devbox.example.com\n",
        ),
      );
    });
    const processLayer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const error = yield* resolveSshTarget("devbox", { TOKEN: "value" }).pipe(Effect.flip);
      assert.instanceOf(error, SshInvalidTargetError);
      assert.include(error.message, "no longer selects TOKEN");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("redacts credentials from stdout in non-zero command failures", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeFailedProcess({ stdout: '{"credential":"pairing-secret"}\n' })),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer);

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
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("fails commands that never finish", () => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeNeverFinishingProcess()));
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

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
    }).pipe(Effect.provide(processLayer));
  });
});
