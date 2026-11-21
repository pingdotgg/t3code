import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lathe/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  baseSshArgs,
  parseSshResolveOutput,
  redactSshOutput,
  remoteStateKey,
  resolveSshTarget,
  runSshCommand,
  type SshMultiplex,
} from "./command.ts";
import { SshCommandError } from "./errors.ts";
import { SshOutputObserver, type SshOutputChunk } from "./output.ts";

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

const makeExitedProcess = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const makeNeverFinishingProcess = (stderr: Stream.Stream<Uint8Array> = Stream.empty) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr,
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

  // ssh keeps the first value of an option, so a pin ahead of the host wins
  // over ~/.ssh/config. Without one the user's config still applies.
  it.effect("pins multiplexing only when the caller chooses it", () =>
    Effect.sync(() => {
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
      const controlOptions = (multiplex?: SshMultiplex) =>
        baseSshArgs(target, multiplex === undefined ? {} : { multiplex }).filter((arg) =>
          arg.startsWith("Control"),
        );

      assert.deepEqual(controlOptions(), []);
      assert.deepEqual(controlOptions({ mode: "direct" }), [
        "ControlMaster=no",
        "ControlPath=none",
      ]);
      assert.deepEqual(controlOptions({ mode: "client", socketPath: "/lathe/ssh/a.sock" }), [
        "ControlMaster=no",
        "ControlPath=/lathe/ssh/a.sock",
      ]);
      assert.deepEqual(controlOptions({ mode: "master", socketPath: "/lathe/ssh/a.sock" }), [
        "ControlMaster=yes",
        "ControlPath=/lathe/ssh/a.sock",
      ]);
    }),
  );

  it.effect("puts a chosen multiplexing pin ahead of the host and leaves the rest alone", () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawned.push(command._tag === "StandardCommand" ? command.args.map(String) : []);
        return makeExitedProcess("hostname devbox.example.com\n");
      }),
    );
    const layerProcess = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const controlOptions = (args: ReadonlyArray<string> | undefined, host: string) => {
      assert.isDefined(args);
      const hostIndex = args?.indexOf(host) ?? -1;
      assert.isAbove(hostIndex, 0);
      return args?.slice(0, hostIndex).filter((arg) => arg.startsWith("Control")) ?? [];
    };

    return Effect.gen(function* () {
      yield* runSshCommand(
        { alias: "devbox", hostname: "devbox.example.com", username: "julius", port: 2222 },
        { remoteCommandArgs: ["sh", "-s"] },
      );
      yield* resolveSshTarget("devbox");
      yield* resolveSshTarget("devbox", { multiplex: { mode: "direct" } });
      yield* runSshCommand(
        { alias: "devbox", hostname: "devbox.example.com", username: null, port: null },
        { multiplex: { mode: "client", socketPath: "/home/julius/.lathe/ssh/711bc738.sock" } },
      );

      assert.deepEqual(controlOptions(spawned[0], "julius@devbox"), []);
      assert.deepEqual(controlOptions(spawned[1], "devbox"), []);
      assert.deepEqual(controlOptions(spawned[2], "devbox"), [
        "ControlMaster=no",
        "ControlPath=none",
      ]);
      assert.deepEqual(controlOptions(spawned[3], "devbox"), [
        "ControlMaster=no",
        "ControlPath=/home/julius/.lathe/ssh/711bc738.sock",
      ]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("escalates to SIGKILL when a timed-out ssh ignores SIGTERM", () => {
    const signals: Array<string> = [];
    // Models the Node spawner's scoped release: SIGTERM, then SIGKILL only
    // after the command's forceKillAfter. Without one it waits on the process.
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const forceKillAfter =
          command._tag === "StandardCommand" ? command.options.forceKillAfter : undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            signals.push("SIGTERM");
            if (forceKillAfter === undefined) {
              return yield* Effect.sleep(Duration.hours(1));
            }
            yield* Effect.sleep(forceKillAfter);
            signals.push("SIGKILL");
            yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(137));
          }),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Deferred.await(exited),
          isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const layerProcess = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      TestClock.layer(),
    );

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          runSshCommand(
            { alias: "devbox", hostname: "devbox.example.com", username: null, port: null },
            { timeoutMs: 1_000 },
          ),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      assert.deepEqual(signals, ["SIGTERM"]);
      yield* TestClock.adjust(Duration.seconds(2));

      const exit = fiber.pollUnsafe();
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      assert.isDefined(exit);
      if (exit !== undefined && Exit.isSuccess(exit)) {
        assert.isTrue(Result.isFailure(exit.value));
        if (Result.isFailure(exit.value)) {
          assert.isTrue(
            exit.value.failure._tag === "SshCommandError" && exit.value.failure.timedOut,
          );
        }
      }
    }).pipe(
      // A failed assertion must not leave the test waiting on the stuck release.
      Effect.ensuring(TestClock.adjust(Duration.hours(1))),
      Effect.provide(layerProcess),
    );
  });

  it.effect("overrides an alias's RemoteCommand and RequestTTY", () =>
    Effect.sync(() => {
      assert.deepEqual(
        baseSshArgs(
          { alias: "devbox", hostname: "devbox", username: null, port: 2222 },
          { batchMode: "yes" },
        ),
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "RemoteCommand=none",
          "-o",
          "RequestTTY=no",
          "-p",
          "2222",
        ],
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

  const target = { alias: "devbox", hostname: "devbox.example.com", username: null, port: null };

  const observing = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const chunks: Array<SshOutputChunk> = [];
    return {
      chunks,
      run: effect.pipe(
        Effect.provideService(SshOutputObserver, (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
        ),
      ),
    };
  };

  it.effect(
    "reports output as it arrives, so a command that times out keeps what it printed",
    () => {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeNeverFinishingProcess(
            Stream.concat(Stream.make(encoder.encode("waiting for server\n")), Stream.never),
          ),
        ),
      );
      const processLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        TestClock.layer(),
      );

      return Effect.gen(function* () {
        const { chunks, run } = observing(
          Effect.result(runSshCommand(target, { timeoutMs: 1, observe: { source: "launch" } })),
        );
        const fiber = yield* Effect.forkChild(run);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        const result = yield* Fiber.join(fiber);

        assert.deepEqual(chunks, [
          { source: "launch", stream: "stderr", text: "waiting for server\n" },
        ]);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.isTrue(result.failure._tag === "SshCommandError" && result.failure.timedOut);
        }
      }).pipe(Effect.provide(processLayer));
    },
  );

  it.effect("observes only what the caller opts into, and stdout only when asked", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeFailedProcess({ stdout: '{"credential":"secret"}\n', stderr: "denied\n" }),
      ),
    );
    const processLayer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const unobserved = observing(Effect.result(runSshCommand(target)));
      yield* unobserved.run;
      assert.deepEqual(unobserved.chunks, []);

      const stderrOnly = observing(
        Effect.result(runSshCommand(target, { observe: { source: "launch" } })),
      );
      yield* stderrOnly.run;
      assert.deepEqual(stderrOnly.chunks, [
        { source: "launch", stream: "stderr", text: "denied\n" },
      ]);

      const both = observing(
        Effect.result(runSshCommand(target, { observe: { source: "remote-log", stdout: true } })),
      );
      yield* both.run;
      assert.sameDeepMembers(both.chunks, [
        { source: "remote-log", stream: "stdout", text: '{"credential":"secret"}\n' },
        { source: "remote-log", stream: "stderr", text: "denied\n" },
      ]);
    }).pipe(Effect.provide(processLayer));
  });

  it("redacts tokens in JSON fields and pairing links", () => {
    assert.equal(
      redactSshOutput(
        '{"pairingToken":"abc123"} pairingUrl: http://localhost:5733/pair#token=E5YZ6LG6 and https://h/x?a=1&access_token=Q9&b=2',
      ),
      '{"pairingToken":"[redacted]"} pairingUrl: http://localhost:5733/pair#token=[redacted] and https://h/x?a=1&access_token=[redacted]&b=2',
    );
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
