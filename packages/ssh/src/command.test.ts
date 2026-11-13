import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { parseSshResolveOutput, remoteStateKey, runSshCommand } from "./command.ts";
import { SshCommandError } from "./errors.ts";

const encoder = new TextEncoder();
const isSshCommandError = Schema.is(SshCommandError);

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
      if (ChildProcess.isStandardCommand(command)) spawned.push(command.args.map(String));
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
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
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
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a timed-out command leaves no helper running that ignored SIGTERM",
    () =>
      Effect.gen(function* () {
        const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Stands in for ssh and a ProxyCommand: ssh exits on SIGTERM, the proxy ignores it.
        const spawner = ChildProcessSpawner.make((command) =>
          nativeSpawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "-e",
                `const proxy = require("node:child_process").spawn("sh", ["-c", "trap '' TERM; exec sleep 60"], { stdio: "ignore" });
              process.stdout.write(proxy.pid + "\\n");
              setInterval(() => {}, 1000);`,
              ],
              command._tag === "StandardCommand" ? command.options : {},
            ),
          ),
        );
        const failure = yield* runSshCommand(
          { alias: "synthetic-fixture", hostname: "synthetic-fixture", username: null, port: null },
          { timeoutMs: 1_000, keepErrorOutputTail: true },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.flip,
        );
        assert.instanceOf(failure, SshCommandError);
        assert.equal(failure.message, "SSH command timed out after 1000ms.");
        const proxyPid = Number(failure.stdout?.trim());
        assert.isTrue(Number.isSafeInteger(proxyPid) && proxyPid > 1);
        const state = (yield* nativeSpawner.string(
          ChildProcess.make("ps", ["-p", String(proxyPid), "-o", "stat="]),
        )).trim();
        if (state !== "" && !state.startsWith("Z")) process.kill(proxyPid, "SIGKILL");
        assert.isTrue(state === "" || state.startsWith("Z"), `proxy still running (${state})`);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("enables server-alive checks for long remote commands", () =>
    Effect.gen(function* () {
      // Ask OpenSSH for its effective configuration without opening a connection.
      const { stdout } = yield* runSshCommand(
        { alias: "synthetic-fixture", hostname: "synthetic-fixture", username: null, port: null },
        { preHostArgs: ["-F", "none", "-G"], timeoutMs: 900_000 },
      );
      assert.match(stdout, /^serveraliveinterval 15\r?$/mu);
      assert.match(stdout, /^serveralivecountmax 3\r?$/mu);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("redacts credentials from stdout in non-zero command failures", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeFailedProcess({ stdout: '{"credential":"pairing-secret"}\n' })),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerSpawner);

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

  it.effect("keeps redacted output the command emitted before timing out", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.concat(
            Stream.make(encoder.encode('PROGRESS: extracting\n{"credential":"pairing-secret"}\n')),
            Stream.never,
          ),
          stderr: Stream.concat(
            Stream.make(encoder.encode("REMOTE: waiting for archive extraction\n")),
            Stream.never,
          ),
          all: Stream.empty,
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);

    return Effect.gen(function* () {
      const fiber = yield* runSshCommand(
        { alias: "devbox", hostname: "devbox", username: null, port: null },
        { remoteCommandArgs: ["sh", "-s"], timeoutMs: 1_000, keepErrorOutputTail: true },
      ).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const failure = yield* Fiber.join(fiber);

      assert.instanceOf(failure, SshCommandError);
      assert.equal(failure.exitCode, null);
      assert.equal(failure.stdout, 'PROGRESS: extracting\n{"credential":"[redacted]"}\n');
      assert.equal(failure.stderr, "REMOTE: waiting for archive extraction\n");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerSpawner)));
  });

  const changedKeyStderr =
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n" +
    "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n" +
    "  ssh-keygen -f '/home/me/.ssh/known_hosts' -R 'devbox'\r\n" +
    "Host key verification failed.\r\n";

  it.effect.each([
    {
      name: "quotes the terminal command for a POSIX shell",
      target: { alias: "my host", username: "o'brien" },
      platform: "linux",
      stderr: "Host key verification failed.\r\n",
      expected: ["`ssh 'o'\\''brien@my host'`"],
    },
    {
      name: "quotes the terminal command for a Windows shell",
      target: { alias: "my host", username: "me" },
      platform: "win32",
      stderr: "Host key verification failed.\r\n",
      expected: ['`ssh "me@my host"`'],
    },
    {
      name: "keeps an option-shaped alias out of the option list",
      target: { alias: "-oProxyCommand=false", username: null },
      platform: "linux",
      stderr: "Host key verification failed.\r\n",
      expected: ["`ssh -- -oProxyCommand=false`"],
    },
    {
      name: "tells the user to remove a changed host key first",
      target: { alias: "devbox", username: null },
      platform: "linux",
      stderr: changedKeyStderr,
      expected: ["has changed", "`ssh-keygen -R`", "`ssh devbox`", "-R 'devbox'"],
    },
  ] as const)("$name", ({ target, platform, stderr, expected }) => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeFailedProcess({ stdout: "", stderr })),
    );
    return runSshCommand({ ...target, hostname: "devbox", port: null }).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.isTrue(isSshCommandError(error));
        for (const text of expected) assert.include(error.message, text);
        if (isSshCommandError(error)) assert.equal(error.stderr, stderr);
      }),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
});
