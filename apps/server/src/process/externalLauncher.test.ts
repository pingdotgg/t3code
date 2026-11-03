// @effect-diagnostics nodeBuiltinImport:off - the Windows launch smoke tests use filesystem notifications to observe real PowerShell launches.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { EDITORS } from "@t3tools/contracts";
import { resolveEditorCommand } from "@t3tools/shared/editor";
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
  /** Extra service layer that overrides what NodeServices provides to the launcher. */
  readonly serviceOverrides?: Layer.Layer<FileSystem.FileSystem>;
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

  const layerServices =
    input.serviceOverrides === undefined
      ? Layer.merge(NodeServices.layer, layerSpawner)
      : Layer.mergeAll(NodeServices.layer, layerSpawner, input.serviceOverrides);

  return Layer.mergeAll(
    ExternalLauncher.layer.pipe(Layer.provide(layerServices)),
    Layer.succeed(HostProcess.Platform, input.platform),
    Layer.succeed(
      SpawnExecutableResolution,
      (command) => input.resolveExecutable?.(command) ?? command,
    ),
    Layer.succeed(HostProcess.Environment, input.env ?? {}),
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

// Windows drive letters cannot resolve the POSIX editor stub.
it.effect.skipIf(windowsHost)(
  "a Linux editor launch without a display takes the desktop session's display from the systemd user manager",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      const codiumPath = path.join(binDir, "codium");
      yield* fileSystem.writeFileString(codiumPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(codiumPath, 0o755);

      const launchEnv = (sessionManager: MockSpawnResult) =>
        Effect.gen(function* () {
          const spawned: ChildProcess.StandardCommand[] = [];
          yield* Effect.gen(function* () {
            const launcher = yield* ExternalLauncher.ExternalLauncher;
            yield* launcher.launchEditor({ editor: "vscodium", cwd: "/workspace" });
            yield* launcher.launchBrowser("https://example.com");
          }).pipe(
            Effect.provide(
              layerTest({
                platform: "linux",
                env: { PATH: binDir },
                onSpawn: (command) => spawned.push(command),
                spawnResult: (command) =>
                  command.command === "busctl" ? sessionManager : undefined,
              }),
            ),
            Effect.provideService(HostProcess.Environment, { PATH: binDir }),
          );
          // Only editors borrow the session display; a browser must not open on that screen.
          assert.deepEqual(spawned.find((command) => command.command === "xdg-open")?.options.env, {
            PATH: binDir,
          });
          return spawned.find((command) => command.command === "codium")?.options.env;
        });

      assert.deepEqual(
        yield* launchEnv({
          stdout: JSON.stringify({
            type: "as",
            data: [
              "DISPLAY=:0",
              "HOME=/home/user",
              "WAYLAND_DISPLAY=wayland-1",
              "XAUTHORITY=/home/user/auth files/cookie",
            ],
          }),
        }),
        {
          PATH: binDir,
          DISPLAY: ":0",
          WAYLAND_DISPLAY: "wayland-1",
          // Raw, not the $'...' quoting `systemctl show-environment` would print.
          XAUTHORITY: "/home/user/auth files/cookie",
        },
      );
      assert.deepEqual(yield* launchEnv({ stdout: "invalid JSON" }), { PATH: binDir });
      assert.deepEqual(yield* launchEnv({ stdout: '{"data":[42]}' }), { PATH: binDir });
      assert.deepEqual(
        yield* launchEnv({
          spawnError: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
          }),
        }),
        { PATH: binDir },
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
      const encodedCommand = String(spawned.args[spawned.args.length - 1] ?? "");
      const decodedCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
      assert.equal(
        decodedCommand,
        "$ProgressPreference = 'SilentlyContinue'; $folderVerb = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell' -ErrorAction SilentlyContinue).'(default)'; if ($folderVerb -and $folderVerb -ne 'none') { Invoke-Item -LiteralPath '\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\workspace [draft]\\author''s $media' } else { Start-Process 'explorer.exe' -ArgumentList ('/select,\"' + '\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\workspace [draft]\\author''s $media\\clip|draft.mp4' + '\"') }",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// A Dock/Finder launch starts with the bare launchd PATH and `fixPath` hydrates
// process.env in place afterwards; discovery has to see the hydrated value.
it.effect.skipIf(windowsHost)("discovers editors on a PATH hydrated after startup", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const cursorPath = path.join(binDir, "cursor");
    yield* fileSystem.writeFileString(cursorPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(cursorPath, 0o755);

    const emptyDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-empty-" });
    const env: Record<string, string> = { PATH: emptyDir };
    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      env.PATH = `${binDir}:${emptyDir}`;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(Effect.provide(layerTest({ platform: "linux", env })));

    // Exact match: a lookup that fell back to the ambient process PATH would
    // also report whatever editors the host machine has installed.
    assert.deepEqual(editors, ["cursor"]);
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

for (const { layout, pathNames, fallbackNames, expected } of [
  { layout: "PATH", pathNames: ["zed", "zeditor"], fallbackNames: [], expected: "zeditor" },
  {
    layout: "mixed locations",
    pathNames: ["zed"],
    fallbackNames: ["zeditor"],
    expected: "fallback",
  },
  {
    layout: "fallback directory",
    pathNames: [],
    fallbackNames: ["zed", "zeditor"],
    expected: "fallback",
  },
]) {
  it.effect.skipIf(windowsHost)(`prefers the Zed editor on Linux with ${layout}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-zed-linux-" });
      const binDir = path.join(home, "bin");
      const fallbackDir = path.join(home, ".local/bin");
      for (const [dir, names] of [
        [binDir, pathNames],
        [fallbackDir, fallbackNames],
      ] as const) {
        yield* fs.makeDirectory(dir, { recursive: true });
        for (const name of names) {
          yield* fs.writeFileString(path.join(dir, name), "#!/bin/sh\n");
          yield* fs.chmod(path.join(dir, name), 0o755);
        }
      }

      let spawned: ChildProcess.StandardCommand | undefined;
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        assert.include(yield* launcher.resolveAvailableEditors(), "zed");
        yield* launcher.launchEditor({ editor: "zed", cwd: "/workspace" });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: { HOME: home, PATH: binDir },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );
      assert.ok(spawned);
      assert.equal(
        spawned.command,
        expected === "fallback" ? path.join(fallbackDir, "zeditor") : expected,
      );
      assert.deepEqual(spawned.args, ["/workspace"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect.skipIf(windowsHost)("prefers zeditor in a later Linux fallback directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-zed-fallback-" });
    const localBin = path.join(home, ".local/bin");
    const systemBin = path.join(home, "system-bin");
    for (const [dir, name] of [
      [localBin, "zed"],
      [systemBin, "zeditor"],
    ] as const) {
      yield* fs.makeDirectory(dir, { recursive: true });
      const executable = path.join(dir, name);
      yield* fs.writeFileString(executable, "#!/bin/sh\n");
      yield* fs.chmod(executable, 0o755);
    }
    const editor = EDITORS.find((editor) => editor.id === "zed")!;
    const resolve = resolveEditorCommand(editor, { HOME: home, PATH: "" }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(Path.Path, {
        ...path,
        join: (...parts) =>
          path.join(
            ...parts.map((part) =>
              ["/usr/local/bin", "/usr/bin", "/snap/bin"].includes(part) ? systemBin : part,
            ),
          ),
      }),
    );
    assert.deepEqual(
      yield* resolve,
      Option.some({ command: path.join(systemBin, "zeditor"), baseArgs: [] }),
    );
    yield* fs.remove(path.join(systemBin, "zeditor"));
    assert.deepEqual(
      yield* resolve,
      Option.some({ command: path.join(localBin, "zed"), baseArgs: [] }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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

it.effect.skipIf(windowsHost)("keeps PATH launchers ahead of an app bundle's CLI", () =>
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
    // MT Code counts an installed Cursor.app as available even when its bundled
    // CLI is unusable: the launch falls back to `open -a Cursor`. Discovery
    // therefore stays the same whatever state the bundled CLI is in.
    yield* fs.makeDirectory(executable, { recursive: true });
    const withBundle = yield* discover.pipe(Effect.provide(layerTest({ platform: "darwin", env })));
    assert.include(withBundle, "cursor");
    yield* fs.remove(executable, { recursive: true });
    yield* fs.writeFileString(executable, "#!/bin/sh\n");
    yield* fs.chmod(executable, 0o644);
    assert.deepEqual(
      yield* discover.pipe(Effect.provide(layerTest({ platform: "darwin", env }))),
      withBundle,
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

it.effect(
  "memoizes editor discovery and refreshes in the background after the cache window",
  () => {
    let statCalls = 0;
    const rescanned = Deferred.makeUnsafe<void>();
    let initialScanDone = false;
    const fileInfo = { type: "File" } as FileSystem.File.Info;
    const layerLauncher = ExternalLauncher.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            stat: () =>
              Effect.sync(() => {
                statCalls += 1;
                return fileInfo;
              }).pipe(
                Effect.tap(() =>
                  initialScanDone ? Deferred.succeed(rescanned, undefined) : Effect.void,
                ),
              ),
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
      initialScanDone = true;
      assert.isAbove(statCallsAfterFirstScan, 0);

      // Past the shared command-resolution cache TTL (30s) but within the
      // discovery cache window: the memoized set is reused without any scan.
      yield* TestClock.adjust("31 seconds");
      const second = yield* launcher.resolveAvailableEditors();
      assert.deepEqual([...second], [...first]);
      assert.equal(statCalls, statCallsAfterFirstScan);

      // Past the discovery cache window the next call still answers from the
      // memoized set and rescans in the background.
      yield* TestClock.adjust("30 seconds");
      const third = yield* launcher.resolveAvailableEditors();
      assert.deepEqual([...third], [...first]);
      yield* Deferred.await(rescanned);
      assert.isAbove(statCalls, statCallsAfterFirstScan);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerLauncher,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Environment, {
            PATH: "C:\\t3-editor-discovery-cache-test",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          }),
          TestClock.layer(),
        ),
      ),
    );
  },
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
        Layer.succeed(HostProcess.Environment, {
          PATH: "C:\\t3-editor-discovery-interrupt-test",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        }),
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

it.effect("discovers Zed on macOS through its app bundle when no CLI is on PATH", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mac-home-" });
    yield* fileSystem.makeDirectory(path.join(homeDir, "Applications", "Zed.app"), {
      recursive: true,
    });

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(layerTest({ platform: "darwin", env: { PATH: binDir, HOME: homeDir } })),
    );

    assert.equal(editors.includes("zed"), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Bundle discovery consults the real system /Applications folder, so tests
// that assert a bundle is absent must hide it: the host running the suite may
// genuinely have the IDE installed. Redirects those stats to a path that
// cannot exist while every other filesystem operation stays real.
const layerHiddenSystemApplicationsFs = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    return FileSystem.make({
      ...real,
      stat: (statPath) =>
        statPath.startsWith("/Applications/")
          ? real.stat(`${statPath}.t3-test-missing`)
          : real.stat(statPath),
    });
  }),
).pipe(Layer.provide(NodeServices.layer));

// The standalone Antigravity CLI installs an `agy` command without the IDE,
// so a PATH hit alone must not surface Antigravity as an installed editor.
it.effect("does not report Antigravity on macOS when only the agy command is on PATH", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mac-home-" });
    const agyPath = path.join(binDir, "agy");
    yield* fileSystem.writeFileString(agyPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(agyPath, 0o755);

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { PATH: binDir, HOME: homeDir },
          serviceOverrides: layerHiddenSystemApplicationsFs,
        }),
      ),
    );

    assert.equal(editors.includes("antigravity"), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("launches Zed through open -a when only the app bundle is installed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mac-home-" });
    yield* fileSystem.makeDirectory(path.join(homeDir, "Applications", "Zed.app"), {
      recursive: true,
    });
    const openPath = path.join(binDir, "open");
    yield* fileSystem.writeFileString(openPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(openPath, 0o755);

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({ editor: "zed", cwd: "/tmp/workspace" });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { PATH: binDir, HOME: homeDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, "open");
    assert.deepEqual(spawned.args, ["-a", "Zed", "/tmp/workspace"]);
    assert.equal(spawned.options.detached, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("strips the line and column suffix from a bundle launch target", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mac-home-" });
    yield* fileSystem.makeDirectory(path.join(homeDir, "Applications", "Zed.app"), {
      recursive: true,
    });
    const openPath = path.join(binDir, "open");
    yield* fileSystem.writeFileString(openPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(openPath, 0o755);

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({ editor: "zed", cwd: "/tmp/workspace/src/index.ts:12:4" });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { PATH: binDir, HOME: homeDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, "open");
    assert.deepEqual(spawned.args, ["-a", "Zed", "/tmp/workspace/src/index.ts"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// With both the IDE bundle and the standalone agy CLI installed, the launch
// must go through the bundle: the PATH command could be the standalone tool.
it.effect("launches Antigravity through its bundle even when agy is on PATH", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mac-home-" });
    yield* fileSystem.makeDirectory(path.join(homeDir, "Applications", "Antigravity.app"), {
      recursive: true,
    });
    for (const name of ["agy", "open"]) {
      const commandPath = path.join(binDir, name);
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
    }

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({ editor: "antigravity", cwd: "/tmp/workspace" });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { PATH: binDir, HOME: homeDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, "open");
    assert.deepEqual(spawned.args, ["-a", "Antigravity", "/tmp/workspace"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// `:<digits>` is also a legal path suffix, so an existing path must reach
// `open` unchanged and only a nonexistent one loses its position suffix.
it.effect("keeps an existing bundle launch target that ends in a colon suffix", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mac-home-" });
    yield* fileSystem.makeDirectory(path.join(homeDir, "Applications", "Zed.app"), {
      recursive: true,
    });
    const openPath = path.join(binDir, "open");
    yield* fileSystem.writeFileString(openPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(openPath, 0o755);
    const workspace = path.join(binDir, "project:2026");
    yield* fileSystem.makeDirectory(workspace);

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({ editor: "zed", cwd: workspace });
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { PATH: binDir, HOME: homeDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, "open");
    assert.deepEqual(spawned.args, ["-a", "Zed", workspace]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Without the bundle the PATH `agy` is the standalone CLI, so the launch must
// fail as not-installed instead of spawning the wrong program.
it.effect("fails an Antigravity launch on macOS when only the agy command is on PATH", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
    const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mac-home-" });
    const agyPath = path.join(binDir, "agy");
    yield* fileSystem.writeFileString(agyPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(agyPath, 0o755);

    let spawnCount = 0;
    const error = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher
        .launchEditor({ editor: "antigravity", cwd: "/tmp/workspace" })
        .pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { PATH: binDir, HOME: homeDir },
          serviceOverrides: layerHiddenSystemApplicationsFs,
          onSpawn: () => {
            spawnCount += 1;
          },
        }),
      ),
    );

    assert.instanceOf(error, ExternalLauncher.ExternalLauncherCommandNotFoundError);
    assert.equal(error.command, "antigravity-ide");
    assert.equal(spawnCount, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
