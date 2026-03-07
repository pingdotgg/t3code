import { describe, expect, it } from "vitest";

import {
  parseWslWorkspacePath,
  resolveWindowsSpawnCwd,
  resolveWorkspaceCommandLaunch,
  resolveWorkspaceShellLaunch,
  toWslPath,
} from "./wsl";

describe("parseWslWorkspacePath", () => {
  it("parses \\\\wsl.localhost workspace paths", () => {
    expect(parseWslWorkspacePath("\\\\wsl.localhost\\Ubuntu\\home\\fazi\\project", "win32")).toEqual(
      {
        windowsPath: "\\\\wsl.localhost\\Ubuntu\\home\\fazi\\project",
        distribution: "Ubuntu",
        linuxPath: "/home/fazi/project",
      },
    );
  });

  it("parses \\\\wsl$ workspace paths", () => {
    expect(parseWslWorkspacePath("\\\\wsl$\\Arch\\repo", "win32")).toEqual({
      windowsPath: "\\\\wsl$\\Arch\\repo",
      distribution: "Arch",
      linuxPath: "/repo",
    });
  });

  it("returns null for non-wsl paths", () => {
    expect(parseWslWorkspacePath("C:\\repo", "win32")).toBeNull();
    expect(parseWslWorkspacePath("/home/fazi/repo", "linux")).toBeNull();
  });
});

describe("toWslPath", () => {
  it("converts drive-letter paths to /mnt paths", () => {
    expect(toWslPath("C:\\Users\\fazi\\.codex", { platform: "win32" })).toBe(
      "/mnt/c/Users/fazi/.codex",
    );
  });

  it("converts WSL UNC paths to linux paths", () => {
    expect(
      toWslPath("\\\\wsl.localhost\\Ubuntu\\tmp\\codex-schema.json", {
        platform: "win32",
        distribution: "Ubuntu",
      }),
    ).toBe("/tmp/codex-schema.json");
  });

  it("rejects WSL paths from a different distro", () => {
    expect(
      toWslPath("\\\\wsl.localhost\\Ubuntu\\tmp\\codex-schema.json", {
        platform: "win32",
        distribution: "Arch",
      }),
    ).toBeNull();
  });
});

describe("resolveWindowsSpawnCwd", () => {
  it("avoids WSL UNC cwd values", () => {
    expect(
      resolveWindowsSpawnCwd({
        platform: "win32",
        preferredCwd: "\\\\wsl.localhost\\Ubuntu\\home\\fazi\\project",
        processCwd: "\\\\wsl.localhost\\Ubuntu\\home\\fazi\\project",
        systemRoot: "C:\\Windows",
      }),
    ).toBe("C:\\Windows");
  });
});

describe("resolveWorkspaceCommandLaunch", () => {
  it("wraps workspace commands in wsl.exe for WSL workspaces", () => {
    expect(
      resolveWorkspaceCommandLaunch({
        platform: "win32",
        workspaceRoot: "\\\\wsl.localhost\\Ubuntu\\home\\fazi\\project",
        command: "codex",
        args: ["app-server"],
        systemRoot: "C:\\Windows",
      }),
    ).toEqual({
      command: "wsl.exe",
      args: [
        "--distribution",
        "Ubuntu",
        "--cd",
        "/home/fazi/project",
        "--exec",
        "codex",
        "app-server",
      ],
      cwd: "C:\\Windows",
      workspace: {
        windowsPath: "\\\\wsl.localhost\\Ubuntu\\home\\fazi\\project",
        distribution: "Ubuntu",
        linuxPath: "/home/fazi/project",
      },
    });
  });

  it("translates absolute Windows command paths for WSL launches", () => {
    expect(
      resolveWorkspaceCommandLaunch({
        platform: "win32",
        workspaceRoot: "\\\\wsl$\\Ubuntu\\home\\fazi\\project",
        command: "C:\\Tools\\codex.exe",
        args: ["app-server"],
        systemRoot: "C:\\Windows",
      }),
    ).toEqual(
      expect.objectContaining({
        args: [
          "--distribution",
          "Ubuntu",
          "--cd",
          "/home/fazi/project",
          "--exec",
          "/mnt/c/Tools/codex.exe",
          "app-server",
        ],
      }),
    );
  });
});

describe("resolveWorkspaceShellLaunch", () => {
  it("starts an interactive WSL shell in the workspace distro and cwd", () => {
    expect(
      resolveWorkspaceShellLaunch({
        platform: "win32",
        workspaceRoot: "\\\\wsl.localhost\\Ubuntu\\home\\fazi\\project",
        systemRoot: "C:\\Windows",
      }),
    ).toEqual({
      command: "wsl.exe",
      args: ["--distribution", "Ubuntu", "--cd", "/home/fazi/project"],
      cwd: "C:\\Windows",
      workspace: {
        windowsPath: "\\\\wsl.localhost\\Ubuntu\\home\\fazi\\project",
        distribution: "Ubuntu",
        linuxPath: "/home/fazi/project",
      },
    });
  });
});
