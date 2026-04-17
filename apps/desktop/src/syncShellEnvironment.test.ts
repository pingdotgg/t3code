import { describe, expect, it, vi } from "vitest";

import { syncShellEnvironment } from "./syncShellEnvironment.ts";

describe("syncShellEnvironment", () => {
  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/Users/test/.local/bin:/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
      HOMEBREW_PREFIX: "/opt/homebrew",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", [
      "PATH",
      "SSH_AUTH_SOCK",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
    expect(env.HOMEBREW_PREFIX).toBe("/opt/homebrew");
  });

  it("preserves an inherited SSH_AUTH_SOCK value", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/login-shell.sock",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("preserves inherited values when the login shell omits them", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on linux", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "linux",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", [
      "PATH",
      "SSH_AUTH_SOCK",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    expect(env.PATH).toBe("/home/linuxbrew/.linuxbrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });

  it("falls back to launchctl PATH on macOS when shell probing does not return one", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/opt/homebrew/bin/nu",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("unknown flag");
      })
      .mockImplementationOnce(() => ({}));
    const readLaunchctlPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");
    const logWarning = vi.fn();

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      logWarning,
    });

    expect(readEnvironment).toHaveBeenNthCalledWith(1, "/opt/homebrew/bin/nu", [
      "PATH",
      "SSH_AUTH_SOCK",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    expect(readEnvironment).toHaveBeenNthCalledWith(2, "/bin/zsh", [
      "PATH",
      "SSH_AUTH_SOCK",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to read login shell environment from /opt/homebrew/bin/nu.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("does nothing on unsupported platforms", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/local/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "freebsd",
      readEnvironment,
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("hydrates PATH on Windows by merging PowerShell PATH with inherited PATH", () => {
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

    syncShellEnvironment(env, {
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
    expect(isWindowsCommandAvailable).toHaveBeenCalledTimes(1);
  });

  it("loads the PowerShell profile on Windows when node is not available", () => {
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

    syncShellEnvironment(env, {
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
    expect(readWindowsEnvironment).toHaveBeenNthCalledWith(1, ["PATH"], { loadProfile: false });
    expect(readWindowsEnvironment).toHaveBeenNthCalledWith(
      2,
      ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"],
      { loadProfile: true },
    );
  });

  it("preserves baseline Windows env when the profile probe fails", () => {
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

    syncShellEnvironment(env, {
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
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });
});
