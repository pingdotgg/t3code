import { describe, expect, it, vi } from "vite-plus/test";

import { hydratePosixProviderAuthEnvironment } from "./os-jank.ts";

describe("hydratePosixProviderAuthEnvironment", () => {
  it("hydrates missing Sakana API key from the login shell", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const readEnvironment = vi.fn(() => ({ SAKANA_API_KEY: "sk-sakana-test" }));

    hydratePosixProviderAuthEnvironment(env, "darwin", {
      readEnvironment,
      shellCandidates: ["/bin/zsh"],
    });

    expect(env.SAKANA_API_KEY).toBe("sk-sakana-test");
    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", ["SAKANA_API_KEY"]);
  });

  it("preserves an inherited Sakana API key without shell probing", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SAKANA_API_KEY: "already-present",
    };
    const readEnvironment = vi.fn(() => ({ SAKANA_API_KEY: "from-shell" }));

    hydratePosixProviderAuthEnvironment(env, "darwin", {
      readEnvironment,
      shellCandidates: ["/bin/zsh"],
    });

    expect(env.SAKANA_API_KEY).toBe("already-present");
    expect(readEnvironment).not.toHaveBeenCalled();
  });

  it("ignores non-posix platforms", () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32" };
    const readEnvironment = vi.fn(() => ({ SAKANA_API_KEY: "from-shell" }));

    hydratePosixProviderAuthEnvironment(env, "win32", {
      readEnvironment,
      shellCandidates: ["powershell.exe"],
    });

    expect(env.SAKANA_API_KEY).toBeUndefined();
    expect(readEnvironment).not.toHaveBeenCalled();
  });
});
