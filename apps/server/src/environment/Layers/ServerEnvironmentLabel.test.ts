import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "vitest";

vi.mock("../../processRunner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../processRunner.ts")>();
  return {
    ...actual,
    runProcess: vi.fn(),
  };
});

import { ProcessSpawnError, runProcess } from "../../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

const mockedRunProcess = vi.mocked(runProcess);
const NoopFileSystemLayer = FileSystem.layerNoop({});
const TestLayer = Layer.merge(NoopFileSystemLayer, NodeServices.layer);
const LinuxMachineInfoLayer = Layer.merge(
  NodeServices.layer,
  FileSystem.layerNoop({
    exists: (path) => Effect.succeed(path === "/etc/machine-info"),
    readFileString: (path) =>
      path === "/etc/machine-info"
        ? Effect.succeed('PRETTY_HOSTNAME="Build Agent 01"\nICON_NAME="computer-vm"\n')
        : Effect.succeed(""),
  }),
);

afterEach(() => {
  mockedRunProcess.mockReset();
});

describe("resolveServerEnvironmentLabel", () => {
  it.effect("uses hostname fallback regardless of launch mode", () =>
    Effect.gen(function* () {
      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "win32",
        hostname: "macbook-pro",
      }).pipe(Effect.provide(TestLayer));

      expect(result).toBe("macbook-pro");
    }),
  );

  it.effect("prefers the macOS ComputerName", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockReturnValueOnce(
        Effect.succeed({
          stdout: " Julius's MacBook Pro \n",
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "darwin",
        hostname: "macbook-pro",
      }).pipe(Effect.provide(TestLayer));

      expect(result).toBe("Julius's MacBook Pro");
      expect(mockedRunProcess).toHaveBeenCalledWith(
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
        platform: "linux",
        hostname: "buildbox",
      }).pipe(Effect.provide(LinuxMachineInfoLayer));

      expect(result).toBe("Build Agent 01");
      expect(mockedRunProcess).not.toHaveBeenCalled();
    }),
  );

  it.effect("falls back to hostnamectl pretty hostname on Linux", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockReturnValueOnce(
        Effect.succeed({
          stdout: "CI Runner\n",
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "linux",
        hostname: "runner-01",
      }).pipe(Effect.provide(TestLayer));

      expect(result).toBe("CI Runner");
      expect(mockedRunProcess).toHaveBeenCalledWith(
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
        platform: "win32",
        hostname: "JULIUS-LAPTOP",
      }).pipe(Effect.provide(TestLayer));

      expect(result).toBe("JULIUS-LAPTOP");
    }),
  );

  it.effect("falls back to the hostname when the friendly-label command is missing", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockReturnValueOnce(
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
        platform: "darwin",
        hostname: "macbook-pro",
      }).pipe(Effect.provide(TestLayer));

      expect(result).toBe("macbook-pro");
    }),
  );

  it.effect("falls back to the cwd basename when the hostname is blank", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockReturnValueOnce(
        Effect.succeed({
          stdout: " ",
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );

      const result = yield* resolveServerEnvironmentLabel({
        cwdBaseName: "t3code",
        platform: "linux",
        hostname: "   ",
      }).pipe(Effect.provide(TestLayer));

      expect(result).toBe("t3code");
    }),
  );
});
