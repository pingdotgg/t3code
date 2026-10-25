// @effect-diagnostics nodeBuiltinImport:off - the Windows launch smoke tests use filesystem notifications to observe real PowerShell launches.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as ExternalLauncher from "./externalLauncher.ts";

// Windows drive letters break mocked POSIX PATH splitting; these tests also require /bin/sh stubs.
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

for (const {} of ["darwin", "linux"] as const) {
}

for (const {} of [
  { kind: "browser", folderVerb: "none" },
  { kind: "reveal", folderVerb: "none" },
  { kind: "reveal", folderVerb: "" },
  { kind: "reveal", folderVerb: "open" },
] as const) {
}

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

for (const {} of ["rejected", "spawn-error", "stalled"] as const) {
}

for (const {} of [
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
    args: ["--line", "12", "--column", "3", "/workspace with spaces/file.ts"],
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
    args: ["--line", "12", "--column", "3", "/workspace with spaces/file.ts"],
  },
  {
    platform: "win32",
    installPath: "Programs/WebStorm/bin/webstorm64.exe",
    editor: "webstorm",
    args: ["--line", "12", "--column", "3", "/workspace with spaces/file.ts"],
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
    args: ["--line", "12", "--column", "3", "/workspace with spaces/file.ts"],
  },
  {
    platform: "linux",
    installPath: ".local/bin/zed",
    editor: "zed",
    args: ["/workspace with spaces/file.ts:12:4"],
  },
] as const) {
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
        "3",
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
