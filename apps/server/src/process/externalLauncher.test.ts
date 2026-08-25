// @effect-diagnostics nodeBuiltinImport:off - the Windows reveal smoke test drives a real PowerShell through Node process and filesystem APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as ExternalLauncher from "./externalLauncher.ts";

interface MockSpawnResult {
  readonly exitCode?: number;
  readonly stdout?: string;
  /** Never deliver an exit code, like a child wedged on a broken desktop session. */
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

const testLayer = (input: {
  readonly platform: NodeJS.Platform;
  readonly env?: Record<string, string>;
  readonly resolveExecutable?: (command: string) => string | undefined;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onUnref?: () => void;
  readonly spawnResult?: (command: ChildProcess.StandardCommand) => MockSpawnResult | undefined;
}) => {
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        input.onSpawn?.(command);
        return makeMockDetachedHandle({
          ...(input.onUnref === undefined ? {} : { onUnref: input.onUnref }),
          ...input.spawnResult?.(command),
        });
      }),
    ),
  );

  return Layer.mergeAll(
    ExternalLauncher.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, spawnerLayer))),
    Layer.succeed(HostProcessPlatform, input.platform),
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
      testLayer({
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
        testLayer({
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
    assert.equal(spawned.command, '^"C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.CMD^"');
    assert.deepEqual(spawned.args, [
      '^"--goto^"',
      '^"C:\\workspace^ with^ spaces\\src\\index.ts:12:4^"',
    ]);
    assert.equal(spawned.options.shell, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reveals a file in Finder with open -R on macOS", () =>
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
        testLayer({
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
        cwd: "C:\\workspace with spaces\\media\\author's clip.mp4",
        reveal: true,
      });
      return yield* launcher.resolveFileManagerRevealKind();
    }).pipe(
      Effect.provide(
        testLayer({
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
    // explorer.exe expects `/select,"<path>"` with only the path quoted;
    // PowerShell 5.1's Start-Process passes the argument string verbatim.
    assert.equal(
      decodedCommand,
      "$ProgressPreference = 'SilentlyContinue'; Start-Process 'explorer.exe' -ArgumentList ('/select,\"' + 'C:\\workspace with spaces\\media\\author''s clip.mp4' + '\"')",
    );
    assert.equal(spawned.options.shell, false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Real-chain smoke check for the Explorer selection contract: runs the exact
// PowerShell source the reveal launch encodes, against a stub that records
// the raw argument tail it receives, and asserts a spaced path arrives as the
// single `/select,"<path>"` switch. Mock argv assertions cannot prove this —
// only Windows' own PowerShell -> CreateProcess quoting chain can, so the
// test runs only where that chain exists.
// oxlint-disable-next-line t3code/no-global-process-runtime -- the skip decision needs the real host platform, outside any Effect runtime.
it.skipIf(process.platform !== "win32")(
  "delivers the raw /select switch for spaced paths through real PowerShell",
  { timeout: 60_000 },
  async () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-reveal-smoke-"));
    try {
      const recorderPath = NodePath.join(tempDir, "recorder.cmd");
      const outputPath = NodePath.join(tempDir, "argv.txt");
      NodeFS.writeFileSync(recorderPath, `@echo off\r\n>"${outputPath}" echo(%*\r\n`);

      const target = "C:\\workspace with spaces\\media\\author's clip.mp4";
      const source = ExternalLauncher.buildFileExplorerRevealPowerShellSource(recorderPath, target);
      const powerShellPath = `${process.env.SYSTEMROOT ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      NodeChildProcess.execFileSync(
        powerShellPath,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(source, "utf16le").toString("base64"),
        ],
        { timeout: 30_000 },
      );

      // Start-Process returns before the recorder runs; wait for its output.
      // The waits run outside the Effect runtime on purpose: the test
      // exercises the real Windows process chain in real time.
      // @effect-diagnostics-next-line globalTimers:off
      const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));
      // @effect-diagnostics-next-line globalDate:off
      const deadline = Date.now() + 20_000;
      // @effect-diagnostics-next-line globalDate:off
      while (!NodeFS.existsSync(outputPath) && Date.now() < deadline) {
        await sleep(100);
      }
      await sleep(200);
      const recorded = NodeFS.readFileSync(outputPath, "utf8").trim();
      assert.equal(recorded, `/select,"${target}"`);
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

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
        testLayer({
          platform: "win32",
          env: {
            PATH: binDir,
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
            SYSTEMROOT: path.join(binDir, "missing-system-root"),
          },
        }),
      ),
    );

    // Plain "open in file manager" still works through explorer; only the
    // reveal capability, which launches PowerShell, must stay hidden.
    assert.equal(result.editors.includes("file-manager"), true);
    assert.isUndefined(result.kind);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reveals a WSL file in Windows File Explorer through its UNC path", () =>
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
        cwd: "/home/t3/workspace/media/clip.mp4",
        reveal: true,
      });
      return { kind, editors };
    }).pipe(
      Effect.provide(
        testLayer({
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
    // The reveal routes through interop PowerShell so Explorer receives its
    // raw `/select,"<path>"` switch even for spaced paths.
    assert.equal(spawned.command, "powershell.exe");
    const encodedCommand = spawned.args[spawned.args.length - 1] ?? "";
    const decodedCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
    assert.equal(
      decodedCommand,
      "$ProgressPreference = 'SilentlyContinue'; Start-Process 'explorer.exe' -ArgumentList ('/select,\"' + '\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\workspace\\media\\clip.mp4' + '\"')",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not advertise reveal from WSL when interop PowerShell is missing", () =>
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
        testLayer({
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

// When interop PowerShell is missing the capability advertises the Linux
// "files" kind (or nothing), so the reveal must open the Linux file manager
// the label promised even though plain open still prefers File Explorer.
it.effect("reveals through the Linux file manager when WSL lacks interop PowerShell", () =>
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
        testLayer({
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
            command.command === "xdg-mime" ? { stdout: "org.gnome.Nautilus.desktop\n" } : undefined,
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

// Interop can exist without `explorer.exe` on PATH (appendWindowsPath=false)
// while WSLg still provides a working Linux file manager; the host must keep
// the Linux open/reveal path instead of losing the editor entirely.
it.effect("falls back to the Linux file manager when WSL lacks the Explorer bridge", () =>
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
        testLayer({
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
            command.command === "xdg-mime" ? { stdout: "org.gnome.Nautilus.desktop\n" } : undefined,
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

it.effect(
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
          cwd: '/home/t3/work "quoted"/clip.mp4',
          reveal: true,
        });
      }).pipe(
        Effect.provide(
          testLayer({
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

      // Explorer's raw switch cannot express a double quote, so the launch
      // opens the parent directory instead of misparsing a /select argument.
      assert.ok(spawned);
      assert.equal(spawned.command, "explorer.exe");
      assert.deepEqual(spawned.args, ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\work "quoted"']);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reveals by opening the containing directory on Linux", () =>
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
        testLayer({
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

it.effect("does not advertise a Linux file manager without a graphical session", () =>
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
    }).pipe(Effect.provide(testLayer({ platform: "linux", env: { PATH: binDir } })));

    assert.equal(editors.includes("file-manager"), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("advertises a Linux file manager when a directory handler is installed", () =>
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
        testLayer({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          onSpawn: (command) => {
            probe = command;
          },
          spawnResult: (command) =>
            command.command === "xdg-mime" ? { stdout: "org.gnome.Nautilus.desktop\n" } : undefined,
        }),
      ),
    );

    assert.equal(editors.includes("file-manager"), true);
    assert.ok(probe);
    assert.equal(probe.command, "xdg-mime");
    assert.deepEqual(probe.args, ["query", "default", "inode/directory"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// `xdg-open` with a display variable but no `inode/directory` handler exits
// nonzero after the launch has already detached: without this gate the server
// advertises a reveal that is a silent no-op.
it.effect("does not advertise a Linux file manager without a directory handler", () =>
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
        testLayer({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          spawnResult: (command) => (command.command === "xdg-mime" ? { stdout: "" } : undefined),
        }),
      ),
    );

    assert.equal(editors.includes("file-manager"), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not advertise a Linux file manager when the handler query fails", () =>
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
        testLayer({
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

// The handler probe carries its own timeout because the editor scan's outer
// timeout in server.getConfig degrades to an EMPTY editor list: a wedged
// xdg-mime must cost only the file manager, never the other editors. Runs on
// the live clock so the probe's real timeout fires.
it.live("a stalled handler probe drops only the file manager", () =>
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
        testLayer({
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

it.effect("does not advertise a Linux file manager when xdg-mime is missing", () =>
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
    }).pipe(Effect.provide(testLayer({ platform: "linux", env: { PATH: binDir, DISPLAY: ":0" } })));

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
        testLayer({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }),
      ),
    );

    assert.equal(editors.includes("vscode"), true);
    assert.equal(editors.includes("file-manager"), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("memoizes editor discovery and refreshes after the cache window", () => {
  let statCalls = 0;
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const launcherLayer = ExternalLauncher.layer.pipe(
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

    // Past the shared command-resolution cache TTL (30s) but within the
    // discovery cache window: the memoized set is reused without any scan.
    yield* TestClock.adjust("31 seconds");
    const second = yield* launcher.resolveAvailableEditors();
    assert.deepEqual([...second], [...first]);
    assert.equal(statCalls, statCallsAfterFirstScan);

    // Past the discovery cache window the next call rescans.
    yield* TestClock.adjust("30 seconds");
    yield* launcher.resolveAvailableEditors();
    assert.isAbove(statCalls, statCallsAfterFirstScan);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
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

// A client that disconnects mid-scan interrupts the shared discovery effect on
// the connection fiber. The cache must not retain that interrupt: doing so
// replayed it to every later connect for the whole TTL, so `server.getConfig`
// failed and no client could reconnect until the server restarted.
it.effect("rescans after an interrupted discovery instead of caching the interrupt", () => {
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  let blockFirstScan = true;
  let scans = 0;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          // The first scan parks inside `stat` so the interrupt lands while
          // discovery is in flight, which is what a client disconnecting
          // mid-connect does to the shared effect.
          stat: () =>
            Effect.gen(function* () {
              scans += 1;
              if (blockFirstScan) {
                return yield* Effect.never;
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

    const fiber = yield* Effect.forkChild(launcher.resolveAvailableEditors());
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);

    // The next connect must still get a real answer well inside the TTL.
    blockFirstScan = false;
    scans = 0;
    const editors = yield* launcher.resolveAvailableEditors();
    assert.equal(editors.includes("vscode"), true);
    assert.isAbove(scans, 0);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
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

it.effect("rejects unknown editors through the service API", () =>
  Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const error = yield* launcher
      .launchEditor({ editor: "missing-editor" as never, cwd: "/tmp/workspace" })
      .pipe(Effect.flip);
    assert.instanceOf(error, ExternalLauncher.ExternalLauncherUnknownEditorError);
    assert.equal(error.editor, "missing-editor");
    assert.equal(error.message, "Unknown editor: missing-editor");
  }).pipe(Effect.provide(testLayer({ platform: "linux", env: { PATH: "" } }))),
);
