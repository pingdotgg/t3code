import { describe, expect, it } from "vite-plus/test";

import { buildHermesAcpSpawnInput } from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("builds the default Hermes ACP command", () => {
    expect(buildHermesAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured binary and environment", () => {
    expect(
      buildHermesAcpSpawnInput({ binaryPath: "/opt/hermes/bin/hermes" }, "/tmp/project", {
        HERMES_PROFILE: "work",
      }),
    ).toEqual({
      command: "/opt/hermes/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HERMES_PROFILE: "work" },
    });
  });
});
