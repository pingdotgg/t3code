import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HostProcessHostname, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { vi } from "vite-plus/test";

import { ProcessRunner, ProcessSpawnError, type ProcessRunnerShape } from "../../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";
import { ChildProcessSpawner } from "effect/unstable/process";

const runMock = vi.fn<ProcessRunnerShape["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner,
  ProcessRunner.of({
    run: (input) => runMock(input),
  }),
);
const NoopFileSystemLayer = FileSystem.layerNoop({});
const TestLayer = Layer.merge(NoopFileSystemLayer, ProcessRunnerTest);
const LinuxMachineInfoLayer = Layer.merge(
  ProcessRunnerTest,
  FileSystem.layerNoop({
    exists: (path) => Effect.succeed(path === "/etc/machine-info"),
    readFileString: (path) =>
      path === "/etc/machine-info"
        ? Effect.succeed('PRETTY_HOSTNAME="Build Agent 01"\nICON_NAME="computer-vm"\n')
        : Effect.succeed(""),
  }),
);
const withHostPlatform = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
  platform: NodeJS.Platform,
  hostname: string,
) =>
  Layer.mergeAll(
    layer,
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessHostname, hostname),
  );

afterEach(() => {
  runMock.mockReset();
});

describe("resolveServerEnvironmentLabel", () => {
  it.effect("uses hostname fallback regardless of launch mode", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostPlatform(TestLayer, "win32", "macbook-pro")));

      expect(result).toBe("macbook-pro");
    }),
  );

  it.effect("prefers the macOS ComputerName", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed({
          stdout: " Julius's MacBook Pro \n",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostPlatform(TestLayer, "darwin", "macbook-pro")));

      expect(result).toBe("Julius's MacBook Pro");
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "scutil",
          args: ["--get", "ComputerName"],
          timeoutBehavior: "timedOutResult",
        }),
      );
    }),
  );

  it.effect("prefers Linux PRETTY_HOSTNAME from machine-info", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostPlatform(LinuxMachineInfoLayer, "linux", "buildbox")));

      expect(result).toBe("Build Agent 01");
      expect(runMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("falls back to hostnamectl pretty hostname on Linux", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed({
          stdout: "CI Runner\n",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostPlatform(TestLayer, "linux", "runner-01")));

      expect(result).toBe("CI Runner");
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "hostnamectl",
          args: ["--pretty"],
          timeoutBehavior: "timedOutResult",
        }),
      );
    }),
  );

  it.effect("falls back to the hostname when friendly labels are unavailable", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostPlatform(TestLayer, "win32", "JULIUS-LAPTOP")));

      expect(result).toBe("JULIUS-LAPTOP");
    }),
  );

  it.effect("falls back to the hostname when the friendly-label command is missing", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.fail(
          new ProcessSpawnError({
            command: "scutil",
            args: ["--get", "ComputerName"],
            cause: new Error("spawn scutil ENOENT"),
          }),
        ),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostPlatform(TestLayer, "darwin", "macbook-pro")));

      expect(result).toBe("macbook-pro");
    }),
  );

  it.effect("falls back to the cwd basename when the hostname is blank", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed({
          stdout: " ",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostPlatform(TestLayer, "linux", "   ")));

      expect(result).toBe("t3code");
    }),
  );
});
