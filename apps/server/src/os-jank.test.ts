import { describe, expect, it, vi } from "vitest";

import { fixPath } from "./os-jank.ts";

describe("fixPath", () => {
  it("hydrates PATH on linux using the resolved login shell", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/Users/test/.local/bin:/usr/bin",
    };
    const readPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");

    fixPath({
      env,
      platform: "linux",
      readPath,
    });

    expect(readPath).toHaveBeenCalledWith("/bin/zsh");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("falls back to launchctl PATH on macOS when shell probing fails", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/opt/homebrew/bin/nu",
      PATH: "/usr/bin",
    };
    const readPath = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("unknown flag");
      })
      .mockImplementationOnce(() => undefined);
    const readLaunchctlPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");
    const logWarning = vi.fn();

    fixPath({
      env,
      platform: "darwin",
      readPath,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      logWarning,
    });

    expect(readPath).toHaveBeenNthCalledWith(1, "/opt/homebrew/bin/nu");
    expect(readPath).toHaveBeenNthCalledWith(2, "/bin/zsh");
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to read PATH from login shell /opt/homebrew/bin/nu.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("repairs PATH on Windows by merging PowerShell PATH with inherited PATH", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
      USERPROFILE: "C:\\Users\\testuser",
    };
    const readWindowsEnvironment = vi.fn(() => ({
      PATH: "C:\\Custom\\Bin;C:\\Windows\\System32",
    }));
    const isWindowsCommandAvailable = vi.fn(() => true);

    fixPath({
      env,
      platform: "win32",
      readWindowsEnvironment,
      isWindowsCommandAvailable,
    });

    expect(readWindowsEnvironment).toHaveBeenCalledWith(["PATH"], { loadProfile: false });
    expect(env.PATH).toBe(
      [
        "C:\\Users\\testuser\\AppData\\Roaming\\npm",
        "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
        "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
        "C:\\Users\\testuser\\AppData\\Local\\pnpm",
        "C:\\Users\\testuser\\.bun\\bin",
        "C:\\Users\\testuser\\scoop\\shims",
        "C:\\Custom\\Bin",
        "C:\\Windows\\System32",
      ].join(";"),
    );
  });

  it("applies profile-derived fnm variables on Windows when node is missing", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
      USERPROFILE: "C:\\Users\\testuser",
    };
    const readWindowsEnvironment = vi.fn(
      (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
        options?.loadProfile
          ? {
              PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
              FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
              FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
            }
          : { PATH: "C:\\Custom\\Bin;C:\\Windows\\System32" },
    );
    const isWindowsCommandAvailable = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    fixPath({
      env,
      platform: "win32",
      readWindowsEnvironment,
      isWindowsCommandAvailable,
    });

    expect(env.PATH).toBe(
      [
        "C:\\Profile\\Node",
        "C:\\Windows\\System32",
        "C:\\Users\\testuser\\AppData\\Roaming\\npm",
        "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
        "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
        "C:\\Users\\testuser\\AppData\\Local\\pnpm",
        "C:\\Users\\testuser\\.bun\\bin",
        "C:\\Users\\testuser\\scoop\\shims",
        "C:\\Custom\\Bin",
      ].join(";"),
    );
    expect(env.FNM_DIR).toBe("C:\\Users\\testuser\\AppData\\Roaming\\fnm");
    expect(env.FNM_MULTISHELL_PATH).toBe(
      "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
    );
  });

  it("preserves baseline PATH on Windows when the profile probe fails", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\testuser",
    };
    const readWindowsEnvironment = vi.fn(
      (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) => {
        if (options?.loadProfile) {
          throw new Error("profile load failed");
        }
        return { PATH: "C:\\Custom\\Bin;C:\\Windows\\System32" };
      },
    );
    const isWindowsCommandAvailable = vi.fn(() => false);

    fixPath({
      env,
      platform: "win32",
      readWindowsEnvironment,
      isWindowsCommandAvailable,
    });

    expect(env.PATH).toBe(
      [
        "C:\\Users\\testuser\\AppData\\Roaming\\npm",
        "C:\\Users\\testuser\\.bun\\bin",
        "C:\\Users\\testuser\\scoop\\shims",
        "C:\\Custom\\Bin",
        "C:\\Windows\\System32",
      ].join(";"),
    );
  });

  it("does nothing on unsupported platforms", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
    };
    const readPath = vi.fn(() => "/usr/local/bin:/usr/bin");

    fixPath({
      env,
      platform: "freebsd",
      readPath,
    });

    expect(readPath).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });
});
