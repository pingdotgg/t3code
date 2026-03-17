import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import { FileSystem, Path, Effect } from "effect";

import {
  buildDarwinTerminalAppLaunch,
  buildPosixTmuxBootstrapCommand,
  buildWindowsTmuxBootstrapCommand,
  isCommandAvailable,
  launchDetached,
  resolveAvailableEditors,
  resolveEditorLaunch,
  resolveTerminalName,
  resolveTerminalLaunch,
} from "./open";

it.layer(NodeServices.layer)("resolveEditorLaunch", (it) => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const antigravityLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "antigravity" },
        "darwin",
      );
      assert.deepEqual(antigravityLaunch, {
        command: "agy",
        args: ["/tmp/workspace"],
      });

      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "darwin",
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "darwin",
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("uses --goto when editor supports line/column suffixes", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" },
        "darwin",
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" },
        "darwin",
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
      );
      assert.deepEqual(launch2, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const launch3 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
      );
      assert.deepEqual(launch3, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

it.layer(NodeServices.layer)("launchDetached", (it) => {
  it.effect("resolves when command can be spawned", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `t3code-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("resolves win32 commands with PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
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
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
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
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
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
      const firstDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-open-test-" });
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

it("buildPosixTmuxBootstrapCommand creates a 70/30 split for new sessions", () => {
  const command = buildPosixTmuxBootstrapCommand("/tmp/workspace's", "t3-workspace");
  assert.include(command, "tmux has-session -t 't3-workspace' 2>/dev/null");
  assert.include(
    command,
    `$(tmux display-message -p -t 't3-workspace' '#{window_panes}' 2>/dev/null)`,
  );
  assert.include(
    command,
    `if [ "$(tmux display-message -p -t 't3-workspace' '#{window_panes}' 2>/dev/null)" = "1" ]; then`,
  );
  assert.include(command, "tmux new-session -d -s 't3-workspace' -c '/tmp/workspace'\"'\"'s'");
  assert.include(
    command,
    "tmux split-window -h -t 't3-workspace' -c '/tmp/workspace'\"'\"'s' -p 30",
  );
  assert.include(command, "tmux select-pane -L -t 't3-workspace'");
  assert.include(command, "tmux new-window -t 't3-workspace' -c '/tmp/workspace'\"'\"'s'");
  assert.include(command, "tmux select-window -l -t 't3-workspace'");
  assert.include(command, "exec tmux attach-session -t 't3-workspace'");
});

it("buildWindowsTmuxBootstrapCommand creates a 70/30 split for new sessions", () => {
  const command = buildWindowsTmuxBootstrapCommand("C:\\workspace", "t3-workspace");
  assert.include(command, "tmux has-session -t t3-workspace 2>nul");
  assert.include(command, 'tmux display-message -p -t t3-workspace "#{window_panes}"');
  assert.include(command, 'tmux new-session -d -s t3-workspace -c "C:\\workspace"');
  assert.include(command, 'tmux split-window -h -t t3-workspace -c "C:\\workspace" -p 30');
  assert.include(command, "tmux select-pane -L -t t3-workspace");
  assert.include(command, 'tmux new-window -t t3-workspace -c "C:\\workspace"');
  assert.include(command, "tmux select-window -l -t t3-workspace");
  assert.include(command, "tmux attach-session -t t3-workspace");
});

it("buildDarwinTerminalAppLaunch uses osascript to run the shell command", () => {
  const launch = buildDarwinTerminalAppLaunch("sh -lc 'echo \"hi\" && pwd'");
  assert.deepEqual(launch, {
    command: "osascript",
    args: [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      'tell application "Terminal" to do script "sh -lc \'echo \\"hi\\" && pwd\'"',
    ],
  });
});

it.layer(NodeServices.layer)("resolveAvailableEditors", (it) => {
  it.effect("returns installed editors for command launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editors-" });

      yield* fs.writeFileString(path.join(dir, "cursor.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "explorer.CMD"), "MZ");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, ["cursor", "file-manager"]);
    }),
  );

  it.effect("includes terminal when platform terminal command is available", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editors-" });

      yield* fs.writeFileString(path.join(dir, "cmd.CMD"), "@echo off\r\n");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.include(editors, "terminal");
    }),
  );
});

it.layer(NodeServices.layer)("resolveTerminalLaunch", (it) => {
  it.effect("returns a valid macOS terminal command", () =>
    Effect.gen(function* () {
      const launch = yield* resolveTerminalLaunch("/tmp/workspace", "darwin");
      // Depending on the host: ghostty, kitty (possibly full app bundle path), or osascript (Terminal.app fallback)
      const isExpectedTerminal =
        launch.command.endsWith("ghostty") ||
        launch.command.endsWith("kitty") ||
        launch.command === "osascript";
      assert.isTrue(isExpectedTerminal, `Unexpected terminal command: ${launch.command}`);
    }),
  );

  it.effect("returns win32 terminal command", () =>
    Effect.gen(function* () {
      const launch = yield* resolveTerminalLaunch("C:\\workspace", "win32");
      assert.equal(launch.command, "cmd");
    }),
  );
});

it("resolveTerminalName returns platform-specific display names", () => {
  assert.equal(resolveTerminalName("win32"), "Command Prompt");
  const linuxName = resolveTerminalName("linux");
  assert.include(["Ghostty", "Kitty", "Terminal"], linuxName);
});
