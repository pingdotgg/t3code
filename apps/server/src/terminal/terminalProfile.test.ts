import { describe, expect, it } from "vitest";

import {
  discoverTerminalShells,
  discoverWindowsTerminalShells,
  resolveTerminalShellSpawnConfig,
  type TerminalShellPathProbe,
} from "./terminalProfile";

const rejectingCmdProbe: TerminalShellPathProbe = async (candidate) => {
  if (candidate === "C:\\Windows\\System32\\cmd.exe") {
    throw new Error("permission denied");
  }
  return false;
};

describe("resolveTerminalShellSpawnConfig", () => {
  it("uses the explicit custom shell profile when one is configured", () => {
    const result = resolveTerminalShellSpawnConfig({
      platform: "darwin",
      processEnv: { SHELL: "/bin/bash" },
      shellResolver: () => "/bin/bash",
      profile: {
        shellPath: "/bin/zsh",
        shellArgs: ["-f", " "],
        env: {
          ZDOTDIR: "/tmp/t3code-zdotdir",
          " PATH ": "/custom/bin",
        },
      },
    });

    expect(result.shellCandidates).toEqual([{ shell: "/bin/zsh", args: ["-f"] }]);
    expect(result.profileEnv).toEqual({
      PATH: "/custom/bin",
      ZDOTDIR: "/tmp/t3code-zdotdir",
    });
  });

  it("preserves the existing fallback order when no custom shell path is configured", () => {
    const result = resolveTerminalShellSpawnConfig({
      platform: "darwin",
      processEnv: { SHELL: "/bin/bash" },
      shellResolver: () => "/bin/bash",
      profile: {
        shellPath: "",
        shellArgs: [],
        env: {},
      },
    });

    expect(result.shellCandidates.slice(0, 4)).toEqual([
      { shell: "/bin/bash" },
      { shell: "/bin/zsh", args: ["-o", "nopromptsp"] },
      { shell: "/bin/sh" },
      { shell: "zsh", args: ["-o", "nopromptsp"] },
    ]);
  });

  it("applies custom shell args to the first fallback shell when no shell path is set", () => {
    const result = resolveTerminalShellSpawnConfig({
      platform: "win32",
      processEnv: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      shellResolver: () => "powershell.exe",
      profile: {
        shellPath: "",
        shellArgs: ["-NoLogo", "-NoProfile"],
        env: {},
      },
    });

    expect(result.shellCandidates[0]).toEqual({
      shell: "powershell.exe",
      args: ["-NoLogo", "-NoProfile"],
    });
    expect(result.shellCandidates[1]).toEqual({
      shell: "C:\\Windows\\System32\\cmd.exe",
    });
  });
});

describe("discoverWindowsTerminalShells", () => {
  it("reports common Windows shell availability for future preset UX", async () => {
    const existingPaths = new Set([
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Windows\\System32\\wsl.exe",
    ]);
    const probe: TerminalShellPathProbe = async (candidate) => existingPaths.has(candidate);

    const result = await discoverWindowsTerminalShells({
      env: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        SystemRoot: "C:\\Windows",
      },
      probe,
    });

    expect(result.cmd).toEqual({
      available: true,
      path: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(result.powershell).toEqual({
      available: false,
      path: null,
    });
    expect(result.gitBash).toEqual({
      available: true,
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    expect(result.wsl).toEqual({
      available: true,
      path: "C:\\Windows\\System32\\wsl.exe",
    });
  });
});

describe("discoverTerminalShells", () => {
  it("returns an empty discovery list on non-Windows platforms", async () => {
    let probeCalls = 0;
    const result = await discoverTerminalShells({
      platform: "darwin",
      env: {},
      probe: async () => {
        probeCalls += 1;
        return false;
      },
    });

    expect(result).toEqual({
      platform: "darwin",
      currentShell: "bash",
      discoveredShells: [],
    });
    expect(probeCalls).toBe(0);
  });

  it("maps Windows shell discovery into stable server config entries", async () => {
    const existingPaths = new Set([
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Windows\\System32\\wsl.exe",
    ]);
    const probe: TerminalShellPathProbe = async (candidate) => existingPaths.has(candidate);

    const result = await discoverTerminalShells({
      platform: "win32",
      env: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        SystemRoot: "C:\\Windows",
      },
      probe,
    });

    expect(result).toEqual({
      platform: "win32",
      currentShell: "C:\\Windows\\System32\\cmd.exe",
      discoveredShells: [
        {
          id: "powershell",
          label: "PowerShell",
          available: true,
          path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        },
        {
          id: "cmd",
          label: "Command Prompt",
          available: true,
          path: "C:\\Windows\\System32\\cmd.exe",
        },
        {
          id: "gitBash",
          label: "Git Bash",
          available: true,
          path: "C:\\Program Files\\Git\\bin\\bash.exe",
        },
        {
          id: "wsl",
          label: "WSL",
          available: true,
          path: "C:\\Windows\\System32\\wsl.exe",
        },
      ],
    });
  });

  it("treats probe failures as unavailable shells instead of failing discovery", async () => {
    const result = await discoverTerminalShells({
      platform: "win32",
      env: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        SystemRoot: "C:\\Windows",
      },
      probe: rejectingCmdProbe,
    });

    expect(result).toEqual({
      platform: "win32",
      currentShell: "C:\\Windows\\System32\\cmd.exe",
      discoveredShells: [
        {
          id: "powershell",
          label: "PowerShell",
          available: false,
          path: null,
        },
        {
          id: "cmd",
          label: "Command Prompt",
          available: false,
          path: null,
        },
        {
          id: "gitBash",
          label: "Git Bash",
          available: false,
          path: null,
        },
        {
          id: "wsl",
          label: "WSL",
          available: false,
          path: null,
        },
      ],
    });
  });
});
