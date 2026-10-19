import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CommandAvailability,
  CommandResolutionCache,
  type CommandAvailabilityChecker,
  isCommandAvailable,
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  npmShimExecutable,
  preferGitForWindowsBinary,
  readEnvironmentFromLoginShell,
  readEnvironmentFromWindowsShell,
  readPathFromLaunchctl,
  resolveCommandPath,
  resolveKnownWindowsCliDirs,
  resolveSpawnCommand,
  resolveWindowsEnvironment,
  SpawnExecutableResolution,
  type SpawnExecutableResolver,
  WindowsShellEnvironment,
  withPathDirectoryListings,
  type WindowsShellEnvironmentReader,
} from "./shell.ts";

const withWindowsEnvironmentMocks = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  readEnvironment: WindowsShellEnvironmentReader,
  commandAvailable: CommandAvailabilityChecker,
) =>
  effect.pipe(
    Effect.provideService(WindowsShellEnvironment, readEnvironment),
    Effect.provideService(CommandAvailability, commandAvailable),
  );

const recordCommandTrace = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const result = yield* effect.pipe(Effect.withTracer(tracer), Effect.result);
  return { result, spans };
});

describe("readEnvironmentFromLoginShell probe", () => {
  it("uses a shell-agnostic printenv PATH probe", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_ENV_PATH_START__\n/a:/b\n__T3CODE_ENV_PATH_END__\n");

    expect(readEnvironmentFromLoginShell("/opt/homebrew/bin/fish", ["PATH"], execFile).PATH).toBe(
      "/a:/b",
    );
    expect(execFile).toHaveBeenCalledTimes(1);

    const firstCall = execFile.mock.calls[0] as
      | [string, ReadonlyArray<string>, { encoding: "utf8"; timeout: number }]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected execFile to be called");
    }

    const [shell, args, options] = firstCall;
    expect(shell).toBe("/opt/homebrew/bin/fish");
    expect(args).toHaveLength(2);
    expect(args?.[0]).toBe("-ilc");
    expect(args?.[1]).toContain("printenv PATH || true");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_START__");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_END__");
    expect(options).toEqual({ encoding: "utf8", timeout: 5000 });
  });
});

describe("readPathFromLaunchctl", () => {
  it("returns a trimmed PATH value from launchctl", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "  /opt/homebrew/bin:/usr/bin  \n");

    expect(readPathFromLaunchctl(execFile)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(execFile).toHaveBeenCalledWith("/bin/launchctl", ["getenv", "PATH"], {
      encoding: "utf8",
      timeout: 2000,
    });
  });

  it("returns undefined when launchctl is unavailable", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => {
      throw new Error("spawn /bin/launchctl ENOENT");
    });

    expect(readPathFromLaunchctl(execFile)).toBeUndefined();
  });
});

describe("readEnvironmentFromLoginShell", () => {
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

  it("preserves surrounding whitespace in captured values", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      ["__T3CODE_ENV_CUSTOM_VAR_START__", "  padded value  ", "__T3CODE_ENV_CUSTOM_VAR_END__"].join(
        "\n",
      ),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  padded value  ",
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

  it("falls back to the platform default when no shells are available", () => {
    expect(listLoginShellCandidates("linux", undefined, "")).toEqual(["/bin/bash"]);
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin", "darwin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("uses the platform-specific delimiter", () => {
    expect(mergePathEntries("C:\\Tools;C:\\Windows", "C:\\Windows;C:\\Git", "win32")).toBe(
      "C:\\Tools;C:\\Windows;C:\\Git",
    );
  });
});

describe("readEnvironmentFromWindowsShell", () => {
  it("extracts environment variables from a PowerShell command", () => {
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

    expect(readEnvironmentFromWindowsShell(["PATH"], execFile)).toEqual({
      PATH: "C:\\Users\\testuser\\AppData\\Roaming\\npm",
    });
    expect(execFile).toHaveBeenCalledWith(
      "pwsh.exe",
      expect.arrayContaining(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]),
      { encoding: "utf8", timeout: 5000 },
    );
  });

  it("strips CRLF delimiters from captured PowerShell values", () => {
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

    expect(readEnvironmentFromWindowsShell(["FNM_DIR"], execFile)).toEqual({
      FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
    });
  });

  it("omits -NoProfile when loadProfile is enabled", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_ENV_PATH_START__\nC:\\Tools\n__T3CODE_ENV_PATH_END__\n");

    expect(readEnvironmentFromWindowsShell(["PATH"], { loadProfile: true }, execFile)).toEqual({
      PATH: "C:\\Tools",
    });
    expect(execFile).toHaveBeenCalledWith(
      "pwsh.exe",
      expect.arrayContaining(["-NoLogo", "-NonInteractive", "-Command"]),
      { encoding: "utf8", timeout: 5000 },
    );
    expect(execFile.mock.calls[0]?.[1]).not.toContain("-NoProfile");
  });

  it("falls back to Windows PowerShell when pwsh.exe is unavailable", () => {
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

    expect(readEnvironmentFromWindowsShell(["PATH"], execFile)).toEqual({
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
  });
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

describe("resolveKnownWindowsCliDirs", () => {
  it("returns known Windows CLI install directories in priority order", () => {
    expect(
      resolveKnownWindowsCliDirs({
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
        USERPROFILE: "C:\\Users\\testuser",
      }),
    ).toEqual([
      "C:\\Users\\testuser\\AppData\\Roaming\\npm",
      "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
      "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
      "C:\\Users\\testuser\\AppData\\Local\\pnpm",
      "C:\\Users\\testuser\\.local\\bin",
      "C:\\Users\\testuser\\.bun\\bin",
      "C:\\Users\\testuser\\scoop\\shims",
    ]);
  });
});

effectIt.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect.each(["win32", "linux"] as const)(
    "records missing optional commands as successful lookups on %s",
    (platform) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-trace-" });
        const env = { PATH: cwd, PATHEXT: ".CMD" };
        const checks = [
          isCommandAvailable("missing", { env }),
          isCommandAvailable("missing", { env }),
          isCommandAvailable("missing", { env: { ...env, PATH: "" } }),
          isCommandAvailable(path.join(cwd, "missing.cmd"), { env }),
        ];
        for (const check of checks) {
          const { result, spans } = yield* recordCommandTrace(check);
          expect(Result.getOrThrow(result)).toBe(false);
          expect(spans.length).toBeGreaterThan(0);
          for (const span of spans) {
            expect(span.status._tag).toBe("Ended");
            if (span.status._tag === "Ended") {
              expect(Exit.isSuccess(span.status.exit), span.name).toBe(true);
            }
          }
        }
      }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(CommandResolutionCache, new Map()),
      ),
  );

  it.effect.each(["win32", "linux"] as const)(
    "records available commands as successful lookups on %s",
    (platform) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-trace-" });
        const executable = path.join(cwd, platform === "win32" ? "available.cmd" : "available");
        yield* fs.writeFileString(executable, "");
        yield* fs.chmod(executable, 0o700);
        const env = { PATH: cwd, PATHEXT: ".CMD" };
        for (const command of ["available", executable]) {
          const { result, spans } = yield* recordCommandTrace(isCommandAvailable(command, { env }));
          expect(Result.getOrThrow(result)).toBe(true);
          expect(spans.length).toBeGreaterThan(0);
          for (const span of spans) {
            expect(span.status._tag).toBe("Ended");
            if (span.status._tag === "Ended") {
              expect(Exit.isSuccess(span.status.exit), span.name).toBe(true);
            }
          }
        }
      }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(CommandResolutionCache, new Map()),
      ),
  );

  it.effect("returns false when PATH is empty", () =>
    Effect.gen(function* () {
      expect(
        yield* isCommandAvailable("definitely-not-installed", {
          env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
      ).toBe(false);
    }),
  );
});

effectIt.layer(NodeServices.layer)("resolveCommandPath", (it) => {
  it.effect("records a successful lookup when a command is missing", () =>
    Effect.gen(function* () {
      const { result, spans } = yield* recordCommandTrace(
        resolveCommandPath("missing", { env: { PATH: "" } }),
      );
      expect(Result.getOrThrow(result)).toBeNull();
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span.status._tag).toBe("Ended");
        if (span.status._tag === "Ended") {
          expect(Exit.isSuccess(span.status.exit), span.name).toBe(true);
        }
      }
    }),
  );

  it.effect("returns null when PATH is empty", () =>
    Effect.gen(function* () {
      const result = yield* resolveCommandPath("definitely-not-installed", {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));

      expect(result).toBeNull();
    }),
  );

  const recordProbes = (env: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      const probed: Array<string> = [];
      const result = yield* resolveCommandPath("definitely-not-installed", { env }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provide(
          FileSystem.layerNoop({
            stat: (filePath) =>
              Effect.sync(() => {
                probed.push(filePath);
                return { type: "Directory" } as FileSystem.File.Info;
              }),
          }),
        ),
      );

      expect(result).toBeNull();
      return probed;
    });

  it.effect("visits a repeated PATH directory only once", () =>
    Effect.gen(function* () {
      const probed = yield* recordProbes({
        PATH: "C:\\bin;C:\\other;C:\\bin;C:\\other",
        PATHEXT: ".COM;.EXE",
      });

      expect(probed).toHaveLength(8);
      expect(new Set(probed).size).toBe(probed.length);
    }),
  );

  it.effect("still visits a PATH entry that differs only in case", () =>
    Effect.gen(function* () {
      const probed = yield* recordProbes({
        PATH: "C:\\bin;C:\\BIN",
        PATHEXT: ".COM;.EXE",
      });

      // Windows 10+ can mark a directory case-sensitive, so the two spellings
      // are not provably one directory and skipping the second could hide a
      // command that is really there.
      expect(probed).toHaveLength(8);
    }),
  );

  it.effect.each(["audit-command", "audit-command.CMD"])(
    "resolves lowercase executable files for %s in a case-sensitive Windows PATH directory",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-case-sensitive-path-" });
        const executable = path.join(cwd, "audit-command.cmd");
        yield* fs.writeFileString(executable, "@echo off\n");

        const resolved = yield* resolveCommandPath(command, {
          env: { PATH: cwd, PATHEXT: ".CMD" },
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(CommandResolutionCache, new Map()),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (filePath) =>
              fs.stat(filePath === executable ? filePath : path.join(cwd, "missing")),
          }),
        );

        expect(resolved).toBe(executable);
      }),
  );

  it.effect("keeps cached misses until expiry while allowing explicit paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-path-cache-" });
      const executable = path.join(cwd, "appeared.CMD");
      const options = { env: { PATH: `${cwd};${cwd}`, PATHEXT: ".CMD" } };

      expect(yield* resolveCommandPath("appeared", options)).toBeNull();
      yield* fs.writeFileString(executable, "@echo off\n");
      expect(yield* resolveCommandPath("appeared", options)).toBeNull();
      expect(yield* resolveCommandPath(executable, options)).toBe(executable);
      yield* TestClock.adjust("30 seconds");
      expect(yield* resolveCommandPath("appeared", options)).toBe(executable);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(CommandResolutionCache, new Map()),
    ),
  );

  it.effect("keeps upper and lowercase PATHEXT candidates", () =>
    Effect.gen(function* () {
      const probed = yield* recordProbes({
        PATH: "C:\\bin",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });

      expect(probed).toHaveLength(8);
      expect(probed.filter((filePath) => /\.(COM|EXE|BAT|CMD)$/.test(filePath))).toHaveLength(4);
      expect(probed.filter((filePath) => /\.(com|exe|bat|cmd)$/.test(filePath))).toHaveLength(4);
    }),
  );

  it.effect("probes only listed PATH names and relists a directory that changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* fs.makeTempDirectoryScoped();
      const second = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(first, "cursor.CMD"), "");
      yield* fs.writeFileString(path.join(second, "cursor.EXE"), "");
      const env = { PATH: `${first};${second}`, PATHEXT: ".EXE;.CMD" };
      const probed: Array<string> = [];
      yield* Effect.gen(function* () {
        expect(yield* resolveCommandPath("cursor", { env })).toBe(path.join(first, "cursor.CMD"));
        expect(yield* isCommandAvailable("absent", { env })).toBe(false);
        yield* fs.writeFileString(path.join(second, "late.EXE"), "");
        yield* fs.utimes(second, 4_102_444_800, 4_102_444_800);
        expect(yield* resolveCommandPath("late", { env })).toBe(path.join(second, "late.EXE"));
      }).pipe(
        withPathDirectoryListings,
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (file) => {
            if (file !== first && file !== second) probed.push(file);
            return fs.stat(file);
          },
        }),
      );
      expect(probed).toEqual([path.join(first, "cursor.CMD"), path.join(second, "late.EXE")]);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(CommandResolutionCache, new Map()),
    ),
  );
});

describe("preferGitForWindowsBinary", () => {
  const files =
    (...paths: Array<string>) =>
    (filePath: string) =>
      paths.includes(filePath);

  it("runs the git.exe Git for Windows' launcher would start", () => {
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.EXE",
        {},
        files(
          "C:\\Program Files\\Git\\ucrt64\\bin\\git.exe",
          "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
        ),
      ),
    ).toBe("C:\\Program Files\\Git\\ucrt64\\bin\\git.exe");
    expect(
      preferGitForWindowsBinary(
        "D:\\PortableGit\\bin\\git.exe",
        {},
        files("D:\\PortableGit\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("D:\\PortableGit\\mingw64\\bin\\git.exe");
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        {},
        files("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe");
  });

  it("keeps the launcher when MSYSTEM is set", () => {
    // The real git.exe only adds its own folders to PATH when MSYSTEM is unset;
    // without them a `#!/bin/sh` hook cannot start.
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        { MSYSTEM: "MINGW64" },
        files("C:\\Program Files\\Git\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });

  it("keeps the launcher when no git.exe sits beside it", () => {
    expect(preferGitForWindowsBinary("C:\\Program Files\\Git\\cmd\\git.exe", {}, () => false)).toBe(
      "C:\\Program Files\\Git\\cmd\\git.exe",
    );
  });

  it("leaves other gits and other launchers alone", () => {
    const everything = () => true;
    expect(preferGitForWindowsBinary("C:\\Users\\me\\scoop\\shims\\git.exe", {}, everything)).toBe(
      "C:\\Users\\me\\scoop\\shims\\git.exe",
    );
    expect(preferGitForWindowsBinary("C:\\Program Files\\Git\\cmd\\gitk.exe", {}, everything)).toBe(
      "C:\\Program Files\\Git\\cmd\\gitk.exe",
    );
  });
});

// Byte for byte what `npm install -g opencode-ai` writes as `opencode.cmd`.
const NPM_OPENCODE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  "",
].join("\r\n");

describe("npmShimExecutable", () => {
  const shimPath = "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd";
  const executable =
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const exists = (filePath: string) => filePath === executable;

  it("finds the executable npm's shim runs", () => {
    expect(npmShimExecutable(shimPath, () => NPM_OPENCODE_SHIM, exists)).toBe(executable);
    expect(
      npmShimExecutable(shimPath.replace(".cmd", ".CMD"), () => NPM_OPENCODE_SHIM, exists),
    ).toBe(executable);
  });

  it("keeps a shim that does more than run the executable", () => {
    const withSetting = NPM_OPENCODE_SHIM.replace(
      "SETLOCAL",
      "SETLOCAL\r\nSET OPENCODE_CONFIG=C:\\x",
    );
    expect(npmShimExecutable(shimPath, () => withSetting, exists)).toBeUndefined();
    const nodeScript = NPM_OPENCODE_SHIM.replace(
      '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
      '"%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*',
    );
    expect(
      npmShimExecutable(
        shimPath,
        () => nodeScript,
        () => true,
      ),
    ).toBeUndefined();
  });

  it("keeps a shim CMD would read differently", () => {
    // CMD keeps trailing characters in an unquoted `SET` value, so these point
    // `dp0`, and with it the executable, somewhere else.
    for (const suffix of ["\u00a0", "\t", " "]) {
      const altered = NPM_OPENCODE_SHIM.replace("SET dp0=%~dp0", `SET dp0=%~dp0${suffix}`);
      expect(
        npmShimExecutable(
          shimPath,
          () => altered,
          () => true,
        ),
      ).toBeUndefined();
    }
    const nonBreakingSeparator = NPM_OPENCODE_SHIM.replace(
      'opencode.exe"   %*',
      'opencode.exe"\u00a0%*',
    );
    expect(
      npmShimExecutable(
        shimPath,
        () => nonBreakingSeparator,
        () => true,
      ),
    ).toBeUndefined();
    const indented = NPM_OPENCODE_SHIM.replace("SETLOCAL", "  SETLOCAL");
    expect(
      npmShimExecutable(
        shimPath,
        () => indented,
        () => true,
      ),
    ).toBeUndefined();
  });

  it("keeps the shim when its executable is missing or it is not a .cmd", () => {
    expect(
      npmShimExecutable(
        shimPath,
        () => NPM_OPENCODE_SHIM,
        () => false,
      ),
    ).toBeUndefined();
    expect(
      npmShimExecutable(
        shimPath,
        () => undefined,
        () => true,
      ),
    ).toBeUndefined();
    expect(
      npmShimExecutable(
        shimPath.replace(".cmd", ".bat"),
        () => NPM_OPENCODE_SHIM,
        () => true,
      ),
    ).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("resolveSpawnCommand", (it) => {
  it.effect("runs Windows executables directly without a shell", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("node.exe", ["script.js", "hello & goodbye"], {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
      );

      expect(command).toEqual({
        command: "node.exe",
        args: ["script.js", "hello & goodbye"],
        shell: false,
      });
    }),
  );

  it.effect.runIf(HostProcess.Platform.defaultValue() === "win32")(
    "runs the executable behind an npm shim directly when asked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const prefix = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-shim-" });
          const shim = path.join(prefix, "opencode.cmd");
          const executable = path.join(
            prefix,
            "node_modules",
            "opencode-ai",
            "bin",
            "opencode.exe",
          );
          yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
          yield* fs.writeFileString(executable, "");
          yield* fs.writeFileString(shim, NPM_OPENCODE_SHIM);
          const resolve = (bypassNpmShim: boolean) =>
            resolveSpawnCommand("opencode", ["serve", "--port=4096"], {
              env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
              bypassNpmShim,
            }).pipe(
              Effect.provideService(HostProcess.Platform, "win32"),
              Effect.provideService(CommandResolutionCache, new Map()),
              Effect.provideService(SpawnExecutableResolution, () => shim),
            );

          expect(yield* resolve(true)).toEqual({
            command: executable,
            args: ["serve", "--port=4096"],
            shell: false,
          });
          expect((yield* resolve(false)).shell).toBe(true);
        }),
      ),
  );

  it.effect("builds one escaped cmd.exe line for Windows command shims", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand(
        "vp",
        [
          "run",
          "value & calc",
          "%PATH%",
          'quote"value',
          "C:\\dir with space\\",
          'slash\\"quote',
          "x|y<z>^",
        ],
        { env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" } },
      ).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(
          SpawnExecutableResolution,
          () => "C:\\Program Files\\npm & tools\\vp.cmd",
        ),
      );

      // No args alongside `shell: true`: Node prints DEP0190 for that pairing.
      expect(command).toEqual({
        command: [
          String.raw`^"C:\Program^ Files\npm^ ^&^ tools\vp.cmd^"`,
          String.raw`^"run^"`,
          String.raw`^"value^ ^&^ calc^"`,
          String.raw`^"^%PATH^%^"`,
          String.raw`^"quote\^"value^"`,
          String.raw`^"C:\dir^ with^ space\\^"`,
          String.raw`^"slash\\\^"quote^"`,
          String.raw`^"x^|y^<z^>^^^"`,
        ].join(" "),
        args: [],
        shell: true,
      });
    }),
  );

  it.effect("resolves against the effective environment when extending host env", () =>
    Effect.gen(function* () {
      let resolvedEnvironment: NodeJS.ProcessEnv | undefined;
      yield* resolveSpawnCommand("codex", ["app-server"], {
        env: { CODEX_HOME: "C:\\Users\\tester\\.codex" },
        extendEnv: true,
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(HostProcess.Environment, {
          PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        }),
        Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) => {
          resolvedEnvironment = env;
          return "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd";
        }),
      );

      expect(resolvedEnvironment).toEqual({
        PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        CODEX_HOME: "C:\\Users\\tester\\.codex",
      });
    }),
  );

  it.effect("scans PATH once per command until the search environment changes", () =>
    Effect.gen(function* () {
      const scans: Array<string> = [];
      const scan: SpawnExecutableResolver = (name, _platform, env) => {
        scans.push(`${name}@${env.PATH}`);
        return name === "missing" ? undefined : `${env.PATH}\\${name}.exe`;
      };
      const resolve = (command: string, path: string, resolver = scan) =>
        resolveSpawnCommand(command, [], { env: { PATH: path, PATHEXT: ".EXE" } }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, resolver),
        );

      expect((yield* resolve("git", "C:\\one")).command).toBe("C:\\one\\git.exe");
      expect((yield* resolve("git", "C:\\one")).command).toBe("C:\\one\\git.exe");
      yield* resolve("missing", "C:\\one");
      yield* resolve("missing", "C:\\one");
      expect((yield* resolve("git", "C:\\two")).command).toBe("C:\\two\\git.exe");
      yield* resolve("C:\\tools\\git.exe", "C:\\one");
      yield* resolve("C:\\tools\\git.exe", "C:\\one");
      expect(scans).toEqual([
        "git@C:\\one",
        "missing@C:\\one",
        "missing@C:\\one",
        "git@C:\\two",
        "C:\\tools\\git.exe@C:\\one",
        "C:\\tools\\git.exe@C:\\one",
      ]);

      yield* TestClock.adjust("31 seconds");
      yield* resolve("git", "C:\\one");
      expect(scans).toHaveLength(7);

      const elsewhere = yield* resolve("git", "C:\\one", () => "D:\\elsewhere\\git.exe");
      expect(elsewhere.command).toBe("D:\\elsewhere\\git.exe");
      expect((yield* resolve("git", "C:\\one")).command).toBe("C:\\one\\git.exe");
      expect(scans).toHaveLength(7);
    }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
  );

  it.effect("keeps launcher swaps apart for environments with and without MSYSTEM", () =>
    Effect.gen(function* () {
      let scans = 0;
      const scan: SpawnExecutableResolver = () => {
        scans++;
        return "C:\\Git\\cmd\\git.exe";
      };
      const resolve = (env: NodeJS.ProcessEnv) =>
        resolveSpawnCommand("git", [], {
          env: { PATH: "C:\\Git\\cmd", PATHEXT: ".EXE", ...env },
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, scan),
        );

      yield* resolve({});
      yield* resolve({});
      expect(scans).toBe(1);
      yield* resolve({ MSYSTEM: "MINGW64" });
      expect(scans).toBe(2);
    }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
  );

  it.effect("does not fall back to a shell for unresolved Windows commands", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("missing & calc", ["unsafe & value"], {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
      );

      expect(command).toEqual({
        command: "missing & calc",
        args: ["unsafe & value"],
        shell: false,
      });
    }),
  );
});

effectIt.layer(NodeServices.layer)("resolveWindowsEnvironment", (it) => {
  it.effect("uses known CLI directories as a fallback without changing shell PATH priority", () =>
    Effect.gen(function* () {
      const readEnvironment = vi.fn(
        (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
          options?.loadProfile
            ? { PATH: "C:\\Profile\\Bin" }
            : { PATH: "C:\\Shell\\Bin;C:\\Windows\\System32" },
      );
      const commandAvailable = vi.fn(() => Effect.succeed(true));

      expect(
        yield* withWindowsEnvironmentMocks(
          resolveWindowsEnvironment({
            PATH: "C:\\Windows\\System32",
            APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
            LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
            USERPROFILE: "C:\\Users\\testuser",
          }),
          readEnvironment,
          commandAvailable,
        ),
      ).toEqual({
        PATH: [
          "C:\\Shell\\Bin",
          "C:\\Windows\\System32",
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.local\\bin",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
        ].join(";"),
      });
      expect(readEnvironment).toHaveBeenCalledTimes(1);
      expect(readEnvironment).toHaveBeenCalledWith(["PATH"], { loadProfile: false });
      expect(commandAvailable).toHaveBeenCalledWith(
        "node",
        expect.objectContaining({ env: expect.any(Object) }),
      );
    }),
  );

  it.effect(
    "probes node with one PATH key when inherited environment records have mixed casing",
    () =>
      Effect.gen(function* () {
        const probedEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];

        yield* withWindowsEnvironmentMocks(
          resolveWindowsEnvironment({ Path: "C:\\Stale", PATH: "C:\\Windows\\System32" }),
          () => ({ PATH: "C:\\Shell\\Bin" }),
          (_command, options) =>
            Effect.sync(() => {
              probedEnvironments.push(options?.env);
              return true;
            }),
        );

        const pathEntries = Object.entries(probedEnvironments[0] ?? {}).filter(
          ([key]) => key.toUpperCase() === "PATH",
        );
        expect(pathEntries).toEqual([["PATH", "C:\\Shell\\Bin;C:\\Windows\\System32"]]);
      }),
  );

  it.effect("loads the PowerShell profile when baseline env cannot resolve node", () =>
    Effect.gen(function* () {
      const readEnvironment = vi.fn(
        (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
          options?.loadProfile
            ? {
                PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
                FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
                FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
              }
            : { PATH: "C:\\Shell\\Bin;C:\\Windows\\System32" },
      );
      const commandAvailable = vi.fn(() => Effect.succeed(false));

      expect(
        yield* withWindowsEnvironmentMocks(
          resolveWindowsEnvironment({
            PATH: "C:\\Windows\\System32",
            APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
            LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
            USERPROFILE: "C:\\Users\\testuser",
          }),
          readEnvironment,
          commandAvailable,
        ),
      ).toEqual({
        PATH: [
          "C:\\Profile\\Node",
          "C:\\Windows\\System32",
          "C:\\Shell\\Bin",
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.local\\bin",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
        ].join(";"),
        FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
        FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
      });
      expect(readEnvironment).toHaveBeenNthCalledWith(1, ["PATH"], { loadProfile: false });
      expect(readEnvironment).toHaveBeenNthCalledWith(
        2,
        ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"],
        {
          loadProfile: true,
        },
      );
      expect(commandAvailable).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("keeps the baseline env when profiled probe still does not resolve node", () =>
    Effect.gen(function* () {
      const readEnvironment = vi.fn(
        (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
          options?.loadProfile ? { FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm" } : {},
      );
      const commandAvailable = vi.fn(() => Effect.succeed(false));

      expect(
        yield* withWindowsEnvironmentMocks(
          resolveWindowsEnvironment({
            PATH: "C:\\Windows\\System32",
            APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
            USERPROFILE: "C:\\Users\\testuser",
          }),
          readEnvironment,
          commandAvailable,
        ),
      ).toEqual({
        PATH: [
          "C:\\Windows\\System32",
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\.local\\bin",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
        ].join(";"),
        FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
      });
      expect(commandAvailable).toHaveBeenCalledTimes(1);
    }),
  );
});
