import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  isCommandAvailable,
  launchDetached,
  normalizeWindowsExecutablePath,
  resolveAvailableEditors,
  resolveEditorLaunch,
} from "./open";
import { Effect } from "effect";
import { assertSuccess } from "@effect/vitest/utils";

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveEditorLaunch", () => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      withTempDir((dir) => {
        const agyPath = path.join(dir, "agy");
        fs.writeFileSync(agyPath, "#!/bin/sh\nexit 0\n", "utf8");
        fs.chmodSync(agyPath, 0o755);
        const env = {
          PATH: dir,
        } satisfies NodeJS.ProcessEnv;

        const antigravityLaunch = Effect.runSync(
          resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "antigravity" }, "darwin", env),
        );
        assert.deepEqual(antigravityLaunch, {
          command: "agy",
          args: ["/tmp/workspace"],
        });
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

  it.effect("falls back to the Antigravity app bundle on macOS", () =>
    Effect.sync(() => {
      withTempDir((dir) => {
        const env = {
          HOME: dir,
          PATH: "",
        } satisfies NodeJS.ProcessEnv;
        fs.mkdirSync(path.join(dir, "Applications", "Antigravity.app"), { recursive: true });

        const launch = Effect.runSync(
          resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "antigravity" }, "darwin", env),
        );
        assert.deepEqual(launch, {
          command: "open",
          args: ["-b", "com.google.antigravity", "/tmp/workspace"],
        });
      });
    }),
  );

  it.effect("falls back to the Antigravity executable on Windows", () =>
    Effect.sync(() => {
      withTempDir((dir) => {
        const exePath = path.join(dir, "Programs", "Antigravity", "Antigravity.exe");
        fs.mkdirSync(path.dirname(exePath), { recursive: true });
        fs.writeFileSync(exePath, "MZ", "utf8");
        const env = {
          PATH: "",
          LOCALAPPDATA: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        } satisfies NodeJS.ProcessEnv;

        const launch = Effect.runSync(
          resolveEditorLaunch({ cwd: "C:\\workspace", editor: "antigravity" }, "win32", env),
        );
        assert.deepEqual(launch, {
          command: exePath,
          args: ["C:\\workspace"],
        });
      });
    }),
  );

  it.effect("falls back to the Antigravity launcher on Linux", () =>
    Effect.sync(() => {
      withTempDir((dir) => {
        const launcherPath = path.join(dir, "antigravity");
        fs.writeFileSync(launcherPath, "#!/bin/sh\nexit 0\n", "utf8");
        fs.chmodSync(launcherPath, 0o755);
        const env = {
          PATH: dir,
        } satisfies NodeJS.ProcessEnv;

        const launch = Effect.runSync(
          resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "antigravity" }, "linux", env),
        );
        assert.deepEqual(launch, {
          command: "antigravity",
          args: ["/tmp/workspace"],
        });
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

describe("launchDetached", () => {
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

describe("isCommandAvailable", () => {
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

describe("normalizeWindowsExecutablePath", () => {
  it("parses quoted DisplayIcon values with a trailing index", () => {
    withTempDir((dir) => {
      const executablePath = path.join(dir, "Antigravity.exe");
      fs.writeFileSync(executablePath, "MZ", "utf8");
      const env = {
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;

      assert.equal(
        normalizeWindowsExecutablePath(`"${executablePath}",0`, env),
        executablePath,
      );
    });
  });
});

describe("resolveAvailableEditors", () => {
  it("returns Antigravity when the app bundle exists on macOS", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-editors-"));
    try {
      fs.mkdirSync(path.join(dir, "Applications", "Antigravity.app"), { recursive: true });
      fs.writeFileSync(path.join(dir, "cursor"), "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(path.join(dir, "cursor"), 0o755);
      fs.writeFileSync(path.join(dir, "open"), "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(path.join(dir, "open"), 0o755);
      const editors = resolveAvailableEditors("darwin", {
        HOME: dir,
        PATH: dir,
      });
      assert.deepEqual(editors, ["cursor", "antigravity", "file-manager"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns installed editors for Windows app and command launches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-editors-"));
    try {
      fs.writeFileSync(path.join(dir, "cursor.CMD"), "@echo off\r\n", "utf8");
      fs.writeFileSync(path.join(dir, "explorer.EXE"), "MZ", "utf8");
      const exePath = path.join(dir, "Programs", "Antigravity", "Antigravity.exe");
      fs.mkdirSync(path.dirname(exePath), { recursive: true });
      fs.writeFileSync(exePath, "MZ", "utf8");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        LOCALAPPDATA: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, ["cursor", "antigravity", "file-manager"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns installed editors for Linux command launches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-editors-"));
    try {
      fs.writeFileSync(path.join(dir, "cursor"), "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(path.join(dir, "cursor"), 0o755);
      fs.writeFileSync(path.join(dir, "antigravity"), "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(path.join(dir, "antigravity"), 0o755);
      fs.writeFileSync(path.join(dir, "xdg-open"), "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(path.join(dir, "xdg-open"), 0o755);
      const editors = resolveAvailableEditors("linux", {
        PATH: dir,
      });
      assert.deepEqual(editors, ["cursor", "antigravity", "file-manager"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
