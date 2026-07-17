import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessHostname, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerEnvironmentLabel from "./ServerEnvironmentLabel.ts";

const isServerEnvironmentLabelFileError = Schema.is(
  ServerEnvironmentLabel.ServerEnvironmentLabelFileError,
);
const isServerEnvironmentLabelCommandError = Schema.is(
  ServerEnvironmentLabel.ServerEnvironmentLabelCommandError,
);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
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
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
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

      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
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
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
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

      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
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
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostPlatform(TestLayer, "win32", "JULIUS-LAPTOP")));

      expect(result).toBe("JULIUS-LAPTOP");
    }),
  );

  it.effect("falls back to the hostname when the friendly-label command is missing", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });
    const spawnCause = new Error("spawn scutil ENOENT");
    const processError = new ProcessRunner.ProcessSpawnError({
      command: "scutil",
      argumentCount: 2,
      cause: spawnCause,
    });
    runMock.mockReturnValueOnce(Effect.fail(processError));

    return Effect.gen(function* () {
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      });

      expect(result).toBe("macbook-pro");
      expect(logs[0]?.message).toEqual([
        "Failed to run environment-label probe 'macos-computer-name' with scutil.",
      ]);
      const error = logs[0]?.annotations.cause;
      expect(isServerEnvironmentLabelCommandError(error)).toBe(true);
      if (isServerEnvironmentLabelCommandError(error)) {
        expect(error.probe).toBe("macos-computer-name");
        expect(error.executable).toBe("scutil");
        expect(error.argumentCount).toBe(2);
        expect(error).not.toHaveProperty("args");
        expect(error.message).not.toContain("--get");
        expect(error.message).not.toContain("ComputerName");
        expect(error.cause).toBe(processError);
        expect(processError.cause).toBe(spawnCause);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          withHostPlatform(TestLayer, "darwin", "macbook-pro"),
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ),
      ),
    );
  });

  it.effect("continues to hostnamectl after a machine-info inspect failure", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });
    const fileCause = new Error("permission denied");
    const platformError = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "exists",
      pathOrDescriptor: "/etc/machine-info",
      cause: fileCause,
    });
    const fileSystemLayer = FileSystem.layerNoop({
      exists: () => Effect.fail(platformError),
    });
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

    return Effect.gen(function* () {
      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      });

      expect(result).toBe("CI Runner");
      expect(logs[0]?.message).toEqual([
        "Failed to inspect environment-label file at /etc/machine-info.",
      ]);
      const error = logs[0]?.annotations.cause;
      expect(isServerEnvironmentLabelFileError(error)).toBe(true);
      if (isServerEnvironmentLabelFileError(error)) {
        expect(error.operation).toBe("inspect");
        expect(error.path).toBe("/etc/machine-info");
        expect(error.cause).toBe(platformError);
        expect(platformError.cause).toBe(fileCause);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          withHostPlatform(Layer.merge(ProcessRunnerTest, fileSystemLayer), "linux", "buildbox"),
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ),
      ),
    );
  });

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

      const result = yield* ServerEnvironmentLabel.resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
      }).pipe(Effect.provide(withHostPlatform(TestLayer, "linux", "   ")));

      expect(result).toBe("t3code");
    }),
  );
});
