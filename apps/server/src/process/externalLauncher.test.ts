// @effect-diagnostics nodeBuiltinImport:off - the Windows launch smoke tests use filesystem notifications to observe real PowerShell launches.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as ExternalLauncher from "./externalLauncher.ts";

// Tests below write `#!/bin/sh` stubs into a real temp dir and hand that
// directory to a posix-mocked resolver as PATH. On a Windows host the temp
// path carries a drive letter, so the posix `:` split shatters it; there is
// no posix executable to find there anyway.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

interface MockSpawnResult {
  readonly spawnError?: PlatformError.PlatformError;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stall?: boolean;
}

function makeMockDetachedHandle(input: MockSpawnResult & { readonly onUnref?: () => void } = {}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.stall
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      input.onUnref?.();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout:
      input.stdout === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(input.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const layerTest = (input: {
  readonly platform: NodeJS.Platform;
  readonly env?: Record<string, string>;
  readonly resolveExecutable?: (command: string) => string | undefined;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onUnref?: () => void;
  readonly spawnResult?: (command: ChildProcess.StandardCommand) => MockSpawnResult | undefined;
}) => {
  const layerSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        input.onSpawn?.(command);
        const result = input.spawnResult?.(command);
        if (result?.spawnError) return yield* result.spawnError;
        return makeMockDetachedHandle({
          ...(input.onUnref === undefined ? {} : { onUnref: input.onUnref }),
          ...result,
        });
      }),
    ),
  );

  return Layer.mergeAll(
    ExternalLauncher.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, layerSpawner))),
    Layer.succeed(HostProcess.Platform, input.platform),
    Layer.succeed(
      SpawnExecutableResolution,
      (command) => input.resolveExecutable?.(command) ?? command,
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
  );
};

it.effect("launches the default browser through the platform command", () => {
  let spawned: ChildProcess.StandardCommand | undefined;
  let didUnref = false;
  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    yield* launcher.launchBrowser("https://example.com/some path");

    assert.ok(spawned);
    assert.equal(spawned.command, "xdg-open");
    assert.deepEqual(spawned.args, ["https://example.com/some path"]);
    assert.equal(spawned.options.detached, true);
    assert.equal(didUnref, true);
  }).pipe(
    Effect.provide(
      layerTest({
        platform: "linux",
        onSpawn: (command) => {
          spawned = command;
        },
        onUnref: () => {
          didUnref = true;
        },
      }),
    ),
  );
});

it.effect.skipIf(windowsHost)(
  "launched browsers and editors do not inherit ELECTRON_RUN_AS_NODE",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      const codePath = path.join(binDir, "code");
      yield* fileSystem.writeFileString(codePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(codePath, 0o755);

      const spawned: ChildProcess.StandardCommand[] = [];
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchBrowser("https://example.com");
        yield* launcher.launchEditor({ editor: "vscode", cwd: "/workspace" });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: { PATH: binDir, DISPLAY: ":0" },
            onSpawn: (command) => spawned.push(command),
          }),
        ),
        Effect.provideService(HostProcess.Environment, {
          PATH: binDir,
          DISPLAY: ":0",
          ELECTRON_RUN_AS_NODE: "1",
        }),
      );

      assert.deepEqual(
        spawned.map((command) => ({
          command: command.command,
          env: command.options.env,
          extendEnv: command.options.extendEnv,
        })),
        ["xdg-open", "code"].map((command) => ({
          command,
          env: { PATH: binDir, DISPLAY: ":0" },
          extendEnv: false,
        })),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["win32", "linux"] as const)(
  "launches the browser through PowerShell on %s",
  (platform) => {
    let spawned: ChildProcess.StandardCommand | undefined;
    return Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      yield* launcher.launchBrowser("https://example.com/some path");

      assert.ok(spawned);
      assert.equal(
        spawned.command,
        platform === "win32"
          ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
          : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      assert.deepEqual(spawned.args.slice(0, -1), [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
      ]);
      const encodedCommand = spawned.args[spawned.args.length - 1] ?? "";
      const decodedCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
      assert.equal(
        decodedCommand,
        "$ProgressPreference = 'SilentlyContinue'; Start 'https://example.com/some path'",
      );
      assert.equal(spawned.options.detached, platform !== "win32");
    }).pipe(
      Effect.provide(
        layerTest({
          platform,
          env: { SYSTEMROOT: "C:\\Windows", WSL_DISTRO_NAME: "Ubuntu" },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );
  },
);

it.effect("launches an installed editor with platform-safe arguments", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "code.CMD"), "@echo off\r\n");

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "vscode",
        cwd: "C:\\workspace with spaces\\src\\index.ts:12:4",
      });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          resolveExecutable: (command) =>
            command === "code" ? "C:\\Program Files\\Microsoft VS Code\\bin\\code.CMD" : command,
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(
      spawned.command,
      [
        '^"C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.CMD^"',
        '^"--goto^"',
        '^"C:\\workspace^ with^ spaces\\src\\index.ts:12:4^"',
      ].join(" "),
    );
    assert.deepEqual(spawned.args, []);
    assert.equal(spawned.options.shell, true);
    assert.equal(spawned.options.detached, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const platform of ["darwin", "linux"] as const) {
  it.effect.skipIf(windowsHost)(`launches Cursor in classic IDE mode on ${platform}`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      const cursorPath = path.join(binDir, "cursor");
      yield* fileSystem.writeFileString(cursorPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(cursorPath, 0o755);

      const spawned: ChildProcess.StandardCommand[] = [];
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        for (const cwd of [
          "/workspace with spaces",
          "/workspace with spaces/src/index.ts",
          "/workspace with spaces/src/index.ts:12",
          "/workspace with spaces/src/index.ts:12:4",
        ]) {
          yield* launcher.launchEditor({ editor: "cursor", cwd });
        }
      }).pipe(
        Effect.provide(
          layerTest({
            platform,
            env: { PATH: binDir },
            onSpawn: (command) => spawned.push(command),
          }),
        ),
      );

      assert.deepEqual(
        spawned.map((command) => ({ command: command.command, args: command.args })),
        [
          { command: "cursor", args: ["--classic", "/workspace with spaces"] },
          { command: "cursor", args: ["--classic", "/workspace with spaces/src/index.ts"] },
          {
            command: "cursor",
            args: ["--classic", "--goto", "/workspace with spaces/src/index.ts:12"],
          },
          {
            command: "cursor",
            args: ["--classic", "--goto", "/workspace with spaces/src/index.ts:12:4"],
          },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("launches Cursor in classic IDE mode through the Windows command shim", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "cursor.CMD"), "@echo off\r\n");

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "cursor",
        cwd: "C:\\workspace with spaces\\src\\index.ts:12:4",
      });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          resolveExecutable: (command) =>
            command === "cursor" ? "C:\\Program Files\\Cursor\\bin\\cursor.CMD" : command,
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(
      spawned.command,
      [
        '^"C:\\Program^ Files\\Cursor\\bin\\cursor.CMD^"',
        '^"--classic^"',
        '^"--goto^"',
        '^"C:\\workspace^ with^ spaces\\src\\index.ts:12:4^"',
      ].join(" "),
    );
    assert.deepEqual(spawned.args, []);
    assert.equal(spawned.options.shell, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("opens a folder in File Explorer with Windows separators", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.EXE"), "");

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({ editor: "file-manager", cwd: "C:/workspace/project" });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.deepEqual(spawned.args, ["C:\\workspace\\project"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)("reveals a file in Finder with open -R on macOS", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const openPath = path.join(binDir, "open");
    yield* fileSystem.writeFileString(openPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(openPath, 0o755);

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "/workspace/media/linux-mini-v2.mp4",
        reveal: true,
      });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { PATH: binDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, "open");
    assert.deepEqual(spawned.args, ["-R", "/workspace/media/linux-mini-v2.mp4"]);
    assert.equal(spawned.options.detached, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reveals a file in File Explorer through PowerShell on Windows", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.CMD"), "@echo off\r\n");
    // resolvePowerShellPath builds `${SYSTEMROOT}\System32\...` with Windows
    // separators, which on the posix test filesystem is one file name.
    const systemRoot = path.join(binDir, "system-root");
    const powerShellPath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    yield* fileSystem.makeDirectory(path.dirname(powerShellPath), { recursive: true });
    yield* fileSystem.writeFileString(powerShellPath, "");

    let spawned: ChildProcess.StandardCommand | undefined;
    const kind = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "C:/workspace with spaces/media/author's clip.mp4",
        reveal: true,
      });
      return yield* launcher.resolveFileManagerRevealKind();
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD", SYSTEMROOT: systemRoot },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.equal(kind, "file-explorer");
    assert.ok(spawned);
    assert.equal(spawned.command, powerShellPath);
    assert.deepEqual(spawned.args.slice(0, -1), [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    const encodedCommand = spawned.args[spawned.args.length - 1] ?? "";
    const decodedCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
    assert.equal(
      decodedCommand,
      "$ProgressPreference = 'SilentlyContinue'; $folderVerb = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell' -ErrorAction SilentlyContinue).'(default)'; if ($folderVerb -and $folderVerb -ne 'none') { Invoke-Item -LiteralPath 'C:\\workspace with spaces\\media' } else { Start-Process 'explorer.exe' -ArgumentList ('/select,\"' + 'C:\\workspace with spaces\\media\\author''s clip.mp4' + '\"') }",
    );
    assert.equal(spawned.options.shell, false);
    assert.equal(spawned.options.detached, false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const { kind, folderVerb } of [
  { kind: "browser", folderVerb: "none" },
  { kind: "reveal", folderVerb: "none" },
  { kind: "reveal", folderVerb: "" },
  { kind: "reveal", folderVerb: "open" },
] as const) {
  it.live.skipIf(!windowsHost)(
    `completes a ${kind} launch through real PowerShell after the launcher scope closes (folder verb: ${folderVerb || "empty"})`,
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-reveal-smoke-"));
        const outputPath = NodePath.join(tempDir, "argv.txt");
        const watcher = NodeFS.watch(tempDir, { signal: AbortSignal.timeout(20_000) });
        try {
          const recorderPath = NodePath.join(tempDir, "recorder.cmd");
          const stagingPath = NodePath.join(tempDir, "argv.tmp");
          NodeFS.writeFileSync(
            recorderPath,
            `@echo off\r\n>"${stagingPath}" echo(%*\r\nmove /y "${stagingPath}" "${outputPath}" >nul\r\n`,
          );
          const recorded = new Promise<string>((resolve, reject) => {
            watcher.on("change", () => {
              if (NodeFS.existsSync(outputPath)) {
                resolve(NodeFS.readFileSync(outputPath, "utf8").trim());
              }
            });
            watcher.on("error", reject);
            watcher.on("close", () =>
              reject(new Error("PowerShell did not run the recording stub")),
            );
          });

          const target = "C:/workspace with spaces/author's media/clip.mp4";
          yield* Effect.all(
            [
              Effect.gen(function* () {
                const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
                const recordingSpawner = ChildProcessSpawner.make((command) => {
                  assert.ok(ChildProcess.isStandardCommand(command));
                  const recorderLiteral = `'${recorderPath.replaceAll("'", "''")}'`;
                  const source = Buffer.from(command.args.at(-1) ?? "", "base64")
                    .toString("utf16le")
                    .replace("'explorer.exe'", recorderLiteral);
                  // Control the association without changing the host registry or opening its file manager.
                  const handlers =
                    kind === "reveal"
                      ? `function Get-ItemProperty { [CmdletBinding()] param([string]$LiteralPath); if ($LiteralPath -ne 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell') { throw 'Unexpected registry path' }; @{ '(default)' = '${folderVerb}' } }; function Invoke-Item { param([string]$LiteralPath); Start-Process ${recorderLiteral} -ArgumentList ('"' + $LiteralPath + '"') }; `
                      : "";
                  return realSpawner.spawn(
                    ChildProcess.make(
                      command.command,
                      [
                        ...command.args.slice(0, -1),
                        Buffer.from(handlers + source, "utf16le").toString("base64"),
                      ],
                      command.options,
                    ),
                  );
                });
                const launcher = yield* ExternalLauncher.make.pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
                );
                if (kind === "browser") {
                  yield* launcher.launchBrowser(recorderPath);
                } else {
                  yield* launcher.launchEditor({
                    editor: "file-manager",
                    cwd: target,
                    reveal: true,
                  });
                }
              }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
              Effect.promise(() =>
                recorded.then((value) => {
                  assert.equal(
                    value,
                    kind === "browser"
                      ? ""
                      : folderVerb === "open"
                        ? `"C:\\workspace with spaces\\author's media"`
                        : `/select,"${target.replaceAll("/", "\\")}"`,
                  );
                }),
              ),
            ],
            { concurrency: "unbounded" },
          );
        } finally {
          watcher.close();
          // The recording stub's cmd.exe can still hold the directory for a
          // moment after it publishes its output, which Windows reports as EPERM.
          NodeFS.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
      }),
    { timeout: 30_000 },
  );
}

it.effect("does not advertise reveal on Windows when PowerShell is missing", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.CMD"), "@echo off\r\n");

    const result = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return {
        kind: yield* launcher.resolveFileManagerRevealKind(),
        editors: yield* launcher.resolveAvailableEditors(),
      };
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "win32",
          env: {
            PATH: binDir,
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
            SYSTEMROOT: path.join(binDir, "missing-system-root"),
          },
        }),
      ),
    );

    assert.equal(result.editors.includes("file-manager"), true);
    assert.isUndefined(result.kind);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "reveals a WSL file in Windows File Explorer through its UNC path",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["explorer.exe", "powershell.exe", "xdg-open"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      let spawned: ChildProcess.StandardCommand | undefined;
      const result = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        const kind = yield* launcher.resolveFileManagerRevealKind();
        const editors = yield* launcher.resolveAvailableEditors();
        yield* launcher.launchEditor({
          editor: "file-manager",
          cwd: "/home/t3/workspace [draft]/author's $media/clip|draft.mp4",
          reveal: true,
        });
        return { kind, editors };
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: {
              PATH: binDir,
              WSL_DISTRO_NAME: "Ubuntu-24.04",
              WSL_INTEROP: "/run/WSL/1_interop",
            },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );

      assert.equal(result.kind, "file-explorer");
      assert.equal(result.editors.includes("file-manager"), true);
      assert.ok(spawned);
      assert.equal(spawned.command, "powershell.exe");
      assert.equal(spawned.options.detached, true);
      const encodedCommand = spawned.args[spawned.args.length - 1] ?? "";
      const decodedCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
      assert.equal(
        decodedCommand,
        "$ProgressPreference = 'SilentlyContinue'; $folderVerb = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell' -ErrorAction SilentlyContinue).'(default)'; if ($folderVerb -and $folderVerb -ne 'none') { Invoke-Item -LiteralPath '\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\workspace [draft]\\author''s $media' } else { Start-Process 'explorer.exe' -ArgumentList ('/select,\"' + '\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\workspace [draft]\\author''s $media\\clip|draft.mp4' + '\"') }",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "does not advertise reveal from WSL when interop PowerShell is missing",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      const explorerPath = path.join(binDir, "explorer.exe");
      yield* fileSystem.writeFileString(explorerPath, "");
      yield* fileSystem.chmod(explorerPath, 0o755);

      const result = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        return {
          kind: yield* launcher.resolveFileManagerRevealKind(),
          editors: yield* launcher.resolveAvailableEditors(),
        };
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: {
              PATH: binDir,
              WSL_DISTRO_NAME: "Ubuntu-24.04",
              WSL_INTEROP: "/run/WSL/1_interop",
            },
          }),
        ),
      );

      assert.equal(result.editors.includes("file-manager"), true);
      assert.isUndefined(result.kind);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "reveals through the Linux file manager when WSL lacks interop PowerShell",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["explorer.exe", "xdg-open", "xdg-mime"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      const spawnedCommands: ChildProcess.StandardCommand[] = [];
      const kind = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        const revealKind = yield* launcher.resolveFileManagerRevealKind();
        yield* launcher.launchEditor({
          editor: "file-manager",
          cwd: "/home/t3/workspace/media/clip.mp4",
          reveal: true,
        });
        return revealKind;
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: {
              PATH: binDir,
              WSL_DISTRO_NAME: "Ubuntu-24.04",
              WSL_INTEROP: "/run/WSL/1_interop",
              DISPLAY: ":0",
            },
            onSpawn: (command) => {
              spawnedCommands.push(command);
            },
            spawnResult: (command) =>
              command.command === "xdg-mime"
                ? { stdout: "org.gnome.Nautilus.desktop\n" }
                : undefined,
          }),
        ),
      );

      assert.equal(kind, "files");
      const launch = spawnedCommands.find((command) => command.command === "xdg-open");
      assert.ok(launch);
      assert.deepEqual(launch.args, ["/home/t3/workspace/media"]);
      assert.isUndefined(spawnedCommands.find((command) => command.command === "explorer.exe"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "falls back to the Linux file manager when WSL lacks the Explorer bridge",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["xdg-open", "xdg-mime"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      const spawnedCommands: ChildProcess.StandardCommand[] = [];
      const result = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        const editors = yield* launcher.resolveAvailableEditors();
        const kind = yield* launcher.resolveFileManagerRevealKind();
        yield* launcher.launchEditor({
          editor: "file-manager",
          cwd: "/home/t3/workspace/media/clip.mp4",
          reveal: true,
        });
        return { editors, kind };
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: {
              PATH: binDir,
              WSL_DISTRO_NAME: "Ubuntu-24.04",
              WSL_INTEROP: "/run/WSL/1_interop",
              DISPLAY: ":0",
            },
            onSpawn: (command) => {
              spawnedCommands.push(command);
            },
            spawnResult: (command) =>
              command.command === "xdg-mime"
                ? { stdout: "org.gnome.Nautilus.desktop\n" }
                : undefined,
          }),
        ),
      );

      assert.equal(result.editors.includes("file-manager"), true);
      assert.equal(result.kind, "files");
      const launch = spawnedCommands.find((command) => command.command === "xdg-open");
      assert.ok(launch);
      assert.deepEqual(launch.args, ["/home/t3/workspace/media"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "falls back to opening the containing directory for WSL paths Explorer cannot select",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["explorer.exe", "powershell.exe"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      let spawned: ChildProcess.StandardCommand | undefined;
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({
          editor: "file-manager",
          cwd: '/home/t3/work/clip "quoted".mp4',
          reveal: true,
        });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: {
              PATH: binDir,
              WSL_DISTRO_NAME: "Ubuntu-24.04",
              WSL_INTEROP: "/run/WSL/1_interop",
            },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );

      assert.ok(spawned);
      assert.equal(spawned.command, "powershell.exe");
      assert.equal(spawned.options.detached, true);
      assert.equal(spawned.options.shell, false);
      const source = Buffer.from(spawned.args.at(-1) ?? "", "base64").toString("utf16le");
      assert.equal(
        source,
        `Invoke-Item -LiteralPath '\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\work'`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)("reveals by opening the containing directory on Linux", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    for (const name of ["xdg-open", "xdg-mime"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    const spawnedCommands: ChildProcess.StandardCommand[] = [];
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "file-manager",
        cwd: "/workspace/media/linux-mini-v2.mp4",
        reveal: true,
      });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          onSpawn: (command) => {
            spawnedCommands.push(command);
          },
          spawnResult: (command) =>
            command.command === "xdg-mime" ? { stdout: "org.gnome.Nautilus.desktop\n" } : undefined,
        }),
      ),
    );

    const spawned = spawnedCommands.find((command) => command.command === "xdg-open");
    assert.ok(spawned);
    assert.deepEqual(spawned.args, ["/workspace/media"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const wsl of [false, true]) {
  it.effect.skipIf(windowsHost)(
    "selects a file over D-Bus on " + (wsl ? "WSLg without interop PowerShell" : "Linux"),
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
        for (const name of ["xdg-open", "xdg-mime", "gdbus", ...(wsl ? ["explorer.exe"] : [])]) {
          const filePath = path.join(binDir, name);
          yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
          yield* fileSystem.chmod(filePath, 0o755);
        }
        const target = "/workspace/media/a 'quoted' \"clip\" #100% ? é\\name.mp4";
        const spawnedCommands: ChildProcess.StandardCommand[] = [];
        yield* Effect.gen(function* () {
          const launcher = yield* ExternalLauncher.ExternalLauncher;
          yield* launcher.launchEditor({ editor: "file-manager", cwd: target, reveal: true });
        }).pipe(
          Effect.provide(
            layerTest({
              platform: "linux",
              env: {
                PATH: binDir,
                WAYLAND_DISPLAY: "wayland-1",
                ...(wsl
                  ? { WSL_DISTRO_NAME: "Ubuntu-24.04", WSL_INTEROP: "/run/WSL/1_interop" }
                  : {}),
              },
              onSpawn: (command) => spawnedCommands.push(command),
              spawnResult: (command) =>
                command.command === "xdg-mime"
                  ? { stdout: "com.thisisgm.flea.desktop\n" }
                  : undefined,
            }),
          ),
        );

        const reveal = spawnedCommands.find((command) => command.command === "gdbus");
        assert.ok(reveal);
        assert.deepEqual(reveal.args, [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.FileManager1",
          "--object-path",
          "/org/freedesktop/FileManager1",
          "--method",
          "org.freedesktop.FileManager1.ShowItems",
          "[\"file:///workspace/media/a%20'quoted'%20%22clip%22%20%23100%25%20%3F%20%C3%A9%5Cname.mp4\"]",
          "",
        ]);
        assert.deepEqual(
          spawnedCommands.filter((command) => command.command !== "xdg-mime"),
          [reveal],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

for (const scenario of ["rejected", "spawn-error", "stalled"] as const) {
  it.effect.skipIf(windowsHost)("opens the containing directory when D-Bus is " + scenario, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["xdg-open", "xdg-mime", "gdbus"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      const spawnedCommands: ChildProcess.StandardCommand[] = [];
      const started = yield* Latch.make();
      const launch = Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({
          editor: "file-manager",
          cwd: "/workspace/media/linux-mini-v2.mp4",
          reveal: true,
        });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: { PATH: binDir, DISPLAY: ":0" },
            onSpawn: (command) => {
              spawnedCommands.push(command);
              if (command.command === "gdbus") started.openUnsafe();
            },
            spawnResult: (command) => {
              if (command.command === "xdg-mime") return { stdout: "org.gnome.Nautilus.desktop\n" };
              if (command.command !== "gdbus") return undefined;
              if (scenario === "spawn-error") {
                return {
                  spawnError: new PlatformError.PlatformError(
                    new PlatformError.SystemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                      pathOrDescriptor: "gdbus",
                    }),
                  ),
                };
              }
              return { exitCode: 1, stall: scenario === "stalled" };
            },
          }),
        ),
      );
      if (scenario === "stalled") {
        const fiber = yield* launch.pipe(Effect.forkChild);
        yield* started.await;
        yield* TestClock.adjust("1999 millis");
        assert.isUndefined(spawnedCommands.find((command) => command.command === "xdg-open"));
        yield* TestClock.adjust("1 millis");
        yield* Fiber.join(fiber);
      } else {
        yield* launch;
      }

      assert.deepEqual(
        spawnedCommands
          .filter((command) => command.command !== "xdg-mime")
          .map((command) => command.command),
        ["gdbus", "xdg-open"],
      );
      assert.deepEqual(spawnedCommands.at(-1)?.args, ["/workspace/media"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect.skipIf(windowsHost)(
  "does not advertise a Linux file manager without a graphical session",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      const xdgOpenPath = path.join(binDir, "xdg-open");
      yield* fileSystem.writeFileString(xdgOpenPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(xdgOpenPath, 0o755);

      const editors = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        return yield* launcher.resolveAvailableEditors();
      }).pipe(Effect.provide(layerTest({ platform: "linux", env: { PATH: binDir } })));

      assert.equal(editors.includes("file-manager"), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "advertises a Linux file manager when a directory handler is installed",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["xdg-open", "xdg-mime"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      let probe: ChildProcess.StandardCommand | undefined;
      const editors = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        return yield* launcher.resolveAvailableEditors();
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: { PATH: binDir, DISPLAY: ":0" },
            onSpawn: (command) => {
              probe = command;
            },
            spawnResult: (command) =>
              command.command === "xdg-mime"
                ? { stdout: "org.gnome.Nautilus.desktop\n" }
                : undefined,
          }),
        ),
      );

      assert.equal(editors.includes("file-manager"), true);
      assert.ok(probe);
      assert.equal(probe.command, "xdg-mime");
      assert.deepEqual(probe.args, ["query", "default", "inode/directory"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "does not advertise a Linux file manager without a directory handler",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["xdg-open", "xdg-mime"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      const editors = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        return yield* launcher.resolveAvailableEditors();
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: { PATH: binDir, DISPLAY: ":0" },
            spawnResult: (command) => (command.command === "xdg-mime" ? { stdout: "" } : undefined),
          }),
        ),
      );

      assert.equal(editors.includes("file-manager"), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "does not advertise a Linux file manager when the handler query fails",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["xdg-open", "xdg-mime"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      const editors = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        return yield* launcher.resolveAvailableEditors();
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: { PATH: binDir, DISPLAY: ":0" },
            spawnResult: (command) =>
              command.command === "xdg-mime"
                ? { exitCode: 47, stdout: "org.gnome.Nautilus.desktop\n" }
                : undefined,
          }),
        ),
      );

      assert.equal(editors.includes("file-manager"), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Runs on the live clock so the probe's real timeout fires.
it.live.skipIf(windowsHost)("a stalled handler probe drops only the file manager", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    for (const name of ["xdg-open", "xdg-mime", "code"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          spawnResult: (command) => (command.command === "xdg-mime" ? { stall: true } : undefined),
        }),
      ),
    );

    assert.equal(editors.includes("vscode"), true);
    assert.equal(editors.includes("file-manager"), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "does not advertise a Linux file manager when xdg-mime is missing",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      const xdgOpenPath = path.join(binDir, "xdg-open");
      yield* fileSystem.writeFileString(xdgOpenPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(xdgOpenPath, 0o755);

      const editors = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        return yield* launcher.resolveAvailableEditors();
      }).pipe(
        Effect.provide(layerTest({ platform: "linux", env: { PATH: binDir, DISPLAY: ":0" } })),
      );

      assert.equal(editors.includes("file-manager"), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("discovers editors through the service API", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "code.CMD"), "@echo off\r\n");
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.CMD"), "@echo off\r\n");

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }),
      ),
    );

    assert.equal(editors.includes("vscode"), true);
    assert.equal(editors.includes("file-manager"), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const { platform, installPath, editor, args } of [
  {
    platform: "darwin",
    installPath: "Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide",
    editor: "antigravity",
    args: ["--goto", "/workspace with spaces/file.ts:12:4"],
  },
  {
    platform: "linux",
    installPath: ".local/bin/antigravity-ide",
    editor: "antigravity",
    args: ["--goto", "/workspace with spaces/file.ts:12:4"],
  },
  {
    platform: "darwin",
    installPath: "Applications/Cursor.app/Contents/Resources/app/bin/code",
    editor: "cursor",
    args: ["--classic", "--goto", "/workspace with spaces/file.ts:12:4"],
  },
  {
    platform: "darwin",
    installPath: "Applications/Kiro.app/Contents/Resources/app/bin/code",
    editor: "kiro",
    args: ["--goto", "/workspace with spaces/file.ts:12:4"],
  },
  {
    platform: "darwin",
    installPath: "Applications/WebStorm.app/Contents/MacOS/webstorm",
    editor: "webstorm",
    args: ["--line", "12", "--column", "4", "/workspace with spaces/file.ts"],
  },
  {
    platform: "darwin",
    installPath: "Applications/Zed.app/Contents/MacOS/cli",
    editor: "zed",
    args: ["/workspace with spaces/file.ts:12:4"],
  },
  {
    platform: "win32",
    installPath: "Programs/Cursor/resources/app/bin/cursor.cmd",
    editor: "cursor",
    args: ['^"--classic^"', '^"--goto^"', '^"/workspace^ with^ spaces/file.ts:12:4^"'],
  },
  {
    platform: "win32",
    installPath: "Programs/Microsoft VS Code/bin/code.cmd",
    editor: "vscode",
    args: ['^"--goto^"', '^"/workspace^ with^ spaces/file.ts:12:4^"'],
  },
  {
    platform: "win32",
    installPath: "Programs/JetBrains/WebStorm 2026.2/bin/webstorm64.exe",
    editor: "webstorm",
    args: ["--line", "12", "--column", "4", "/workspace with spaces/file.ts"],
  },
  {
    platform: "win32",
    installPath: "Programs/WebStorm/bin/webstorm64.exe",
    editor: "webstorm",
    args: ["--line", "12", "--column", "4", "/workspace with spaces/file.ts"],
  },
  {
    platform: "win32",
    installPath: "Programs/Zed/bin/zed.exe",
    editor: "zed",
    args: ["/workspace with spaces/file.ts:12:4"],
  },
  {
    platform: "linux",
    installPath: ".local/share/JetBrains/Toolbox/scripts/idea",
    editor: "idea",
    args: ["--line", "12", "--column", "4", "/workspace with spaces/file.ts"],
  },
  {
    platform: "linux",
    installPath: ".local/bin/zed",
    editor: "zed",
    args: ["/workspace with spaces/file.ts:12:4"],
  },
] as const) {
  it.effect.skipIf(windowsHost && platform !== "win32")(
    `discovers and launches ${editor} outside PATH on ${platform}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor installs-" });
        const executable = path.join(home, installPath);
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
        let spawned: ChildProcess.StandardCommand | undefined;
        yield* Effect.gen(function* () {
          const launcher = yield* ExternalLauncher.ExternalLauncher;
          assert.include(yield* launcher.resolveAvailableEditors(), editor);
          yield* launcher.launchEditor({ editor, cwd: "/workspace with spaces/file.ts:12:4" });
        }).pipe(
          Effect.provide(
            layerTest({
              platform,
              env: { HOME: home, LOCALAPPDATA: home, PATH: path.join(home, "empty") },
              onSpawn: (command) => {
                spawned = command;
              },
            }),
          ),
        );
        assert.ok(spawned);
        const shim = executable.endsWith(".cmd");
        assert.equal(
          spawned.command,
          shim ? [`^"${executable.replaceAll(" ", "^ ")}^"`, ...args].join(" ") : executable,
        );
        assert.deepEqual(spawned.args, shim ? [] : args);
        assert.equal(spawned.options.shell, shim);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

for (const cwd of ["/workspace with spaces/", "/workspace with spaces/file.ts:12:4"]) {
  it.effect.skipIf(windowsHost)(
    `opens ${cwd} with the macOS Zed bundle when another zed is on PATH`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-zed-collision-" });
        const executable = path.join(home, "Applications/Zed.app/Contents/MacOS/cli");
        const binDir = path.join(home, "zfs/bin");
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.makeDirectory(binDir, { recursive: true });
        for (const command of [executable, path.join(binDir, "zed")]) {
          yield* fs.writeFileString(command, "#!/bin/sh\n");
          yield* fs.chmod(command, 0o755);
        }

        let spawned: ChildProcess.StandardCommand | undefined;
        yield* Effect.gen(function* () {
          const launcher = yield* ExternalLauncher.ExternalLauncher;
          assert.include(yield* launcher.resolveAvailableEditors(), "zed");
          yield* launcher.launchEditor({ editor: "zed", cwd });
        }).pipe(
          Effect.provide(
            layerTest({
              platform: "darwin",
              env: { HOME: home, PATH: binDir },
              onSpawn: (command) => {
                spawned = command;
              },
            }),
          ),
        );
        assert.ok(spawned);
        assert.equal(spawned.command, executable);
        assert.deepEqual(spawned.args, [cwd]);
        assert.equal(spawned.options.shell, false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect.each([
  { editor: "webstorm", installPath: "Applications/WebStorm 2026.2.app/Contents/MacOS/webstorm" },
  { editor: "idea", installPath: "Applications/IntelliJ IDEA 2026.1.4.app/Contents/MacOS/idea" },
] as const)(
  "discovers and launches $editor from a versioned macOS bundle",
  ({ editor, installPath }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-versioned-" });
      const executable = path.join(home, installPath);
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "#!/bin/sh\n");
      yield* fs.chmod(executable, 0o755);

      let spawned: ChildProcess.StandardCommand | undefined;
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        assert.include(yield* launcher.resolveAvailableEditors(), editor);
        yield* launcher.launchEditor({ editor, cwd: "/workspace with spaces/file.ts:12:4" });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "darwin",
            env: { HOME: home, PATH: path.join(home, "empty") },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );

      assert.ok(spawned);
      assert.equal(spawned.command, executable);
      assert.deepEqual(spawned.args, [
        "--line",
        "12",
        "--column",
        "4",
        "/workspace with spaces/file.ts",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("matches macOS bundles on the name boundary only", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const unrelatedHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-unrelated-" });
    const unrelated = path.join(
      unrelatedHome,
      "Applications/WebStormHelper.app/Contents/MacOS/webstorm",
    );
    yield* fs.makeDirectory(path.dirname(unrelated), { recursive: true });
    yield* fs.writeFileString(unrelated, "#!/bin/sh\n");
    yield* fs.chmod(unrelated, 0o755);

    const editorsFor = (home: string) =>
      Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        return yield* launcher.resolveAvailableEditors();
      }).pipe(
        Effect.provide(
          layerTest({ platform: "darwin", env: { HOME: home, PATH: path.join(home, "bin") } }),
        ),
      );

    assert.notInclude(yield* editorsFor(unrelatedHome), "webstorm");

    const exactHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-exact-" });
    const exact = path.join(exactHome, "Applications/WebStorm.app/Contents/MacOS/webstorm");
    yield* fs.makeDirectory(path.dirname(exact), { recursive: true });
    yield* fs.writeFileString(exact, "#!/bin/sh\n");
    yield* fs.chmod(exact, 0o755);

    assert.include(yield* editorsFor(exactHome), "webstorm");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the macOS VS Code Insiders bundle out of stable VS Code", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-insiders-" });
    // The real Insiders bundle ships both `code-insiders` and `code`.
    const bin = path.join(
      home,
      "Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin",
    );
    yield* fs.makeDirectory(bin, { recursive: true });
    for (const name of ["code", "code-insiders"]) {
      yield* fs.writeFileString(path.join(bin, name), "#!/bin/sh\n");
      yield* fs.chmod(path.join(bin, name), 0o755);
    }

    let spawned: ChildProcess.StandardCommand | undefined;
    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      const available = yield* launcher.resolveAvailableEditors();
      yield* launcher.launchEditor({ editor: "vscode-insiders", cwd: "/workspace/file.ts" });
      return available;
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { HOME: home, PATH: path.join(home, "empty") },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.notInclude(editors, "vscode");
    assert.include(editors, "vscode-insiders");
    assert.equal(spawned?.command, path.join(bin, "code-insiders"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const { platform, installPath, onPath } of [
  { platform: "darwin", installPath: ".local/bin/agy", onPath: true },
  { platform: "linux", installPath: ".local/bin/agy", onPath: false },
  { platform: "win32", installPath: "agy/bin/agy.cmd", onPath: true },
] as const) {
  it.effect.skipIf(windowsHost && platform !== "win32")(
    `does not report the agy CLI as the Antigravity IDE on ${platform}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cli-" });
        const executable = path.join(home, installPath);
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
        const editors = yield* Effect.gen(function* () {
          const launcher = yield* ExternalLauncher.ExternalLauncher;
          return yield* launcher.resolveAvailableEditors();
        }).pipe(
          Effect.provide(
            layerTest({
              platform,
              env: {
                HOME: home,
                LOCALAPPDATA: home,
                PATH: onPath ? path.dirname(executable) : path.join(home, "empty"),
                PATHEXT: ".COM;.EXE;.BAT;.CMD",
              },
            }),
          ),
        );
        assert.notInclude(editors, "antigravity");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect.skipIf(windowsHost)("ignores unusable app bundles and keeps PATH launchers first", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-priority-" });
    const executable = path.join(home, "Applications/Cursor.app/Contents/Resources/app/bin/code");
    const env = { HOME: home, PATH: path.join(home, "bin") };
    const discover = Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    });
    const before = yield* discover.pipe(Effect.provide(layerTest({ platform: "darwin", env })));
    yield* fs.makeDirectory(executable, { recursive: true });
    assert.deepEqual(
      yield* discover.pipe(Effect.provide(layerTest({ platform: "darwin", env }))),
      before,
    );
    yield* fs.remove(executable, { recursive: true });
    yield* fs.writeFileString(executable, "#!/bin/sh\n");
    yield* fs.chmod(executable, 0o644);
    assert.deepEqual(
      yield* discover.pipe(Effect.provide(layerTest({ platform: "darwin", env }))),
      before,
    );
    yield* fs.chmod(executable, 0o755);
    yield* fs.makeDirectory(env.PATH);
    yield* fs.writeFileString(path.join(env.PATH, "cursor"), "#!/bin/sh\n");
    yield* fs.chmod(path.join(env.PATH, "cursor"), 0o755);
    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({ editor: "cursor", cwd: "/workspace" });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { ...env, PATH: `${env.PATH}:/usr/bin` },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );
    assert.equal(spawned?.command, "cursor");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("memoizes editor discovery and refreshes after the cache window", () => {
  let statCalls = 0;
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const layerLauncher = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.sync(() => {
              statCalls += 1;
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    const first = yield* launcher.resolveAvailableEditors();
    assert.equal(first.includes("vscode"), true);
    const statCallsAfterFirstScan = statCalls;
    assert.isAbove(statCallsAfterFirstScan, 0);

    yield* TestClock.adjust("31 seconds");
    const second = yield* launcher.resolveAvailableEditors();
    assert.deepEqual([...second], [...first]);
    assert.equal(statCalls, statCallsAfterFirstScan);

    yield* TestClock.adjust("30 seconds");
    yield* launcher.resolveAvailableEditors();
    assert.isAbove(statCalls, statCallsAfterFirstScan);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerLauncher,
        Layer.succeed(HostProcess.Platform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\t3-editor-discovery-cache-test",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
        TestClock.layer(),
      ),
    ),
  );
});

it.effect("keeps scanning after the caller is interrupted and shares that scan", () => {
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const release = Deferred.makeUnsafe<void>();
  let parkedStats = 0;
  const layerLauncher = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              if (!Deferred.isDoneUnsafe(release)) {
                parkedStats += 1;
                yield* Deferred.await(release);
              }
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    const interrupted = yield* Effect.forkChild(launcher.resolveAvailableEditors());
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(interrupted);

    const next = yield* Effect.forkChild(launcher.resolveAvailableEditors());
    yield* Effect.yieldNow;
    assert.equal(parkedStats, 1);

    yield* Deferred.succeed(release, undefined);
    const editors = yield* Fiber.join(next);
    assert.equal(editors.includes("vscode"), true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerLauncher,
        Layer.succeed(HostProcess.Platform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\t3-editor-discovery-interrupt-test",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
      ),
    ),
  );
});

const launchWindowsShimEditor = (cwd: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "code.CMD"), "@echo off\r\n");
    let spawned: ChildProcess.StandardCommand | undefined;
    const exit = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.launchEditor({ editor: "vscode", cwd }).pipe(Effect.exit);
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          resolveExecutable: (command) =>
            command === "code" ? "C:\\Program Files\\Microsoft VS Code\\bin\\code.CMD" : command,
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );
    return { exit, spawned };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect.each([
  ["CRLF", "C:\\workspace\\file.ts\r\ncalc.exe"],
  ["LF", "C:\\workspace\\file.ts\ncalc.exe"],
  ["double quote", 'C:\\workspace\\file.ts" & calc.exe & "'],
] as const)("does not start a Windows command shim for a path with a $0", ([, cwd]) =>
  Effect.gen(function* () {
    const { exit, spawned } = yield* launchWindowsShimEditor(cwd);
    assert.equal(spawned, undefined);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.instanceOf(
        Cause.squash(exit.cause),
        ExternalLauncher.ExternalLauncherUnsupportedTargetError,
      );
    }
  }),
);

it.effect("starts a Windows command shim for unicode paths with cmd metacharacters", () =>
  Effect.gen(function* () {
    const { exit, spawned } = yield* launchWindowsShimEditor(
      "C:\\Users\\jö\\R&D (100%)\\naïve ^file!.ts:3:7",
    );
    assert.isTrue(Exit.isSuccess(exit));
    assert.ok(spawned);
    assert.equal(spawned.options.shell, true);
    assert.deepEqual(spawned.args, []);
    assert.isTrue(
      spawned.command.endsWith(
        ' ^"--goto^" ^"C:\\Users\\jö\\R^&D^ ^(100^%^)\\naïve^ ^^file^!.ts:3:7^"',
      ),
    );
  }),
);

it.effect.skipIf(windowsHost)("passes line breaks through to editors started without a shell", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const zed = path.join(binDir, "zed");
    yield* fileSystem.writeFileString(zed, "#!/bin/sh\n");
    yield* fileSystem.chmod(zed, 0o755);
    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({ editor: "zed", cwd: "/workspace/odd\nname.ts" });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "linux",
          env: { PATH: binDir, HOME: binDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );
    assert.ok(spawned);
    assert.deepEqual(spawned.args, ["/workspace/odd\nname.ts"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects unknown editors through the service API", () =>
  Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const error = yield* launcher
      .launchEditor({ editor: "missing-editor" as never, cwd: "/tmp/workspace" })
      .pipe(Effect.flip);
    assert.instanceOf(error, ExternalLauncher.ExternalLauncherUnknownEditorError);
    assert.equal(error.editor, "missing-editor");
    assert.equal(error.message, "Unknown editor: missing-editor");
  }).pipe(Effect.provide(layerTest({ platform: "linux", env: { PATH: "" } }))),
);
