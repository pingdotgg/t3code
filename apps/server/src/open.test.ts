import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  isCommandAvailable,
  launchDetached,
  resolveAvailableEditors,
  resolveEditorLaunch,
} from "./open";
import { Effect } from "effect";
import { assertSuccess } from "@effect/vitest/utils";

describe("resolveEditorLaunch", () => {
  function withTempDirEnv(
    files: ReadonlyArray<{ name: string; contents: string; mode?: number }>,
    run: (env: NodeJS.ProcessEnv) => void,
  ): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-launch-"));
    try {
      for (const file of files) {
        fs.writeFileSync(path.join(dir, file.name), file.contents, {
          mode: file.mode ?? 0o755,
        });
      }
      run({ PATH: dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      yield* Effect.sync(() =>
        withTempDirEnv([{ name: "code", contents: "#!/bin/sh\nexit 0\n" }], (env) => {
          assert.deepEqual(
            Effect.runSync(resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "vscode" }, "darwin", env)),
            { command: "code", args: ["/tmp/workspace"] },
          );
        }),
      );

      yield* Effect.sync(() =>
        withTempDirEnv([{ name: "zed", contents: "#!/bin/sh\nexit 0\n" }], (env) => {
          assert.deepEqual(
            Effect.runSync(resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "zed" }, "darwin", env)),
            { command: "zed", args: ["/tmp/workspace"] },
          );
        }),
      );
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

      yield* Effect.sync(() =>
        withTempDirEnv([{ name: "code", contents: "#!/bin/sh\nexit 0\n" }], (env) => {
          assert.deepEqual(
            Effect.runSync(
              resolveEditorLaunch({ cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" }, "darwin", env),
            ),
            { command: "code", args: ["--goto", "/tmp/workspace/src/open.ts:71:5"] },
          );
        }),
      );

      yield* Effect.sync(() =>
        withTempDirEnv([{ name: "zed", contents: "#!/bin/sh\nexit 0\n" }], (env) => {
          assert.deepEqual(
            Effect.runSync(
              resolveEditorLaunch({ cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" }, "darwin", env),
            ),
            { command: "zed", args: ["/tmp/workspace/src/open.ts:71:5"] },
          );
        }),
      );
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.sync(() => {
      withTempDirEnv([{ name: "open", contents: "#!/bin/sh\nexit 0\n" }], (env) => {
        assert.deepEqual(
          Effect.runSync(resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "file-manager" }, "darwin", env)),
          { command: "open", args: ["/tmp/workspace"] },
        );
      });
      withTempDirEnv([{ name: "explorer.EXE", contents: "MZ", mode: 0o755 }], (env) => {
        assert.deepEqual(
          Effect.runSync(
            resolveEditorLaunch(
              { cwd: "C:\\workspace", editor: "file-manager" },
              "win32",
              { ...env, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
            ),
          ),
          { command: "explorer", args: ["C:\\workspace"] },
        );
      });
      withTempDirEnv([{ name: "xdg-open", contents: "#!/bin/sh\nexit 0\n" }], (env) => {
        assert.deepEqual(
          Effect.runSync(resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "file-manager" }, "linux", env)),
          { command: "xdg-open", args: ["/tmp/workspace"] },
        );
      });
    }),
  );

  it.effect("falls back to the file manager when the requested editor is not on PATH", () =>
    Effect.sync(() => {
      withTempDirEnv([{ name: "xdg-open", contents: "#!/bin/sh\nexit 0\n" }], (env) =>
        assert.deepEqual(
          Effect.runSync(
            resolveEditorLaunch({ cwd: "/tmp/keybindings.json", editor: "cursor" }, "linux", env),
          ),
          { command: "xdg-open", args: ["/tmp/keybindings.json"] },
        ),
      );
    }),
  );

  it.effect("strips line and column when falling back to the file manager", () =>
    Effect.sync(() => {
      withTempDirEnv([{ name: "xdg-open", contents: "#!/bin/sh\nexit 0\n" }], (env) => {
        const launch = Effect.runSync(
          resolveEditorLaunch({ cwd: "/tmp/src/open.ts:71:5", editor: "cursor" }, "linux", env),
        );
        assert.deepEqual(launch, {
          command: "xdg-open",
          args: ["/tmp/src/open.ts"],
        });
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
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, ["cursor", "file-manager"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
