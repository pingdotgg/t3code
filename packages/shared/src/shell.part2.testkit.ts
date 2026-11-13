// @effect-diagnostics nodeBuiltinImport:off -- The synchronous shell probe runs real commands with isolated config files.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { DesktopHostTelemetryMessage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  CommandAvailability,
  type CommandAvailabilityChecker,
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  readEnvironmentFromLoginShell,
  readEnvironmentFromWindowsShell,
  resolveWindowsEnvironment,
  WindowsShellEnvironment,
  type WindowsShellEnvironmentReader,
} from "./shell.ts";

export const decodeDesktopHostMessage = Schema.decodeUnknownSync(DesktopHostTelemetryMessage);

const nativeProbe = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
  original: undefined as unknown as typeof import("node:child_process").execFile,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  nativeProbe.original = original.execFile;
  return { ...original, execFile: nativeProbe.execFile.mockImplementation(original.execFile) };
});

export const withWindowsEnvironmentMocks = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  readEnvironment: (
    ...args: Parameters<WindowsShellEnvironmentReader>
  ) => Partial<Record<string, string>>,
  commandAvailable: CommandAvailabilityChecker,
) =>
  effect.pipe(
    Effect.provideService(WindowsShellEnvironment, (...args) =>
      Effect.sync(() => readEnvironment(...args)),
    ),
    Effect.provideService(CommandAvailability, commandAvailable),
  );

describe("readEnvironmentFromLoginShell", () => {
  // Opt in with an explicit binary, like the provider live probes; CI need not install Nu.
  it.runIf(process.env.T3_TEST_NU_PATH !== undefined)(
    "captures Nushell PATH and multiline values without external tools",
    () => {
      const shell = process.env.T3_TEST_NU_PATH!;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-nu-env-"));
      try {
        const toolPath = NodePath.join(home, "nu tools", "bin");
        const extraToolPath = NodePath.join(home, "extra-tools", "bin");
        NodeFS.mkdirSync(toolPath, { recursive: true });
        NodeFS.mkdirSync(extraToolPath, { recursive: true });
        const config = NodePath.join(home, "config.nu");
        const envConfig = NodePath.join(home, "env.nu");
        NodeFS.writeFileSync(envConfig, "");
        NodeFS.writeFileSync(
          config,
          [
            `$env.PATH = [${JSON.stringify(toolPath)}, "~/extra-tools/bin", "rel/dir", ""]`,
            '$env.CUSTOM_VAR = "  first\\nsecond  "',
            '$env.EMPTY_VAR = ""',
            'print "startup noise"',
          ].join("\n"),
        );

        expect(
          readEnvironmentFromLoginShell(
            shell,
            ["MISSING_VAR", "PATH", "EMPTY_VAR", "CUSTOM_VAR"],
            (file, args, options) =>
              NodeChildProcess.execFileSync(
                file,
                ["--no-history", "--config", config, "--env-config", envConfig, ...args],
                {
                  ...options,
                  env: { HOME: home, XDG_CONFIG_HOME: home, PATH: toolPath },
                },
              ),
          ),
        ).toEqual({
          PATH: `${toolPath}:${extraToolPath}:rel/dir:`,
          CUSTOM_VAR: "  first\nsecond  ",
        });
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith("/bin/zsh", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves multiline values and surrounding whitespace", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_CUSTOM_VAR_START__",
        "  first\nsecond  ",
        "__T3CODE_ENV_CUSTOM_VAR_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  first\nsecond  ",
    });
  });
});

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin", "darwin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });
});

describe("readEnvironmentFromWindowsShell", () => {
  effectIt.effect("yields while the native shell probe is pending", () =>
    Effect.gen(function* () {
      let completed = false;
      const [environment, completedBeforeProbeReturned] = yield* Effect.all(
        [
          readEnvironmentFromWindowsShell(["PATH"]).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
          ),
          Effect.sync(() => completed),
        ],
        { concurrency: 2 },
      );
      expect(completedBeforeProbeReturned).toBe(false);
      expect(environment).toBeTypeOf("object");
    }),
  );

  effectIt.layer(NodeServices.layer)("synchronous spawn failures", (it) => {
    it.effect("tries both shells and preserves baseline PATH repair", () =>
      Effect.gen(function* () {
        const execFile = nativeProbe.execFile;
        execFile.mockImplementationOnce(() => {
          throw new Error("spawn EPERM");
        });
        execFile.mockImplementationOnce(() => {
          throw new Error("spawn EINVAL");
        });
        try {
          const patch = yield* resolveWindowsEnvironment({
            PATH: "C:\\Windows",
            APPDATA: "C:\\Roaming",
          }).pipe(Effect.provideService(CommandAvailability, () => Effect.succeed(true)));
          expect(patch).toEqual({ PATH: "C:\\Windows;C:\\Roaming\\npm" });
          expect(execFile.mock.calls.slice(-2).map(([file]) => file)).toEqual([
            "pwsh.exe",
            "powershell.exe",
          ]);
        } finally {
          execFile.mockClear();
        }
      }),
    );
  });

  effectIt.effect("returns an empty environment after both shell candidates fail", () =>
    Effect.gen(function* () {
      const execFile = vi.fn(() => Effect.succeed(Option.none<string>()));
      expect(yield* readEnvironmentFromWindowsShell(["PATH"], {}, execFile)).toEqual({});
      expect(execFile).toHaveBeenCalledTimes(2);
    }),
  );

  effectIt.effect("does not launch a shell when no variables are requested", () =>
    Effect.gen(function* () {
      const execFile = vi.fn(() => Effect.succeed(Option.none<string>()));
      expect(yield* readEnvironmentFromWindowsShell([], {}, execFile)).toEqual({});
      expect(execFile).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect(
    "kills the native probe child on interruption without trying the next shell",
    () =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>();
        const kill = vi.fn(() => true);
        const child = { kill, unref: vi.fn() } as unknown as ReturnType<
          typeof import("node:child_process").execFile
        >;
        const execFile = nativeProbe.execFile;
        execFile.mockClear();
        execFile.mockImplementationOnce(() => {
          started.resolve();
          return child;
        });
        try {
          const fiber = yield* readEnvironmentFromWindowsShell(["PATH"]).pipe(Effect.forkChild);
          yield* Effect.promise(() => started.promise);
          yield* Fiber.interrupt(fiber);
          expect(kill).toHaveBeenCalledTimes(1);
          expect(execFile).toHaveBeenCalledTimes(1);
          expect(execFile.mock.calls[0]?.[0]).toBe("pwsh.exe");
        } finally {
          execFile.mockClear();
        }
      }),
  );

  effectIt.effect("gives up on a shell that survives the kill and holds stdout open", () =>
    Effect.gen(function* () {
      const stdout = { destroy: vi.fn() };
      const unref = vi.fn();
      const child = { kill: vi.fn(() => true), stdout, unref } as unknown as ReturnType<
        typeof import("node:child_process").execFile
      >;
      const execFile = nativeProbe.execFile;
      execFile.mockClear();
      execFile.mockImplementation(() => child);
      try {
        const fiber = yield* readEnvironmentFromWindowsShell(["PATH"]).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("6 seconds");
        expect(execFile.mock.calls.map(([file]) => file)).toEqual(["pwsh.exe", "powershell.exe"]);
        yield* TestClock.adjust("6 seconds");
        expect(yield* Fiber.join(fiber)).toEqual({});
        expect(stdout.destroy).toHaveBeenCalledTimes(2);
        expect(unref).toHaveBeenCalledTimes(2);
      } finally {
        execFile.mockReset();
        execFile.mockImplementation(nativeProbe.original);
      }
    }),
  );

  effectIt.effect("extracts environment variables from a PowerShell command", () =>
    Effect.gen(function* () {
      const execFile = vi.fn<
        (
          file: string,
          args: ReadonlyArray<string>,
          options: { encoding: "utf8"; timeout: number },
        ) => string
      >(
        () =>
          "__T3CODE_ENV_PATH_START__\nC:\\Users\\testuser\\AppData\\Roaming\\npm\n__T3CODE_ENV_PATH_END__\n",
      );

      expect(
        yield* readEnvironmentFromWindowsShell(["PATH"], {}, (...args) =>
          Effect.try(() => execFile(...args)).pipe(Effect.option),
        ),
      ).toEqual({
        PATH: "C:\\Users\\testuser\\AppData\\Roaming\\npm",
      });
      expect(execFile).toHaveBeenCalledWith(
        "pwsh.exe",
        expect.arrayContaining(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]),
        { encoding: "utf8", timeout: 5000 },
      );
    }),
  );

  effectIt.effect("strips CRLF delimiters from captured PowerShell values", () =>
    Effect.gen(function* () {
      const execFile = vi.fn<
        (
          file: string,
          args: ReadonlyArray<string>,
          options: { encoding: "utf8"; timeout: number },
        ) => string
      >(
        () =>
          "__T3CODE_ENV_FNM_DIR_START__\r\nC:\\Users\\testuser\\AppData\\Roaming\\fnm\r\n__T3CODE_ENV_FNM_DIR_END__\r\n",
      );

      expect(
        yield* readEnvironmentFromWindowsShell(["FNM_DIR"], {}, (...args) =>
          Effect.try(() => execFile(...args)).pipe(Effect.option),
        ),
      ).toEqual({
        FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
      });
    }),
  );

  effectIt.effect("omits -NoProfile when loadProfile is enabled", () =>
    Effect.gen(function* () {
      const execFile = vi.fn<
        (
          file: string,
          args: ReadonlyArray<string>,
          options: { encoding: "utf8"; timeout: number },
        ) => string
      >(() => "__T3CODE_ENV_PATH_START__\nC:\\Tools\n__T3CODE_ENV_PATH_END__\n");

      expect(
        yield* readEnvironmentFromWindowsShell(["PATH"], { loadProfile: true }, (...args) =>
          Effect.try(() => execFile(...args)).pipe(Effect.option),
        ),
      ).toEqual({
        PATH: "C:\\Tools",
      });
      expect(execFile).toHaveBeenCalledWith(
        "pwsh.exe",
        expect.arrayContaining(["-NoLogo", "-NonInteractive", "-Command"]),
        { encoding: "utf8", timeout: 5000 },
      );
      expect(execFile.mock.calls[0]?.[1]).not.toContain("-NoProfile");
    }),
  );

  effectIt.effect("falls back to Windows PowerShell when pwsh.exe is unavailable", () =>
    Effect.gen(function* () {
      const execFile = vi.fn<
        (
          file: string,
          args: ReadonlyArray<string>,
          options: { encoding: "utf8"; timeout: number },
        ) => string
      >((file) => {
        if (file === "pwsh.exe") {
          throw new Error("spawn pwsh.exe ENOENT");
        }
        return "__T3CODE_ENV_PATH_START__\nC:\\Tools\n__T3CODE_ENV_PATH_END__\n";
      });

      expect(
        yield* readEnvironmentFromWindowsShell(["PATH"], {}, (...args) =>
          Effect.try(() => execFile(...args)).pipe(Effect.option),
        ),
      ).toEqual({
        PATH: "C:\\Tools",
      });
      expect(execFile).toHaveBeenNthCalledWith(1, "pwsh.exe", expect.any(Array), {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(execFile).toHaveBeenNthCalledWith(2, "powershell.exe", expect.any(Array), {
        encoding: "utf8",
        timeout: 5000,
      });
    }),
  );
});

describe("mergePathValues", () => {
  it("sanitizes and dedupes Windows entries while preserving preferred order", () => {
    expect(
      mergePathValues(
        'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs"',
        "c:\\users\\testuser\\appdata\\roaming\\npm;C:\\Windows\\System32",
        "win32",
      ),
    ).toBe(
      "C:\\Users\\testuser\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;C:\\Windows\\System32",
    );
  });

  it("removes stray quotes from Windows entries", () => {
    expect(
      mergePathValues(
        'C:\\Windows\\System32;C:\\cloudflared.exe;C:";C:\\Program Files\\nodejs',
        undefined,
        "win32",
      ),
    ).toBe("C:\\Windows\\System32;C:\\cloudflared.exe;C:;C:\\Program Files\\nodejs");
  });

  it("dedupes case-sensitively on POSIX", () => {
    expect(mergePathValues("/usr/local/bin:/usr/bin", "/usr/bin:/USR/BIN", "linux")).toBe(
      "/usr/local/bin:/usr/bin:/USR/BIN",
    );
  });
});
