import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEV_STATE_DIR,
  createDevRunnerEnv,
  parseDevRunnerArgs,
} from "./dev-runner.mjs";

describe("parseDevRunnerArgs", () => {
  it("maps supported server flags to env overrides and keeps other flags for turbo", () => {
    const parsed = parseDevRunnerArgs([
      "--",
      "--state-dir",
      "~/alt-state",
      "--token=abc123",
      "--no-browser=false",
      "--dry-run",
      "--continue",
    ]);

    expect(parsed.isDryRun).toBe(true);
    expect(parsed.envOverrides).toEqual({
      T3CODE_STATE_DIR: "~/alt-state",
      T3CODE_AUTH_TOKEN: "abc123",
      T3CODE_NO_BROWSER: "0",
    });
    expect(parsed.turboArgs).toEqual(["--continue"]);
  });

  it("throws when a value flag is missing its value", () => {
    expect(() => parseDevRunnerArgs(["--state-dir"])).toThrow("Missing value for --state-dir");
  });

  it("throws when a value flag is followed by another flag token", () => {
    expect(() => parseDevRunnerArgs(["--state-dir", "--continue"])).toThrow(
      "Missing value for --state-dir",
    );
  });
});

describe("createDevRunnerEnv", () => {
  it("defaults state dir to ~/.t3/dev when not provided", () => {
    const env = createDevRunnerEnv({
      mode: "dev",
      env: { T3CODE_STATE_DIR: "/tmp/prod-state" },
      offset: 0,
      envOverrides: {},
    });

    expect(env.T3CODE_STATE_DIR).toBe(DEFAULT_DEV_STATE_DIR);
  });

  it("lets --state-dir override existing env state dir", () => {
    const env = createDevRunnerEnv({
      mode: "dev:server",
      env: { T3CODE_STATE_DIR: "/tmp/existing-state" },
      offset: 0,
      envOverrides: { T3CODE_STATE_DIR: "/tmp/override-state" },
    });

    expect(env.T3CODE_STATE_DIR).toBe("/tmp/override-state");
  });

  it("recomputes websocket url when port is overridden", () => {
    const env = createDevRunnerEnv({
      mode: "dev",
      env: {},
      offset: 0,
      envOverrides: { T3CODE_PORT: "4222" },
    });

    expect(env.T3CODE_PORT).toBe("4222");
    expect(env.VITE_WS_URL).toBe("ws://localhost:4222");
  });

  it("keeps explicitly forwarded web-mode flags", () => {
    const env = createDevRunnerEnv({
      mode: "dev",
      env: {
        T3CODE_AUTH_TOKEN: "desktop-token",
      },
      offset: 0,
      envOverrides: {
        T3CODE_NO_BROWSER: "1",
        T3CODE_AUTH_TOKEN: "cli-token",
      },
    });

    expect(env.T3CODE_NO_BROWSER).toBe("1");
    expect(env.T3CODE_AUTH_TOKEN).toBe("cli-token");
  });
});
