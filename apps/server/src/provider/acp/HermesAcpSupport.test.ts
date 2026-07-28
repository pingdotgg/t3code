import { describe, expect, it } from "vite-plus/test";

import { buildHermesAcpSpawnInput } from "./HermesAcpSupport.ts";

describe("HermesAcpSupport", () => {
  it("launches the genuine ACP stdio command instead of the Work gateway", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/opt/hermes/bin/hermes" },
      "/workspace/project",
      {
        EXISTING: "kept",
        HERMES_ACP_SKIP_CONFIGURED_MCP: "0",
      },
    );

    expect(spawn).toEqual({
      command: "/opt/hermes/bin/hermes",
      args: ["acp"],
      cwd: "/workspace/project",
      env: {
        EXISTING: "kept",
        HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
      },
    });
    expect(spawn.args).not.toContain("serve");
  });
});
