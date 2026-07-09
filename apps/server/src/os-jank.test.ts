import { describe, expect, it, vi } from "vite-plus/test";

import { hydratePosixProcessEnvironment, hydratePosixProviderAuthEnvironment } from "./os-jank.ts";

describe("hydratePosixProviderAuthEnvironment", () => {
  it("hydrates missing Sakana API key from captured shell environment", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    hydratePosixProviderAuthEnvironment(env, { SAKANA_API_KEY: "sk-sakana-test" });

    expect(env.SAKANA_API_KEY).toBe("sk-sakana-test");
  });

  it("preserves an inherited Sakana API key", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SAKANA_API_KEY: "already-present",
    };
    hydratePosixProviderAuthEnvironment(env, { SAKANA_API_KEY: "from-shell" });

    expect(env.SAKANA_API_KEY).toBe("already-present");
  });
});

describe("hydratePosixProcessEnvironment", () => {
  it("captures PATH and Sakana API key in one login shell probe", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/local/bin",
      SAKANA_API_KEY: "sk-sakana-test",
    }));

    hydratePosixProcessEnvironment(env, "darwin", {
      readEnvironment,
      shellCandidates: ["/bin/zsh"],
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
    expect(env.SAKANA_API_KEY).toBe("sk-sakana-test");
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", ["PATH", "SAKANA_API_KEY"]);
  });

  it("preserves inherited Sakana API key while hydrating PATH", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SAKANA_API_KEY: "already-present",
    };
    const readEnvironment = vi.fn(() => ({ PATH: "/opt/homebrew/bin" }));

    hydratePosixProcessEnvironment(env, "darwin", {
      readEnvironment,
      shellCandidates: ["/bin/zsh"],
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SAKANA_API_KEY).toBe("already-present");
    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", ["PATH"]);
  });

  it("ignores non-posix platforms", () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32" };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin",
      SAKANA_API_KEY: "from-shell",
    }));

    hydratePosixProcessEnvironment(env, "win32", {
      readEnvironment,
      shellCandidates: ["powershell.exe"],
    });

    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(env.SAKANA_API_KEY).toBeUndefined();
    expect(readEnvironment).not.toHaveBeenCalled();
  });
});
