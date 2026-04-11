import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  PlatformError,
  Scope,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  make as makeDesktopLauncher,
  type DetachedSpawnInput,
  type LaunchRuntimeOptions,
} from "./DesktopLauncher";
import { DesktopLauncher, DesktopLauncherSpawnError } from "../Services/DesktopLauncher";

const encoder = new TextEncoder();

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly detached?: boolean | undefined;
  readonly shell?: boolean | string | undefined;
  readonly windowsVerbatimArguments?: boolean | undefined;
  readonly windowsHide?: boolean | undefined;
  readonly stdin?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

function decodePowerShellCommand(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf16le");
}

function platformSpawnError(message: string) {
  return PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "spawn",
    description: message,
  });
}

function spawnerLayer(
  calls: Array<SpawnCall>,
  handler: (call: SpawnCall) => {
    readonly code?: number;
    readonly fail?: string;
    readonly awaitExit?: Deferred.Deferred<void>;
    readonly onKill?: () => void;
  } = () => ({
    code: 0,
  }),
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const standardCommand = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: {
          readonly detached?: boolean;
          readonly shell?: boolean | string;
          readonly stdin?: unknown;
          readonly stdout?: unknown;
          readonly stderr?: unknown;
        };
      };

      const call: SpawnCall = {
        command: standardCommand.command,
        args: [...standardCommand.args],
        detached: standardCommand.options.detached,
        shell: standardCommand.options.shell,
        stdin: standardCommand.options.stdin,
        stdout: standardCommand.options.stdout,
        stderr: standardCommand.options.stderr,
      };
      calls.push(call);

      const result = handler(call);
      if (result.fail) {
        return Effect.fail(platformSpawnError(result.fail));
      }

      let exited = false;
      const exitCode = result.awaitExit
        ? Deferred.await(result.awaitExit).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                exited = true;
              }),
            ),
            Effect.andThen(Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0))),
          )
        : Effect.sync(() => {
            exited = true;
            return ChildProcessSpawner.ExitCode(result.code ?? 0);
          });

      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(calls.length),
          exitCode,
          isRunning: Effect.succeed(false),
          kill: () =>
            Effect.sync(() => {
              if (!exited) {
                result.onKill?.();
              }
            }),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("")),
          stderr: Stream.make(encoder.encode("")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
}

function spawnHarness(
  calls: Array<SpawnCall>,
  handler: (call: SpawnCall) => {
    readonly code?: number;
    readonly fail?: string;
    readonly awaitExit?: Deferred.Deferred<void>;
    readonly onKill?: () => void;
  } = () => ({
    code: 0,
  }),
) {
  return {
    layer: spawnerLayer(calls, handler),
    spawnDetached: (
      input: DetachedSpawnInput,
      context: {
        readonly operation: string;
        readonly target?: string;
        readonly editor?: string;
      },
    ) => {
      const call: SpawnCall = {
        command: input.command,
        args: [...input.args],
        detached: input.detached,
        shell: input.shell,
        windowsVerbatimArguments: input.windowsVerbatimArguments,
        windowsHide: input.windowsHide,
        stdin: input.stdin,
        stdout: input.stdout,
        stderr: input.stderr,
      };
      calls.push(call);

      const result = handler(call);
      return result.fail
        ? Effect.fail(
            new DesktopLauncherSpawnError({
              operation: context.operation,
              command: input.command,
              args: [...input.args],
              ...(context.target !== undefined ? { target: context.target } : {}),
              ...(context.editor !== undefined ? { editor: context.editor } : {}),
            }),
          )
        : Effect.void;
    },
  } as const;
}

const provideOpen = (
  options: LaunchRuntimeOptions,
  harness: {
    readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
    readonly spawnDetached: (
      input: DetachedSpawnInput,
      context: {
        readonly operation: string;
        readonly target?: string;
        readonly editor?: string;
      },
    ) => Effect.Effect<void, DesktopLauncherSpawnError>;
  },
) =>
  Layer.effect(
    DesktopLauncher,
    makeDesktopLauncher({ ...options, spawnDetached: harness.spawnDetached }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, harness.layer)));

const runOpen = <A>(
  options: LaunchRuntimeOptions,
  harness: {
    readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
    readonly spawnDetached: (
      input: DetachedSpawnInput,
      context: {
        readonly operation: string;
        readonly target?: string;
        readonly editor?: string;
      },
    ) => Effect.Effect<void, DesktopLauncherSpawnError>;
  },
  effect: Effect.Effect<A, never, DesktopLauncher>,
) => effect.pipe(Effect.provide(provideOpen(options, harness)));

const readOpen = Effect.service(DesktopLauncher);

const writeExecutable = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(filePath, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(filePath, 0o755);
  });

it.effect("getAvailableEditors detects installed editors through the service", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-editors-" });
    yield* fs.writeFileString(`${dir}/code-insiders.CMD`, "@echo off\r\n");
    yield* fs.writeFileString(`${dir}/codium.CMD`, "@echo off\r\n");
    yield* fs.writeFileString(`${dir}/explorer.CMD`, "@echo off\r\n");

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "win32",
        env: {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      },
      spawnHarness(calls),
      readOpen,
    );

    const editors = yield* open.getAvailableEditors;
    assert.deepEqual(editors, ["vscode-insiders", "vscodium", "file-manager"]);
    assert.deepEqual(calls, []);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("getAvailableEditors does not advertise WSL file-manager from PowerShell alone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-wsl-editors-" });
    yield* fs.makeDirectory(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`, {
      recursive: true,
    });
    yield* writeExecutable(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`);

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "linux",
        env: {
          PATH: `${dir}:${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`,
          WSL_DISTRO_NAME: "Ubuntu",
        },
        isWsl: true,
        isInsideContainer: false,
        powerShellCommand: `${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`,
      },
      spawnHarness(calls),
      readOpen,
    );

    const editors = yield* open.getAvailableEditors;
    assert.equal(editors.includes("file-manager"), false);
    assert.deepEqual(calls, []);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openInEditor uses --goto for editors that support it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-cursor-" });
    yield* writeExecutable(`${dir}/cursor`);

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "darwin",
        env: { PATH: dir },
      },
      spawnHarness(calls),
      readOpen,
    );

    yield* open.openInEditor({
      cwd: "/tmp/workspace/src/open.ts:71:5",
      editor: "cursor",
    });

    assert.deepEqual(calls, [
      {
        command: `${dir}/cursor`,
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
        detached: true,
        shell: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    ]);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openInEditor uses explorer with a VS Code protocol target on Windows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-vscode-win32-" });
    yield* fs.writeFileString(`${dir}/explorer.exe`, "MZ");

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "win32",
        env: {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      },
      spawnHarness(calls),
      readOpen,
    );

    yield* open.openInEditor({
      cwd: "C:\\work\\100% real\\file.ts:12:4",
      editor: "vscode",
    });

    assert.deepEqual(calls, [
      {
        command: `${dir}/explorer.exe`,
        args: ["vscode://file/C:/work/100%25%20real/file.ts:12:4"],
        detached: true,
        shell: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    ]);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openInEditor detached launches bypass the scoped child-process spawner", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-zed-detached-" });
    yield* writeExecutable(`${dir}/zed`);

    const calls: Array<SpawnCall> = [];
    const harness = spawnHarness(calls);

    yield* Effect.acquireUseRelease(
      Scope.make("sequential"),
      (scope) =>
        Effect.gen(function* () {
          const runtimeServices = yield* Layer.build(
            provideOpen(
              {
                platform: "darwin",
                env: { PATH: dir },
              },
              harness,
            ),
          ).pipe(Scope.provide(scope));

          const open = yield* readOpen.pipe(Effect.provide(runtimeServices), Scope.provide(scope));
          yield* open.openInEditor({
            cwd: "/tmp/workspace",
            editor: "zed",
          });
        }),
      (scope) => Scope.close(scope, Exit.void),
    );

    assert.deepEqual(calls, [
      {
        command: `${dir}/zed`,
        args: ["/tmp/workspace"],
        detached: true,
        shell: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    ]);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openInEditor uses the default opener for file-manager on macOS", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-macos-" });
    yield* writeExecutable(`${dir}/open`);

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "darwin",
        env: { PATH: dir },
      },
      spawnHarness(calls),
      readOpen,
    );

    yield* open.openInEditor({
      cwd: "/tmp/workspace",
      editor: "file-manager",
    });

    assert.deepEqual(calls, [
      {
        command: `${dir}/open`,
        args: ["/tmp/workspace"],
        detached: undefined,
        shell: false,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
      },
    ]);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openBrowser uses macOS open flags and app arguments", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-browser-macos-" });
    yield* writeExecutable(`${dir}/open`);

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "darwin",
        env: { PATH: dir },
      },
      spawnHarness(calls),
      readOpen,
    );

    yield* open.openBrowser("https://example.com", {
      wait: true,
      background: true,
      newInstance: true,
      app: {
        name: "google chrome",
        arguments: ["--profile-directory=Work"],
      },
    });

    assert.deepEqual(calls, [
      {
        command: `${dir}/open`,
        args: [
          "--wait-apps",
          "--background",
          "--new",
          "-a",
          "google chrome",
          "https://example.com",
          "--args",
          "--profile-directory=Work",
        ],
        detached: undefined,
        shell: false,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
      },
    ]);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openBrowser uses PowerShell on win32", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-browser-win32-" });
    yield* fs.writeFileString(`${dir}/powershell.exe`, "MZ");

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "win32",
        env: {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      },
      spawnHarness(calls),
      readOpen,
    );

    yield* open.openBrowser("https://example.com");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, `${dir}/powershell.exe`);
    assert.equal(calls[0]?.args.at(-2), "-EncodedCommand");
    assert.equal(
      decodePowerShellCommand(calls[0]?.args.at(-1) ?? ""),
      "Start 'https://example.com'",
    );
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openBrowser detaches direct app launches on win32 when not waiting", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-browser-win32-app-" });
    yield* fs.writeFileString(`${dir}/chrome.exe`, "MZ");

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "win32",
        env: {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      },
      spawnHarness(calls),
      readOpen,
    );

    yield* open.openBrowser("https://example.com", {
      app: {
        name: "chrome",
        arguments: ["--profile-directory=Work"],
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command.toLowerCase(), `${dir}/chrome.exe`.toLowerCase());
    assert.deepEqual(calls[0]?.args, ["--profile-directory=Work", "https://example.com"]);
    assert.equal(calls[0]?.detached, true);
    assert.equal(calls[0]?.shell, false);
    assert.equal(calls[0]?.stdin, "ignore");
    assert.equal(calls[0]?.stdout, "ignore");
    assert.equal(calls[0]?.stderr, "ignore");
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openBrowser preserves non-zero exit errors for waited direct app launches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-browser-linux-app-wait-" });
    yield* writeExecutable(`${dir}/firefox`);

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "linux",
        env: { PATH: dir },
      },
      spawnHarness(calls, () => ({ code: 23 })),
      readOpen,
    );

    const error = yield* open
      .openBrowser("https://example.com", {
        wait: true,
        app: { name: "firefox" },
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "DesktopLauncherNonZeroExitError");
    if (error._tag !== "DesktopLauncherNonZeroExitError") {
      throw new Error(`Unexpected error tag: ${error._tag}`);
    }
    assert.equal(error.exitCode, 23);
    assert.equal(error.command, `${dir}/firefox`);
    assert.deepEqual(error.args, ["https://example.com"]);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openBrowser falls back from WSL PowerShell to xdg-open", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-browser-wsl-" });
    yield* fs.makeDirectory(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`, {
      recursive: true,
    });
    yield* writeExecutable(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`);
    yield* writeExecutable(`${dir}/xdg-open`);

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "linux",
        env: {
          PATH: `${dir}:${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`,
          WSL_DISTRO_NAME: "Ubuntu",
        },
        isWsl: true,
        isInsideContainer: false,
        powerShellCommand: `${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`,
      },
      spawnHarness(calls, (call) =>
        call.command.includes("powershell")
          ? { fail: "powershell unavailable" }
          : {
              code: 0,
            },
      ),
      readOpen,
    );

    yield* open.openBrowser("https://example.com");

    assert.equal(calls[0]?.command.includes("powershell"), true);
    assert.equal(calls[1]?.command, `${dir}/xdg-open`);
    assert.deepEqual(calls[1]?.args, ["https://example.com"]);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openBrowser skips WSL PowerShell when process env marks a container", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-browser-wsl-container-" });
    yield* fs.makeDirectory(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`, {
      recursive: true,
    });
    yield* writeExecutable(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`);
    yield* writeExecutable(`${dir}/xdg-open`);

    const calls: Array<SpawnCall> = [];
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string | undefined) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }

      if (value === undefined) {
        delete process.env[key];
        return;
      }

      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    try {
      setEnv("PATH", `${dir}:${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`);
      setEnv("WSL_DISTRO_NAME", "Ubuntu");
      setEnv("CONTAINER", "docker");

      const open = yield* runOpen(
        {
          platform: "linux",
          isWsl: true,
          powerShellCommand: `${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`,
        },
        spawnHarness(calls),
        readOpen,
      );

      yield* open.openBrowser("https://example.com");
    } finally {
      restoreEnv();
    }

    assert.deepEqual(calls, [
      {
        command: `${dir}/xdg-open`,
        args: ["https://example.com"],
        detached: true,
        shell: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    ]);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openInEditor uses xdg-open first for WSL file-manager paths", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-wsl-file-manager-" });
    yield* fs.makeDirectory(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`, {
      recursive: true,
    });
    yield* writeExecutable(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`);
    yield* writeExecutable(`${dir}/xdg-open`);

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "linux",
        env: {
          PATH: `${dir}:${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`,
          WSL_DISTRO_NAME: "Ubuntu",
        },
        isWsl: true,
        isInsideContainer: false,
        powerShellCommand: `${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`,
      },
      spawnHarness(calls),
      readOpen,
    );

    yield* open.openInEditor({
      cwd: "/home/julius/workspace",
      editor: "file-manager",
    });

    assert.deepEqual(calls, [
      {
        command: `${dir}/xdg-open`,
        args: ["/home/julius/workspace"],
        detached: true,
        shell: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    ]);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("openInEditor fails when the editor command is unavailable", () =>
  Effect.gen(function* () {
    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "darwin",
        env: { PATH: "" },
      },
      spawnHarness(calls),
      readOpen,
    );

    const error = yield* open
      .openInEditor({
        cwd: "/tmp/workspace",
        editor: "cursor",
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "DesktopLauncherCommandNotFoundError");
    assert.equal(
      error.message,
      "Desktop launcher command not found in openInEditor: cursor for editor cursor",
    );
    assert.deepEqual(calls, []);
  }),
);

it.effect("openBrowser rejects an empty target with a validation error", () =>
  Effect.gen(function* () {
    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "darwin",
        env: { PATH: "" },
      },
      spawnHarness(calls),
      readOpen,
    );

    const error = yield* open.openBrowser("   ").pipe(Effect.flip);

    assert.equal(error._tag, "DesktopLauncherValidationError");
    assert.equal(
      error.message,
      "Desktop launcher validation failed in openBrowser: target must not be empty",
    );
    assert.deepEqual(calls, []);
  }),
);

it.effect("openBrowser reports exhausted fallback attempts when multiple launchers fail", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-browser-fallback-errors-" });
    yield* fs.makeDirectory(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`, {
      recursive: true,
    });
    yield* writeExecutable(`${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`);
    yield* writeExecutable(`${dir}/xdg-open`);

    const calls: Array<SpawnCall> = [];
    const open = yield* runOpen(
      {
        platform: "linux",
        env: {
          PATH: `${dir}:${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0`,
          WSL_DISTRO_NAME: "Ubuntu",
        },
        isWsl: true,
        isInsideContainer: false,
        powerShellCommand: `${dir}/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`,
      },
      spawnHarness(calls, () => ({ fail: "launcher unavailable" })),
      readOpen,
    );

    const error = yield* open.openBrowser("https://example.com").pipe(Effect.flip);
    assert.equal(error._tag, "DesktopLauncherLaunchAttemptsExhaustedError");
    if (error._tag !== "DesktopLauncherLaunchAttemptsExhaustedError") {
      throw new Error(`Unexpected error tag: ${error._tag}`);
    }
    assert.deepEqual(
      error.attempts.map((attempt) => attempt.reason),
      ["spawnFailed", "spawnFailed"],
    );
    assert.deepEqual(
      error.attempts.map((attempt) => attempt.command.includes("powershell")),
      [true, false],
    );
    assert.deepEqual(
      calls.map((call) => call.command.includes("powershell")),
      [true, false],
    );
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);
