import { isWindowsCommandNotFound } from "@t3tools/provider-core/server/snapshotProbe";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import * as ProcessLauncher from "./process/ProcessLauncher.ts";
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
        ProcessRunner.layerWithSpawner.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
    );

describe("runProcess", () => {
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

  it.effect("types spawn failures that the platform spawner throws synchronously", () =>
    Effect.gen(function* () {
      // File-valued PATH entries make spawn throw ENOTDIR synchronously, arriving through Effect.callback as a defect.
      const defect = Object.assign(new Error("spawn jj ENOTDIR"), { code: "ENOTDIR" });
      const spawner = makeSpawner(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      );

      const error = yield* runWith(spawner)({
        command: "jj",
        args: ["--version"],
        cwd: "/repo",
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ProcessSpawnError");
      if (error._tag !== "ProcessSpawnError") {
        return expect.fail("Expected ProcessSpawnError");
      }
      expect(error).toMatchObject({ command: "jj", argumentCount: 1, cwd: "/repo" });
      expect(error.cause).toBe(defect);
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
});

describe("ProcessRunner.layer", () => {
  // Forking the server for every git call stalls its event loop in proportion to its RSS.
  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "launches commands from a helper process instead of forking the server",
    () =>
      Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const result = yield* runner.run({ command: "sh", args: ["-c", "echo $PPID"] });

        expect(
          Number(result.stdout.trim()),
          "the command's parent process is the server process itself",
        ).not.toBe(process.pid);
      }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)))),
  );

  // Callers report a missing CLI from the NotFound reason.
  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "reports a missing command as a NotFound spawn failure",
    () =>
      Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const error = yield* runner
          .run({ command: "t3code-missing-command", args: [] })
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProcessSpawnError");
        expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
        expect((error.cause as PlatformError.PlatformError).reason._tag).toBe("NotFound");
      }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)))),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "kills descendants that ignore SIGTERM when a run is interrupted",
    () =>
      Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const leader = yield* Deferred.make<number>();
        const run = yield* runner
          .run({
            command: "sh",
            args: ["-c", `(trap "" TERM; exec sleep 1000) & echo $$; wait`],
            onStdoutChunk: (chunk) =>
              Deferred.doneUnsafe(leader, Exit.succeed(Number(new TextDecoder().decode(chunk)))),
          })
          .pipe(Effect.forkChild);
        const pgid = yield* Deferred.await(leader);
        yield* Fiber.interrupt(run);

        expect(() => process.kill(-pgid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)))),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "runs in the server's working directory and fails stdin a command never reads",
    () =>
      Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const result = yield* runner.run({ command: "pwd", args: [] });
        const error = yield* runner
          .run({ command: "true", args: [], stdin: "x".repeat(16 * 1024 * 1024) })
          .pipe(Effect.flip);

        expect(result.stdout.trim()).toBe(process.cwd());
        expect(error._tag).toBe("ProcessStdinError");
      }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)))),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "rejects a NUL byte in an environment value without echoing the value",
    () =>
      Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const error = yield* runner
          .run({ command: "true", args: [], env: { T3_TOKEN: "secret\0value" } })
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProcessSpawnError");
        expect((error.cause as PlatformError.PlatformError).reason._tag).toBe("BadArgument");
        expect(String(error.cause)).toContain("T3_TOKEN");
        expect(String(error.cause)).not.toContain("secret");
      }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)))),
  );

  // Descendants keep writing after the leader exits; losing the helper must not truncate that.
  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "delivers output written after the helper process dies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(
          ChildProcess.make("sh", [
            "-c",
            `d=$(mktemp -d); mkfifo "$d/f"; (cat "$d/f"; rm -r "$d") & echo "$PPID $d/f"`,
          ]),
        );
        expect(yield* handle.exitCode).toBe(0);
        const output = yield* handle.stdout.pipe(
          Stream.tap((chunk) => {
            const [helper, fifo] = new TextDecoder().decode(chunk).trim().split(" ");
            if (fifo === undefined) return Effect.void;
            process.kill(Number(helper), "SIGKILL");
            return fs.writeFileString(fifo, "complete\n");
          }),
          Stream.decodeText(),
          Stream.mkString,
        );

        expect(output).toMatch(/ \S+\ncomplete\n$/);
      }).pipe(
        Effect.scoped,
        Effect.provide(ProcessLauncher.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
  );
});

describe("isWindowsCommandNotFound", () => {
  it.effect("matches the localized German cmd.exe error text", () =>
    Effect.gen(function* () {
      const isCommandNotFound = yield* isWindowsCommandNotFound(
        1,
        "wird nicht als interner oder externer Befehl, betriebsfahiges Programm oder Batch-Datei erkannt",
      ).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      expect(isCommandNotFound).toBe(true);
    }),
  );
});
