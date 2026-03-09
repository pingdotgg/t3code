import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPathExportSnippet,
  hasManagedPathSnippet,
  parseDesktopLauncherMetadata,
  readDesktopLauncherMetadata,
  resolveCompatibilityLauncherPaths,
  resolveLegacyManagedLauncherPath,
  resolveManagedLauncherBinDir,
  resolveManagedLauncherPath,
  resolveShellProfilePath,
  writeDesktopLauncherMetadata,
} from "./launcher";

const TEMP_DIR_PREFIX = "t3-shared-launcher-test-";

describe("launcher metadata", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      FS.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("parses valid desktop launcher metadata", () => {
    expect(
      parseDesktopLauncherMetadata(
        JSON.stringify({
          version: 1,
          executablePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
          serverEntryPath: "/Applications/T3 Code.app/Contents/Resources/app/apps/server/dist/index.mjs",
          updatedAt: "2026-03-08T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      version: 1,
      executablePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      serverEntryPath:
        "/Applications/T3 Code.app/Contents/Resources/app/apps/server/dist/index.mjs",
      updatedAt: "2026-03-08T00:00:00.000Z",
    });
  });

  it("writes and reads launcher metadata from disk", () => {
    tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), TEMP_DIR_PREFIX));

    writeDesktopLauncherMetadata(
      {
        version: 1,
        executablePath: "/tmp/T3 Code",
        serverEntryPath: "/tmp/server/index.mjs",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
      tempDir,
    );

    expect(readDesktopLauncherMetadata(tempDir)).toEqual({
      version: 1,
      executablePath: "/tmp/T3 Code",
      serverEntryPath: "/tmp/server/index.mjs",
      updatedAt: "2026-03-08T00:00:00.000Z",
    });
  });
});

describe("managed launcher paths", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      FS.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("uses a user-scoped bin directory on POSIX systems", () => {
    expect(
      resolveManagedLauncherBinDir({
        platform: "darwin",
        env: { PATH: "" },
        homeDir: "/Users/example",
      }),
    ).toBe("/Users/example/.t3/bin");
    expect(
      resolveManagedLauncherPath({
        platform: "darwin",
        env: { PATH: "" },
        homeDir: "/Users/example",
      }),
    ).toBe("/Users/example/.t3/bin/t3");
  });

  it("prefers an existing writable PATH directory on POSIX systems", () => {
    tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), TEMP_DIR_PREFIX));
    const localBinDir = Path.join(tempDir, ".local", "bin");
    FS.mkdirSync(localBinDir, { recursive: true });

    expect(
      resolveManagedLauncherBinDir({
        platform: "darwin",
        env: { PATH: `${localBinDir}:/usr/local/bin` },
        homeDir: tempDir,
      }),
    ).toBe(localBinDir);
    expect(
      resolveLegacyManagedLauncherPath({
        platform: "darwin",
        env: { PATH: `${localBinDir}:/usr/local/bin` },
        homeDir: tempDir,
      }),
    ).toBe(Path.join(tempDir, ".t3", "bin", "t3"));
    expect(
      resolveCompatibilityLauncherPaths({
        platform: "darwin",
        env: { PATH: `${localBinDir}:/usr/local/bin` },
        homeDir: tempDir,
      }),
    ).toEqual([Path.join(tempDir, ".t3", "bin", "t3")]);
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      resolveManagedLauncherBinDir({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" },
        homeDir: "C:\\Users\\example",
      }),
    ).toBe("C:\\Users\\example\\AppData\\Local\\T3Code\\bin");
    expect(
      resolveManagedLauncherPath({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" },
        homeDir: "C:\\Users\\example",
      }),
    ).toBe("C:\\Users\\example\\AppData\\Local\\T3Code\\bin\\t3.cmd");
  });
});

describe("shell profile helpers", () => {
  it("targets the current shell profile and renders a reusable PATH snippet", () => {
    const profilePath = resolveShellProfilePath({
      platform: "darwin",
      shell: "/bin/zsh",
      homeDir: "/Users/example",
    });

    expect(profilePath).toBe("/Users/example/.zprofile");
    expect(
      buildPathExportSnippet("/Users/example/.t3/bin", {
        platform: "darwin",
        shell: "/bin/zsh",
        homeDir: "/Users/example",
      }),
    ).toContain('export PATH="/Users/example/.t3/bin:$PATH"');
  });

  it("uses fish_add_path for fish shells and recognizes existing managed snippets", () => {
    const snippet = buildPathExportSnippet("/home/example/.t3/bin", {
      platform: "linux",
      shell: "/usr/bin/fish",
      homeDir: "/home/example",
    });

    expect(snippet).toContain('fish_add_path -m "/home/example/.t3/bin"');
    expect(hasManagedPathSnippet(snippet)).toBe(true);
  });
});
