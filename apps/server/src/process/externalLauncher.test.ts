import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  isCommandAvailable,
  launchBrowser,
  launchEditorProcess,
  resolveAvailableEditors,
  resolveBrowserLaunch,
  resolveEditorLaunch,
} from "./externalLauncher.ts";

function encodeUtf16LeBase64(input: string): string {
  const bytes = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return Encoding.encodeBase64(bytes);
}

function makeMockDetachedHandle(onUnref: () => void = () => undefined) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      onUnref();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it.layer(NodeServices.layer)("resolveEditorLaunch", (it) => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const antigravityLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "antigravity" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(antigravityLaunch, {
        command: "agy",
        args: ["/tmp/workspace"],
      });

      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      const traeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "trae" },
        "darwin",
      );
      assert.deepEqual(traeLaunch, {
        command: "trae",
        args: ["/tmp/workspace"],
      });

      const kiroLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "kiro" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(kiroLaunch, {
        command: "kiro",
        args: ["ide", "/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const vscodeInsidersLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode-insiders" },
        "darwin",
      );
      assert.deepEqual(vscodeInsidersLaunch, {
        command: "code-insiders",
        args: ["/tmp/workspace"],
      });

      const vscodiumLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscodium" },
        "darwin",
      );
      assert.deepEqual(vscodiumLaunch, {
        command: "codium",
        args: ["/tmp/workspace"],
      });

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });

      const ideaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "idea" },
        "darwin",
      );
      assert.deepEqual(ideaLaunch, {
        command: "idea",
        args: ["/tmp/workspace"],
      });

      const aquaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "aqua" },
        "darwin",
      );
      assert.deepEqual(aquaLaunch, {
        command: "aqua",
        args: ["/tmp/workspace"],
      });

      const clionLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "clion" },
        "darwin",
      );
      assert.deepEqual(clionLaunch, {
        command: "clion",
        args: ["/tmp/workspace"],
      });

      const datagripLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "datagrip" },
        "darwin",
      );
      assert.deepEqual(datagripLaunch, {
        command: "datagrip",
        args: ["/tmp/workspace"],
      });

      const dataspellLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "dataspell" },
        "darwin",
      );
      assert.deepEqual(dataspellLaunch, {
        command: "dataspell",
        args: ["/tmp/workspace"],
      });

      const golandLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "goland" },
        "darwin",
      );
      assert.deepEqual(golandLaunch, {
        command: "goland",
        args: ["/tmp/workspace"],
      });

      const phpstormLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "phpstorm" },
        "darwin",
      );
      assert.deepEqual(phpstormLaunch, {
        command: "phpstorm",
        args: ["/tmp/workspace"],
      });

      const pycharmLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "pycharm" },
        "darwin",
      );
      assert.deepEqual(pycharmLaunch, {
        command: "pycharm",
        args: ["/tmp/workspace"],
      });

      const riderLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "rider" },
        "darwin",
      );
      assert.deepEqual(riderLaunch, {
        command: "rider",
        args: ["/tmp/workspace"],
      });

      const rubymineLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "rubymine" },
        "darwin",
      );
      assert.deepEqual(rubymineLaunch, {
        command: "rubymine",
        args: ["/tmp/workspace"],
      });

      const rustroverLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "rustrover" },
        "darwin",
      );
      assert.deepEqual(rustroverLaunch, {
        command: "rustrover",
        args: ["/tmp/workspace"],
      });

      const webstormLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "webstorm" },
        "darwin",
      );
      assert.deepEqual(webstormLaunch, {
        command: "webstorm",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("applies launch-style-specific navigation arguments", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "cursor" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const traeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "trae" },
        "darwin",
      );
      assert.deepEqual(traeLineAndColumn, {
        command: "trae",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const kiroLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "kiro" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(kiroLineAndColumn, {
        command: "kiro",
        args: ["ide", "--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "vscode" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const vscodeInsidersLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "vscode-insiders" },
        "darwin",
      );
      assert.deepEqual(vscodeInsidersLineAndColumn, {
        command: "code-insiders",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const vscodiumLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "vscodium" },
        "darwin",
      );
      assert.deepEqual(vscodiumLineAndColumn, {
        command: "codium",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "zed" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const zedLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "zed" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(zedLineOnly, {
        command: "zed",
        args: ["/tmp/workspace/AGENTS.md:48"],
      });

      const ideaLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "idea" },
        "darwin",
      );
      assert.deepEqual(ideaLineOnly, {
        command: "idea",
        args: ["--line", "48", "/tmp/workspace/AGENTS.md"],
      });

      const ideaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "idea" },
        "darwin",
      );
      assert.deepEqual(ideaLineAndColumn, {
        command: "idea",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const aquaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "aqua" },
        "darwin",
      );
      assert.deepEqual(aquaLineAndColumn, {
        command: "aqua",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const clionLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "clion" },
        "darwin",
      );
      assert.deepEqual(clionLineAndColumn, {
        command: "clion",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const datagripLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "datagrip" },
        "darwin",
      );
      assert.deepEqual(datagripLineAndColumn, {
        command: "datagrip",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const dataspellLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "dataspell" },
        "darwin",
      );
      assert.deepEqual(dataspellLineAndColumn, {
        command: "dataspell",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const golandLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "goland" },
        "darwin",
      );
      assert.deepEqual(golandLineAndColumn, {
        command: "goland",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const phpstormLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "phpstorm" },
        "darwin",
      );
      assert.deepEqual(phpstormLineAndColumn, {
        command: "phpstorm",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const pycharmLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "pycharm" },
        "darwin",
      );
      assert.deepEqual(pycharmLineAndColumn, {
        command: "pycharm",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const riderLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "rider" },
        "darwin",
      );
      assert.deepEqual(riderLineAndColumn, {
        command: "rider",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const rubymineLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "rubymine" },
        "darwin",
      );
      assert.deepEqual(rubymineLineAndColumn, {
        command: "rubymine",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const rustroverLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "rustrover" },
        "darwin",
      );
      assert.deepEqual(rustroverLineAndColumn, {
        command: "rustrover",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const webstormLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "webstorm" },
        "darwin",
      );
      assert.deepEqual(webstormLineOnly, {
        command: "webstorm",
        args: ["--line", "48", "/tmp/workspace/AGENTS.md"],
      });
    }),
  );

  it.effect("falls back to zeditor when zed is not installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      yield* fs.writeFileString(path.join(dir, "zeditor"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(dir, "zeditor"), 0o755);

      const result = yield* resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "zed" }, "linux", {
        PATH: dir,
      });

      assert.deepEqual(result, {
        command: "zeditor",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("falls back to the primary command when no alias is installed", () =>
    Effect.gen(function* () {
      const result = yield* resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "zed" }, "linux", {
        PATH: "",
      });
      assert.deepEqual(result, {
        command: "zed",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
        { PATH: "" },
      );
      assert.deepEqual(launch2, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const launch3 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(launch3, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

it("resolveBrowserLaunch maps default browser launchers by platform", () => {
  const target = "https://example.com/some path?name=o'hara";

  assert.deepEqual(resolveBrowserLaunch(target, "darwin").command, "open");
  assert.deepEqual(resolveBrowserLaunch(target, "darwin").args, [target]);
  assert.deepEqual(resolveBrowserLaunch(target, "darwin").options, {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  assert.deepEqual(resolveBrowserLaunch(target, "linux", {}).command, "xdg-open");
  assert.deepEqual(resolveBrowserLaunch(target, "linux", {}).args, [target]);

  const windows = resolveBrowserLaunch(target, "win32", {
    SYSTEMROOT: "C:\\Windows",
  });
  assert.equal(windows.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(windows.args, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodeUtf16LeBase64(
      "$ProgressPreference = 'SilentlyContinue'; Start 'https://example.com/some path?name=o''hara'",
    ),
  ]);
  assert.deepEqual(windows.options, {
    detached: true,
    shell: false,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
});

it("resolveBrowserLaunch opens through Windows from WSL when not remote", () => {
  const launch = resolveBrowserLaunch("https://example.com", "linux", {
    WSL_DISTRO_NAME: "Ubuntu",
  });
  assert.equal(launch.command, "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
  assert.equal(launch.options.detached, true);
});

it("resolveBrowserLaunch keeps xdg-open for WSL over SSH", () => {
  const launch = resolveBrowserLaunch("https://example.com", "linux", {
    WSL_DISTRO_NAME: "Ubuntu",
    SSH_CONNECTION: "client server",
  });
  assert.equal(launch.command, "xdg-open");
});

it.layer(NodeServices.layer)("launchBrowser", (it) => {
  it.effect("spawns through the ChildProcessSpawner service and unrefs the handle", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.StandardCommand | undefined;
      let didUnref = false;

      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: (command) =>
          Effect.sync(() => {
            assert.equal(ChildProcess.isStandardCommand(command), true);
            if (!ChildProcess.isStandardCommand(command)) {
              throw new Error("Expected a standard command");
            }
            spawnedCommand = command;
            return makeMockDetachedHandle(() => {
              didUnref = true;
            });
          }),
      });

      const result = yield* launchBrowser("https://example.com").pipe(
        Effect.provide(spawnerLayer),
        Effect.result,
      );

      assertSuccess(result, undefined);
      assert.ok(spawnedCommand);
      const expectedLaunch = resolveBrowserLaunch("https://example.com");
      assert.equal(spawnedCommand.command, expectedLaunch.command);
      assert.deepEqual(spawnedCommand.args, expectedLaunch.args);
      assert.deepEqual(spawnedCommand.options, expectedLaunch.options);
      assert.equal(didUnref, true);
    }),
  );
});

it.layer(NodeServices.layer)("launchEditorProcess", (it) => {
  it.effect("spawns through the ChildProcessSpawner service and unrefs the handle", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.StandardCommand | undefined;
      let didUnref = false;
      const expectedArgs = ["-e", "process.exit(0)"];

      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: (command) =>
          Effect.sync(() => {
            assert.equal(ChildProcess.isStandardCommand(command), true);
            if (!ChildProcess.isStandardCommand(command)) {
              throw new Error("Expected a standard command");
            }
            spawnedCommand = command;
            return makeMockDetachedHandle(() => {
              didUnref = true;
            });
          }),
      });

      const result = yield* launchEditorProcess({
        command: process.execPath,
        args: expectedArgs,
      }).pipe(Effect.provide(spawnerLayer), Effect.result);

      assertSuccess(result, undefined);
      assert.ok(spawnedCommand);
      assert.equal(spawnedCommand.command, process.execPath);
      assert.deepEqual(
        spawnedCommand.args,
        process.platform === "win32" ? expectedArgs.map((arg) => `"${arg}"`) : expectedArgs,
      );
      assert.deepEqual(spawnedCommand.options, {
        detached: true,
        shell: process.platform === "win32",
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      assert.equal(didUnref, true);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {});
      const result = yield* launchEditorProcess({
        command: `t3code-no-such-command-${yield* Random.nextUUIDv4}`,
        args: [],
      }).pipe(Effect.provide(spawnerLayer), Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("resolves win32 commands with PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      yield* fs.writeFileString(path.join(dir, "code.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );

  it("returns false when a command is not on PATH", () => {
    const env = {
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(isCommandAvailable("definitely-not-installed", { platform: "win32", env }), false);
  });

  it.effect("does not treat bare files without executable extension as available on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      yield* fs.writeFileString(path.join(dir, "npm"), "echo nope\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("npm", { platform: "win32", env }), false);
    }),
  );

  it.effect("appends PATHEXT for commands with non-executable extensions on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      yield* fs.writeFileString(path.join(dir, "my.tool.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("my.tool", { platform: "win32", env }), true);
    }),
  );

  it.effect("uses platform-specific PATH delimiter for platform overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const firstDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      yield* fs.writeFileString(path.join(firstDir, "code.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(secondDir, "code.CMD"), "MZ");
      const env = {
        PATH: `${firstDir};${secondDir}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );
});

it.layer(NodeServices.layer)("resolveAvailableEditors", (it) => {
  it.effect("returns installed editors for command launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editors-" });

      yield* fs.writeFileString(path.join(dir, "trae.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "kiro.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "code-insiders.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "codium.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "aqua.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "clion.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "datagrip.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "dataspell.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "goland.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "phpstorm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "pycharm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "rider.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "rubymine.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "rustrover.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "webstorm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "explorer.CMD"), "MZ");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, [
        "trae",
        "kiro",
        "vscode-insiders",
        "vscodium",
        "aqua",
        "clion",
        "datagrip",
        "dataspell",
        "goland",
        "phpstorm",
        "pycharm",
        "rider",
        "rubymine",
        "rustrover",
        "webstorm",
        "file-manager",
      ]);
    }),
  );

  it.effect("includes zed when only the zeditor command is installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editors-" });

      yield* fs.writeFileString(path.join(dir, "zeditor"), "#!/bin/sh\nexit 0\n");
      yield* fs.writeFileString(path.join(dir, "xdg-open"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(dir, "zeditor"), 0o755);
      yield* fs.chmod(path.join(dir, "xdg-open"), 0o755);

      const editors = resolveAvailableEditors("linux", {
        PATH: dir,
      });
      assert.deepEqual(editors, ["zed", "file-manager"]);
    }),
  );

  it("omits file-manager when the platform opener is unavailable", () => {
    const editors = resolveAvailableEditors("linux", {
      PATH: "",
    });
    assert.deepEqual(editors, []);
  });
});
