import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEV_STATE_DIR,
  createDevRunnerEnv,
  findFirstAvailableOffset,
  parseDevRunnerArgs,
  resolveModePortOffsets,
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
      env: {},
      offset: 0,
      envOverrides: {},
    });

    expect(env.T3CODE_STATE_DIR).toBe(DEFAULT_DEV_STATE_DIR);
  });

  it("uses existing env state dir when --state-dir is not provided", () => {
    const env = createDevRunnerEnv({
      mode: "dev:server",
      env: { T3CODE_STATE_DIR: "/tmp/existing-state" },
      offset: 0,
      envOverrides: {},
    });

    expect(env.T3CODE_STATE_DIR).toBe("/tmp/existing-state");
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

  it("treats whitespace-only --state-dir as missing and falls back to env/default", () => {
    const env = createDevRunnerEnv({
      mode: "dev:server",
      env: { T3CODE_STATE_DIR: "/tmp/existing-state" },
      offset: 0,
      envOverrides: { T3CODE_STATE_DIR: "   " },
    });

    expect(env.T3CODE_STATE_DIR).toBe("/tmp/existing-state");
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

  it("fails fast for invalid port overrides", () => {
    expect(() =>
      createDevRunnerEnv({
        mode: "dev",
        env: {},
        offset: 0,
        envOverrides: { T3CODE_PORT: "not-a-port" },
      }),
    ).toThrow("Invalid T3CODE_PORT override");
  });
});

describe("findFirstAvailableOffset", () => {
  it("returns the starting offset when required ports are available", async () => {
    const offset = await findFirstAvailableOffset({
      startOffset: 0,
      requireServerPort: true,
      requireWebPort: true,
      checkPortAvailability: async () => true,
    });

    expect(offset).toBe(0);
  });

  it("advances until all required ports are available", async () => {
    const taken = new Set([3773, 5733, 3774, 5734]);
    const offset = await findFirstAvailableOffset({
      startOffset: 0,
      requireServerPort: true,
      requireWebPort: true,
      checkPortAvailability: async (port) => !taken.has(port),
    });

    expect(offset).toBe(2);
  });

  it("allows offsets where only non-required ports exceed max", async () => {
    const offset = await findFirstAvailableOffset({
      startOffset: 59_803,
      requireServerPort: true,
      requireWebPort: false,
      checkPortAvailability: async () => true,
    });

    expect(offset).toBe(59_803);
  });
});

describe("resolveModePortOffsets", () => {
  it("uses a shared fallback offset for dev mode", async () => {
    const taken = new Set([3773, 5733]);
    const offsets = await resolveModePortOffsets({
      mode: "dev",
      startOffset: 0,
      envOverrides: {},
      checkPortAvailability: async (port) => !taken.has(port),
    });

    expect(offsets).toEqual({ serverOffset: 1, webOffset: 1 });
  });

  it("keeps server offset stable for dev:web and only shifts web offset", async () => {
    const taken = new Set([5733]);
    const offsets = await resolveModePortOffsets({
      mode: "dev:web",
      startOffset: 0,
      envOverrides: {},
      checkPortAvailability: async (port) => !taken.has(port),
    });

    expect(offsets).toEqual({ serverOffset: 0, webOffset: 1 });
  });

  it("shifts only server offset for dev:server", async () => {
    const taken = new Set([3773]);
    const offsets = await resolveModePortOffsets({
      mode: "dev:server",
      startOffset: 0,
      envOverrides: {},
      checkPortAvailability: async (port) => !taken.has(port),
    });

    expect(offsets).toEqual({ serverOffset: 1, webOffset: 1 });
  });

  it("respects explicit dev-url override for dev:web", async () => {
    const offsets = await resolveModePortOffsets({
      mode: "dev:web",
      startOffset: 0,
      envOverrides: { VITE_DEV_SERVER_URL: "http://localhost:9999" },
      checkPortAvailability: async () => false,
    });

    expect(offsets).toEqual({ serverOffset: 0, webOffset: 0 });
  });

  it("respects explicit server port override for dev:server", async () => {
    const offsets = await resolveModePortOffsets({
      mode: "dev:server",
      startOffset: 0,
      envOverrides: { T3CODE_PORT: "4888" },
      checkPortAvailability: async () => false,
    });

    expect(offsets).toEqual({ serverOffset: 0, webOffset: 0 });
  });
});
