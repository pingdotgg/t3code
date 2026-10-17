// @effect-diagnostics nodeBuiltinImport:off - the spawn host tests watch real child processes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import * as SpawnHost from "./process/SpawnHost.ts";
import * as ProcessRunner from "./processRunner.ts";

type ChildProcessCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly shell?: boolean | string;
  };
};

function asChildProcessCommand(command: unknown): ChildProcessCommand {
  return command as ChildProcessCommand;
}

function makeHandle(input: {
  readonly stdout?: string | Stream.Stream<Uint8Array>;
  readonly stderr?: string | Stream.Stream<Uint8Array>;
  readonly code?: number;
  readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: input.stdin ?? Sink.drain,
    stdout:
      typeof input.stdout === "string"
        ? Stream.encodeText(Stream.make(input.stdout))
        : (input.stdout ?? Stream.empty),
    stderr:
      typeof input.stderr === "string"
        ? Stream.encodeText(Stream.make(input.stderr))
        : (input.stderr ?? Stream.empty),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeSpawner(
  f: (
    command: ChildProcessCommand,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError>,
) {
  return ChildProcessSpawner.make((command) => f(asChildProcessCommand(command)));
}

const runWith =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  (input: ProcessRunner.ProcessRunInput) =>
    Effect.service(ProcessRunner.ProcessRunner).pipe(
      Effect.flatMap((runner) =>
        runner.run({
          ...input,
        }),
      ),
      Effect.provide(
        ProcessRunner.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
    );

describe("runProcess", () => {
  it.effect("collects stdout through an injected ChildProcessSpawner", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner((command) =>
        Effect.sync(() => {
          expect(command.command).toBe("fake");
          expect(command.args).toEqual(["stdout-bytes", "32"]);
          return makeHandle({ stdout: "x".repeat(32) });
        }),
      );

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stdout-bytes", "32"],
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("x".repeat(32));
      expect(result.timedOut).toBe(false);
    }),
  );

  it.effect("runs through the ProcessRunner service", () => {
    const spawner = makeSpawner((command) =>
      Effect.sync(() => {
        expect(command.command).toBe("fake");
        expect(command.args).toEqual(["--service"]);
        return makeHandle({ stdout: "service ok" });
      }),
    );
    const layer = ProcessRunner.layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );

    return Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      const result = yield* runner.run({
        command: "fake",
        args: ["--service"],
      });

      expect(result.stdout).toBe("service ok");
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves and escapes Windows command shims before spawning", () => {
    const spawner = makeSpawner((command) =>
      Effect.sync(() => {
        expect(command.command).toBe(
          [
            '^"C:\\Users\\tester\\AppData\\Roaming\\npm\\az.cmd^"',
            '^"repos^"',
            '^"pr^"',
            '^"list^"',
            '^"--source-branch^"',
            '^"feature^ ^&^ release^"',
          ].join(" "),
        );
        expect(command.args).toEqual([]);
        expect(command.options.shell).toBe(true);
        return makeHandle({ stdout: "[]" });
      }),
    );

    return runWith(spawner)({
      command: "az",
      args: ["repos", "pr", "list", "--source-branch", "feature & release"],
      env: { AZURE_CONFIG_DIR: "C:\\Users\\tester\\.azure" },
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {
        PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      }),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) =>
        env.PATH === "C:\\Users\\tester\\AppData\\Roaming\\npm" &&
        env.AZURE_CONFIG_DIR === "C:\\Users\\tester\\.azure"
          ? "C:\\Users\\tester\\AppData\\Roaming\\npm\\az.cmd"
          : undefined,
      ),
      Effect.map((result) => {
        expect(result.stdout).toBe("[]");
      }),
    );
  });

  it.effect("preserves resolved spawn context and cause", () =>
    Effect.gen(function* () {
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcessSpawner",
        method: "spawn",
        pathOrDescriptor: "/actual/fake",
      });
      const spawner = makeSpawner(() => Effect.fail(cause));

      const error = yield* runWith(spawner)({
        command: "fake",
        args: ["--flag", "secret-token-value"],
        cwd: "/logical",
        spawnCwd: "/actual",
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ProcessSpawnError");
      if (error._tag !== "ProcessSpawnError") {
        return expect.fail("Expected ProcessSpawnError");
      }
      expect(error).toMatchObject({
        command: "fake",
        argumentCount: 2,
        cwd: "/logical",
        spawnCwd: "/actual",
        resolvedCommand: "fake",
        resolvedArgumentCount: 2,
        shell: false,
      });
      expect(error.cause).toBe(cause);
      expect(error.message).toBe("Failed to spawn process 'fake' in '/actual'");
      expect(error).not.toHaveProperty("args");
      expect(error).not.toHaveProperty("resolvedArgs");
      expect(error.message).not.toContain("secret-token-value");
    }),
  );

  it.effect("fails when output exceeds max buffer in default mode", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() => Effect.succeed(makeHandle({ stdout: "x".repeat(2048) })));

      const error = yield* runWith(spawner)({
        command: "fake",
        args: ["stdout-bytes", "2048"],
        maxOutputBytes: 128,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ProcessOutputLimitError");
      if (error._tag !== "ProcessOutputLimitError") {
        return expect.fail("Expected ProcessOutputLimitError");
      }
      expect(error).toMatchObject({
        stream: "stdout",
        maxBytes: 128,
        observedBytes: 2048,
      });
      expect(error.message).toBe(
        "Process 'fake' stdout produced 2048 bytes, exceeding the 128 byte limit",
      );
    }),
  );

  it.effect("accepts output at the byte limit followed by an empty chunk", () =>
    Effect.gen(function* () {
      const output = new TextEncoder().encode("exactly");
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            stdout: Stream.make(output, new Uint8Array()),
          }),
        ),
      );

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["exact-limit"],
        maxOutputBytes: output.byteLength,
      });

      expect(result.stdout).toBe("exactly");
    }),
  );

  it.effect("fails fast on output limit before timeout for long-running output", () =>
    Effect.gen(function* () {
      const textChunk = "x".repeat(64);
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            stdout: Stream.fromIterable(Array.from({ length: 10 }, () => textChunk)).pipe(
              Stream.encodeText,
            ),
            exitCode: Effect.never,
          }),
        ),
      );

      const error = yield* runWith(spawner)({
        command: "fake",
        args: ["spam-stdout"],
        maxOutputBytes: 128,
        timeout: "2 seconds",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProcessRunner.ProcessOutputLimitError);
    }),
  );

  it.effect("truncates output when outputMode is truncate", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() => Effect.succeed(makeHandle({ stdout: "x".repeat(2048) })));

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stdout-bytes", "2048"],
        maxOutputBytes: 128,
        outputMode: "truncate",
      });

      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeLessThanOrEqual(128);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(false);
    }),
  );

  it.effect("writes stdin before waiting for exit", () =>
    Effect.gen(function* () {
      const stdinWritten = yield* Deferred.make<void>();
      const decoder = new TextDecoder();
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            stdout: "stdin payload",
            stdin: Sink.forEach((chunk: Uint8Array) => {
              const text = decoder.decode(chunk, { stream: true });
              return text.includes("stdin payload")
                ? Deferred.succeed(stdinWritten, undefined)
                : Effect.void;
            }),
            exitCode: Deferred.await(stdinWritten).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          }),
        ),
      );

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stdin-echo"],
        stdin: "stdin payload",
      });

      expect(result.stdout).toBe("stdin payload");
      expect(result.code).toBe(0);
    }),
  );

  it.effect("returns output for non-zero exit codes", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() => Effect.succeed(makeHandle({ stderr: "boom", code: 2 })));

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stderr-exit", "boom", "2"],
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toBe("boom");
    }),
  );

  it.effect("fails on timeout", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.never,
          }),
        ),
      );
      const errorFiber = yield* runWith(spawner)({
        command: "fake",
        args: ["sleep"],
        cwd: "/logical",
        spawnCwd: "/actual",
        timeout: "50 millis",
      }).pipe(Effect.flip, Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(50));
      const error = yield* Fiber.join(errorFiber);

      expect(error._tag).toBe("ProcessTimeoutError");
      if (error._tag !== "ProcessTimeoutError") {
        return expect.fail("Expected ProcessTimeoutError");
      }
      expect(error).toMatchObject({
        command: "fake",
        argumentCount: 1,
        cwd: "/logical",
        spawnCwd: "/actual",
        timeoutMs: 50,
      });
      expect(error.message).toBe("Process 'fake' in '/actual' timed out after 50ms");
    }),
  );

  it.effect("returns a synthetic timed out result when timeoutBehavior is timedOutResult", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.never,
          }),
        ),
      );
      const resultFiber = yield* runWith(spawner)({
        command: "fake",
        args: ["sleep"],
        timeout: "50 millis",
        timeoutBehavior: "timedOutResult",
      }).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(50));
      const result = yield* Fiber.join(resultFiber);

      expect(result).toMatchObject({
        stdout: "",
        stderr: "",
        code: null,
        timedOut: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    }),
  );
});

const hostPlatform = HostProcess.Platform.defaultValue();

describe.skipIf(hostPlatform === "win32")("runProcess through the spawn host", () => {
  const hostFailures: Array<SpawnHost.SpawnHostFailure> = [];
  const layer = ProcessRunner.layer.pipe(
    Layer.provideMerge(
      SpawnHost.layerHost(
        process.execPath,
        [NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)), "__spawn-host"],
        (failure) => hostFailures.push(failure),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const run = (input: ProcessRunner.ProcessRunInput) =>
    Effect.flatMap(Effect.service(ProcessRunner.ProcessRunner), (runner) => runner.run(input));
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Runs `sleep 30` that records its pid, so the test can find it. */
  const sleeper = (pidFile: string) => ({
    command: "sh",
    args: ["-c", `echo $$ > '${pidFile}'; exec sleep 30`],
  });
  let pidFiles = 0;
  const tempPidFile = () =>
    NodePath.join(NodeOS.tmpdir(), `t3-spawn-host-${process.pid}-${++pidFiles}.pid`);
  const readPid = (pidFile: string) =>
    Effect.gen(function* () {
      while (!NodeFS.existsSync(pidFile)) yield* Effect.sleep("20 millis");
      yield* Effect.sleep("50 millis");
      const pid = Number(NodeFS.readFileSync(pidFile, "utf8"));
      NodeFS.rmSync(pidFile);
      return pid;
    });
  /** `pid (comm) state ppid ...` */
  const parentPid = (pid: number) =>
    Number(NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[1]);
  /** This process's open sockets by inode, so a reused fd number is not taken for the old socket. */
  const openSockets = () =>
    new Set(
      NodeFS.readdirSync("/proc/self/fd").flatMap((fd) => {
        try {
          const target = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
          return target.startsWith("socket:") ? [target] : [];
        } catch {
          return [];
        }
      }),
    );

  it.live("streams stdin, stdout, stderr and the exit code", () =>
    Effect.gen(function* () {
      const input = `${"x".repeat(2_000_000)}\n`;
      const echoed = yield* run({
        command: "sh",
        args: ["-c", "cat; echo done >&2; exit 3"],
        stdin: input,
        maxOutputBytes: 4_000_000,
      });
      expect(echoed.stdout).toBe(input);
      expect(echoed.stderr).toBe("done\n");
      expect(echoed.code).toBe(3);
    }).pipe(Effect.provide(layer)),
  );

  it.live("survives unread stdin resets and still reports active write failures", () =>
    Effect.gen(function* () {
      const child = { command: "sh", args: ["-c", "sleep .02; exit 0"] };
      const result = yield* run({ ...child, stdin: "x".repeat(1024) });
      expect(result.code).toBe(0);

      const error = yield* run({ ...child, stdin: "x".repeat(2_000_000) }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProcessRunner.ProcessStdinError);
    }).pipe(Effect.provide(layer)),
  );

  it.live.skipIf(hostPlatform !== "linux")(
    "closes the sockets of output nobody reads once the child exits",
    () =>
      Effect.gen(function* () {
        // Starts the host first, so its channel is not counted.
        yield* run({ command: "true", args: [] });
        const before = openSockets();
        // The limit stops the reader with output still buffered in the socket.
        const error = yield* run({ command: "yes", args: [], maxOutputBytes: 1_000 }).pipe(
          Effect.flip,
        );
        expect(error._tag).toBe("ProcessOutputLimitError");
        const leaked = () => [...openSockets()].filter((socket) => !before.has(socket));
        for (let attempt = 0; attempt < 100 && leaked().length > 0; attempt++) {
          yield* Effect.sleep("20 millis");
        }
        expect(leaked()).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.live.skipIf(hostPlatform !== "linux")(
    "fails and stops a running child when the host dies, then starts a new host",
    () =>
      Effect.gen(function* () {
        // An unreferenced child, like an editor the launcher detaches, outlives the host.
        const keptPidFile = tempPidFile();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner
          .spawn(
            ChildProcess.make("sh", ["-c", `echo $$ > '${keptPidFile}'; exec sleep 30`], {
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.flatMap((handle) => handle.unref),
            Effect.asVoid,
            Effect.scoped,
          );
        const keptPid = yield* readPid(keptPidFile);
        const pidFile = tempPidFile();
        const running = yield* run(sleeper(pidFile)).pipe(Effect.flip, Effect.forkScoped);
        const childPid = yield* readPid(pidFile);
        // The children's parent is the host.
        const hostPid = parentPid(childPid);
        expect(hostPid).not.toBe(process.pid);
        expect(parentPid(keptPid)).toBe(hostPid);
        process.kill(hostPid, "SIGKILL");

        const error = yield* Fiber.join(running);
        expect(error._tag).toBe("ProcessReadError");
        expect(isAlive(childPid)).toBe(false);
        expect(isAlive(keptPid)).toBe(true);
        process.kill(-keptPid, "SIGKILL");
        expect(hostFailures.at(-1)).toMatchObject({ failures: 1, disabled: false });

        const after = yield* run({ command: "echo", args: ["again"] });
        expect(after.stdout).toBe("again\n");
      }).pipe(Effect.provide(layer)),
  );
});

describe("isWindowsCommandNotFound", () => {
  it.effect("matches the localized German cmd.exe error text", () =>
    Effect.gen(function* () {
      const isCommandNotFound = yield* ProcessRunner.isWindowsCommandNotFound(
        1,
        "wird nicht als interner oder externer Befehl, betriebsfahiges Programm oder Batch-Datei erkannt",
      ).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      expect(isCommandNotFound).toBe(true);
    }),
  );
});

describe("commandName", () => {
  it("drops the directory from POSIX and Windows paths", () => {
    expect(ProcessRunner.commandName("/Users/me/.local/bin/claude")).toBe("claude");
    expect(ProcessRunner.commandName("C:\\Program Files\\nodejs\\npx.cmd")).toBe("npx.cmd");
    expect(ProcessRunner.commandName("git")).toBe("git");
  });
});
