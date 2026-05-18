import { describe, expect, it } from "vitest";

import { buildPiAcpSpawnInput } from "./PiAcpSupport.ts";

describe("buildPiAcpSpawnInput", () => {
  it("builds the default Pi ACP command", () => {
    expect(buildPiAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "pi-acp",
      args: [],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured Pi ACP adapter and Pi binary paths", () => {
    const env = { HOME: "/tmp/pi-home", PATH: "/usr/bin" };

    expect(
      buildPiAcpSpawnInput(
        {
          binaryPath: "/Users/me/.local/bin/pi-acp",
          piBinaryPath: "/opt/homebrew/bin/pi",
        },
        "/tmp/project",
        env,
      ),
    ).toEqual({
      command: "/Users/me/.local/bin/pi-acp",
      args: [],
      cwd: "/tmp/project",
      env: {
        ...env,
        PATH: "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin",
        PI_ACP_PI_COMMAND: "/opt/homebrew/bin/pi",
      },
    });
  });

  it("adds configured absolute binary directories when PATH is missing", () => {
    expect(
      buildPiAcpSpawnInput(
        {
          binaryPath: "/opt/homebrew/bin/pi-acp",
          piBinaryPath: "/opt/homebrew/bin/pi",
        },
        "/tmp/project",
        { HOME: "/tmp/pi-home" },
      ).env?.PATH,
    ).toBe("/opt/homebrew/bin");
  });
});
