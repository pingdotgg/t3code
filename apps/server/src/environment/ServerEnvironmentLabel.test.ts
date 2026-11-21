import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

const neverExits = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.never,
      stderr: Stream.never,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

it.effect("falls back to the hostname when hostnamectl never answers", () =>
  Effect.gen(function* () {
    // Without /etc/machine-info the label comes from hostnamectl, which waits on D-Bus.
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "project" }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Hostname, "devbox"),
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
          ProcessRunner.layer.pipe(
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, neverExits)),
          ),
        ),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("5 seconds");
    assert.equal(yield* Fiber.join(label), "devbox");
  }),
);

const exitsWithFailure = ProcessRunner.ProcessRunner.of({
  run: () =>
    Effect.succeed({
      stdout: "",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(1),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});

it.effect("qualifies the inherited Windows hostname only inside WSL", () =>
  Effect.gen(function* () {
    const cases = [
      {
        kernel: "6.6.87.2-microsoft-standard-WSL2",
        machineInfo: null,
        expected: "DESKTOP-PC WSL (Ubuntu)",
      },
      { kernel: "6.8.0-45-generic", machineInfo: null, expected: "DESKTOP-PC" },
      {
        kernel: "6.6.87.2-microsoft-standard-WSL2",
        machineInfo: 'PRETTY_HOSTNAME="Work WSL"',
        expected: "Work WSL",
      },
    ];
    for (const { kernel, machineInfo, expected } of cases) {
      const files: Record<string, string | null> = {
        "/proc/sys/kernel/osrelease": `${kernel}\n`,
        "/etc/machine-info": machineInfo,
      };
      const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "project" }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Hostname, "DESKTOP-PC"),
        Effect.provideService(HostProcess.Environment, { WSL_DISTRO_NAME: "Ubuntu" }),
        Effect.provideService(ProcessRunner.ProcessRunner, exitsWithFailure),
        Effect.provide(
          FileSystem.layerNoop({
            exists: (path) => Effect.succeed(files[path] != null),
            readFileString: (path) => Effect.succeed(files[path] ?? ""),
          }),
        ),
      );
      assert.equal(label, expected, kernel);
    }
  }),
);
