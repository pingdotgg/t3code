import { describe, expect, it } from "vitest";

import { buildHermesAcpSpawnInput } from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("builds the default Hermes ACP command", () => {
    expect(buildHermesAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured Hermes binary path and environment", () => {
    const env = { HOME: "/tmp/hermes-home", PATH: "/usr/bin" };

    expect(
      buildHermesAcpSpawnInput(
        {
          binaryPath: "/Users/me/.local/bin/hermes",
        },
        "/tmp/project",
        env,
      ),
    ).toEqual({
      command: "/Users/me/.local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env,
    });
  });
});
