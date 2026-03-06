import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isCommandAvailable,
  launchDetached,
  resolveBrowserLaunch,
  resolveAvailableEditors,
  resolveEditorLaunch,
} from "./open";
import { Effect } from "effect";

describe("resolveEditorLaunch", () => {
  it("returns commands for command-based editors", async () => {
    const cursorLaunch = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        { platform: "darwin" },
      ),
    );
    assert.deepEqual(cursorLaunch, {
      command: "cursor",
      args: ["/tmp/workspace"],
    });

    const vscodeLaunch = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        { platform: "darwin" },
      ),
    );
    assert.deepEqual(vscodeLaunch, {
      command: "code",
      args: ["/tmp/workspace"],
    });

    const zedLaunch = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        { platform: "darwin" },
      ),
    );
    assert.deepEqual(zedLaunch, {
      command: "zed",
      args: ["/tmp/workspace"],
    });
  });

  it("uses --goto when editor supports line/column suffixes", async () => {
    const lineOnly = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        { platform: "darwin" },
      ),
    );
    assert.deepEqual(lineOnly, {
      command: "cursor",
      args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
    });

    const lineAndColumn = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
        { platform: "darwin" },
      ),
    );
    assert.deepEqual(lineAndColumn, {
      command: "cursor",
      args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
    });

    const vscodeLineAndColumn = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" },
        { platform: "darwin" },
      ),
    );
    assert.deepEqual(vscodeLineAndColumn, {
      command: "code",
      args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
    });

    const zedLineAndColumn = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" },
        { platform: "darwin" },
      ),
    );
    assert.deepEqual(zedLineAndColumn, {
      command: "zed",
      args: ["/tmp/workspace/src/open.ts:71:5"],
    });
  });

  it("maps file-manager editor to OS open commands", async () => {
    const launch1 = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        { platform: "darwin" },
      ),
    );
    assert.deepEqual(launch1, {
      command: "open",
      args: ["/tmp/workspace"],
    });

    const launch2 = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        { platform: "win32" },
      ),
    );
    assert.deepEqual(launch2, {
      command: "explorer",
      args: ["C:\\workspace"],
    });

    const launch3 = await Effect.runPromise(
      resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        { platform: "linux" },
      ),
    );
    assert.deepEqual(launch3, {
      command: "xdg-open",
      args: ["/tmp/workspace"],
    });
  });

  it("prefers linux editor shims in wsl-hosted mode when available", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-wsl-linux-editor-"));
    try {
      fs.writeFileSync(path.join(dir, "code"), "#!/bin/sh\n", { mode: 0o755 });
      const launch = await Effect.runPromise(
        resolveEditorLaunch(
          { cwd: "/home/julius/project/src/open.ts:71:5", editor: "vscode" },
          {
            platform: "linux",
            runtimeEnvironment: {
              platform: "linux",
              pathStyle: "posix",
              isWsl: true,
              windowsInteropMode: "wsl-hosted",
              wslDistroName: "Ubuntu",
            },
            env: {
              PATH: dir,
            },
          },
        ),
      );
      assert.deepEqual(launch, {
        command: "code",
        args: ["--goto", "/home/julius/project/src/open.ts:71:5"],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to windows editor executables in wsl-hosted mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-wsl-win-editor-"));
    try {
      fs.writeFileSync(path.join(dir, "code.exe"), "MZ", { mode: 0o755 });
      const launch = await Effect.runPromise(
        resolveEditorLaunch(
          { cwd: "/home/julius/project/src/open.ts:71:5", editor: "vscode" },
          {
            platform: "linux",
            runtimeEnvironment: {
              platform: "linux",
              pathStyle: "posix",
              isWsl: true,
              windowsInteropMode: "wsl-hosted",
              wslDistroName: "Ubuntu",
            },
            env: {
              PATH: dir,
            },
            translateWslPathToWindows: (target) =>
              target.replace(
                "/home/julius/project",
                "\\\\wsl.localhost\\Ubuntu\\home\\julius\\project",
              ),
          },
        ),
      );
      assert.deepEqual(launch, {
        command: "code.exe",
        args: [
          "--goto",
          "\\\\wsl.localhost\\Ubuntu\\home\\julius\\project/src/open.ts:71:5",
        ],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("translates file-manager targets for wsl-hosted mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-wsl-file-manager-"));
    try {
      fs.writeFileSync(path.join(dir, "explorer.exe"), "MZ", { mode: 0o755 });
      const launch = await Effect.runPromise(
        resolveEditorLaunch(
          { cwd: "/home/julius/project/src/open.ts:71:5", editor: "file-manager" },
          {
            platform: "linux",
            runtimeEnvironment: {
              platform: "linux",
              pathStyle: "posix",
              isWsl: true,
              windowsInteropMode: "wsl-hosted",
              wslDistroName: "Ubuntu",
            },
            env: {
              PATH: dir,
            },
            translateWslPathToWindows: (target) =>
              target.replace(
                "/home/julius/project",
                "\\\\wsl.localhost\\Ubuntu\\home\\julius\\project",
              ),
          },
        ),
      );
      assert.deepEqual(launch, {
        command: "explorer.exe",
        args: ["\\\\wsl.localhost\\Ubuntu\\home\\julius\\project/src/open.ts"],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launchDetached", () => {
  it("resolves when command can be spawned", async () => {
    await expect(
      Effect.runPromise(
        launchDetached({
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects when command does not exist", async () => {
    const result = await Effect.runPromise(
      launchDetached({
        command: `t3code-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result),
    );
    assert.equal(result._tag, "Failure");
  });
});

describe("isCommandAvailable", () => {
  function withTempDir(run: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-"));
    try {
      run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("resolves win32 commands with PATHEXT", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "code.CMD"), "@echo off\r\n", "utf8");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    });
  });

  it("returns false when a command is not on PATH", () => {
    const env = {
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(isCommandAvailable("definitely-not-installed", { platform: "win32", env }), false);
  });

  it("does not treat bare files without executable extension as available on win32", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "npm"), "echo nope\r\n", "utf8");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("npm", { platform: "win32", env }), false);
    });
  });

  it("appends PATHEXT for commands with non-executable extensions on win32", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "my.tool.CMD"), "@echo off\r\n", "utf8");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("my.tool", { platform: "win32", env }), true);
    });
  });

  it("uses platform-specific PATH delimiter for platform overrides", () => {
    withTempDir((firstDir) => {
      withTempDir((secondDir) => {
        fs.writeFileSync(path.join(secondDir, "code.CMD"), "@echo off\r\n", "utf8");
        const env = {
          PATH: `${firstDir};${secondDir}`,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        } satisfies NodeJS.ProcessEnv;
        assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
      });
    });
  });
});

describe("resolveAvailableEditors", () => {
  it("returns only editors whose launch commands are available", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-editors-"));
    try {
      fs.writeFileSync(path.join(dir, "cursor.CMD"), "@echo off\r\n", "utf8");
      fs.writeFileSync(path.join(dir, "explorer.EXE"), "MZ", "utf8");
      const editors = resolveAvailableEditors({
        platform: "win32",
        env: {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      });
      assert.deepEqual(editors, ["cursor", "file-manager"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts windows editor executables in wsl-hosted mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-editors-wsl-"));
    try {
      fs.writeFileSync(path.join(dir, "code.exe"), "MZ", { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "explorer.exe"), "MZ", { mode: 0o755 });
      const editors = resolveAvailableEditors({
        platform: "linux",
        runtimeEnvironment: {
          platform: "linux",
          pathStyle: "posix",
          isWsl: true,
          windowsInteropMode: "wsl-hosted",
          wslDistroName: "Ubuntu",
        },
        env: {
          PATH: dir,
        },
      });
      assert.deepEqual(editors, ["vscode", "file-manager"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveBrowserLaunch", () => {
  it("prefers wslview in wsl-hosted mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-browser-wsl-"));
    try {
      fs.writeFileSync(path.join(dir, "wslview"), "#!/bin/sh\n", { mode: 0o755 });
      const launch = resolveBrowserLaunch("http://localhost:3773", {
        platform: "linux",
        runtimeEnvironment: {
          platform: "linux",
          pathStyle: "posix",
          isWsl: true,
          windowsInteropMode: "wsl-hosted",
          wslDistroName: "Ubuntu",
        },
        env: {
          PATH: dir,
        },
      });
      assert.deepEqual(launch, {
        command: "wslview",
        args: ["http://localhost:3773"],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to explorer.exe in wsl-hosted mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-browser-wsl-explorer-"));
    try {
      fs.writeFileSync(path.join(dir, "explorer.exe"), "MZ", { mode: 0o755 });
      const launch = resolveBrowserLaunch("http://localhost:3773", {
        platform: "linux",
        runtimeEnvironment: {
          platform: "linux",
          pathStyle: "posix",
          isWsl: true,
          windowsInteropMode: "wsl-hosted",
          wslDistroName: "Ubuntu",
        },
        env: {
          PATH: dir,
        },
      });
      assert.deepEqual(launch, {
        command: "explorer.exe",
        args: ["http://localhost:3773"],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
