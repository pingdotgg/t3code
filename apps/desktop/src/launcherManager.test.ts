import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getDesktopLauncherState, installDesktopLauncher } from "./launcherManager";

const TEMP_DIR_PREFIX = "t3-desktop-launcher-test-";

describe("launcherManager", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      FS.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function createTempDir(): string {
    tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), TEMP_DIR_PREFIX));
    return tempDir;
  }

  it("reports a missing launcher when t3 is unavailable", () => {
    const homeDir = createTempDir();
    const env: NodeJS.ProcessEnv = {
      PATH: "",
      SHELL: "/bin/zsh",
    };

    const state = getDesktopLauncherState({
      stateDir: Path.join(homeDir, "state"),
      executablePath: "/tmp/T3 Code",
      serverEntryPath: "/tmp/server/index.mjs",
      env,
      platform: "darwin",
      homeDir,
      shell: env.SHELL,
    });

    expect(state.status).toBe("missing");
    expect(state.installDir).toBe(Path.join(homeDir, ".t3", "bin"));
    expect(state.pathConfigured).toBe(false);
  });

  it("installs the managed launcher and keeps a needs-path status until PATH is updated", () => {
    const homeDir = createTempDir();
    const stateDir = Path.join(homeDir, "state");
    const env: NodeJS.ProcessEnv = {
      PATH: "",
      SHELL: "/bin/zsh",
    };

    const result = installDesktopLauncher({
      stateDir,
      executablePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      serverEntryPath:
        "/Applications/T3 Code.app/Contents/Resources/app/apps/server/dist/index.mjs",
      updatePath: false,
      env,
      platform: "darwin",
      homeDir,
      shell: env.SHELL,
    });

    expect(result.completed).toBe(true);
    expect(result.state.status).toBe("needs-path");
    expect(FS.existsSync(result.state.launcherPath)).toBe(true);
    expect(FS.statSync(result.state.launcherPath).mode & 0o111).not.toBe(0);
  });

  it("updates the shell profile and current PATH when the user allows PATH changes", () => {
    const homeDir = createTempDir();
    const stateDir = Path.join(homeDir, "state");
    const env: NodeJS.ProcessEnv = {
      PATH: "",
      SHELL: "/bin/zsh",
    };

    const execFileSync = vi.fn() as unknown as typeof import("node:child_process").execFileSync;
    const result = installDesktopLauncher({
      stateDir,
      executablePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      serverEntryPath:
        "/Applications/T3 Code.app/Contents/Resources/app/apps/server/dist/index.mjs",
      updatePath: true,
      env,
      platform: "darwin",
      homeDir,
      shell: env.SHELL,
      execFileSync,
    });

    expect(result.completed).toBe(true);
    expect(result.state.status).toBe("installed");
    expect(env.PATH?.startsWith(Path.join(homeDir, ".t3", "bin"))).toBe(true);
    expect(FS.readFileSync(Path.join(homeDir, ".zprofile"), "utf8")).toContain(
      'export PATH="',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("installs into an existing writable PATH directory when one is available", () => {
    const homeDir = createTempDir();
    const localBinDir = Path.join(homeDir, ".local", "bin");
    FS.mkdirSync(localBinDir, { recursive: true });
    const stateDir = Path.join(homeDir, "state");
    const env: NodeJS.ProcessEnv = {
      PATH: `${localBinDir}:/usr/local/bin`,
      SHELL: "/bin/zsh",
    };

    const result = installDesktopLauncher({
      stateDir,
      executablePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      serverEntryPath:
        "/Applications/T3 Code.app/Contents/Resources/app/apps/server/dist/index.mjs",
      updatePath: false,
      env,
      platform: "darwin",
      homeDir,
      shell: env.SHELL,
    });

    expect(result.completed).toBe(true);
    expect(result.state.status).toBe("installed");
    expect(result.state.launcherPath).toBe(Path.join(localBinDir, "t3"));
    const legacyLauncherPath = Path.join(homeDir, ".t3", "bin", "t3");
    expect(FS.existsSync(legacyLauncherPath)).toBe(true);
    expect(FS.readFileSync(legacyLauncherPath, "utf8")).toContain(
      `exec '${Path.join(localBinDir, "t3")}' "$@"`,
    );
  });
});
