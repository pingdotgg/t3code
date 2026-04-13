import { describe, expect, it, vi } from "vitest";

import { fixPath } from "./os-jank";

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

  it("does nothing outside macOS and linux even when SHELL is set", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
    };
    const readPath = vi.fn(() => "/usr/local/bin:/usr/bin");

    fixPath({
      env,
      platform: "win32",
      readPath,
    });

    expect(readPath).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });
});
