// @effect-diagnostics nodeBuiltinImport:off - verifies environment enumeration through a real Node child process.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        "linux",
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("reads current inherited values after the provider environment is created", () => {
    const hostEnvironment: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
    };
    const providerEnvironment = mergeProviderInstanceEnvironment(
      [{ name: "CODEX_HOME", value: "C:\\Users\\tester\\.codex-work", sensitive: false }],
      "win32",
      hostEnvironment,
    );

    hostEnvironment.PATH = "C:\\NewCli;C:\\Windows\\System32";
    hostEnvironment.FNM_DIR = "C:\\Users\\tester\\AppData\\Roaming\\fnm";

    expect(providerEnvironment.PATH).toBe("C:\\NewCli;C:\\Windows\\System32");
    expect(providerEnvironment.FNM_DIR).toBe("C:\\Users\\tester\\AppData\\Roaming\\fnm");
    expect(providerEnvironment.CODEX_HOME).toBe("C:\\Users\\tester\\.codex-work");
    expect({ ...providerEnvironment }).toMatchObject({
      PATH: "C:\\NewCli;C:\\Windows\\System32",
      FNM_DIR: "C:\\Users\\tester\\AppData\\Roaming\\fnm",
      CODEX_HOME: "C:\\Users\\tester\\.codex-work",
    });

    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({ PATH: process.env.PATH, FNM_DIR: process.env.FNM_DIR, CODEX_HOME: process.env.CODEX_HOME }))",
      ],
      { encoding: "utf8", env: providerEnvironment },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      PATH: "C:\\NewCli;C:\\Windows\\System32",
      FNM_DIR: "C:\\Users\\tester\\AppData\\Roaming\\fnm",
      CODEX_HOME: "C:\\Users\\tester\\.codex-work",
    });
  });

  it("normalizes explicit Windows overrides and keeps them authoritative", () => {
    const hostEnvironment: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
    };
    const providerEnvironment = mergeProviderInstanceEnvironment(
      [
        { name: "Path", value: "C:\\PinnedCli", sensitive: false },
        { name: "anthropic_api_key", value: "provider-key", sensitive: true },
      ],
      "win32",
      { ...hostEnvironment, ANTHROPIC_API_KEY: "inherited-key" },
    );

    hostEnvironment.PATH = "C:\\NewCli;C:\\Windows\\System32";

    expect(providerEnvironment.PATH).toBe("C:\\PinnedCli");
    expect(providerEnvironment.ANTHROPIC_API_KEY).toBe("provider-key");
    expect(
      Object.keys(providerEnvironment).filter((name) =>
        ["path", "anthropic_api_key"].includes(name.toLowerCase()),
      ),
    ).toEqual(["PATH", "ANTHROPIC_API_KEY"]);
  });
});
