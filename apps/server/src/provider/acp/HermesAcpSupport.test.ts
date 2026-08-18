import { describe, expect, it } from "vite-plus/test";

import { buildHermesAcpSpawnInput, resolveHermesModelId } from "./HermesAcpSupport.ts";

describe("Hermes ACP support", () => {
  it("starts the official Hermes ACP server with the instance environment", () => {
    expect(
      buildHermesAcpSpawnInput({ binaryPath: "/opt/bin/hermes" }, "/workspace", {
        HERMES_HOME: "/tmp/hermes",
      }),
    ).toEqual({
      command: "/opt/bin/hermes",
      args: ["acp"],
      cwd: "/workspace",
      env: { HERMES_HOME: "/tmp/hermes" },
    });
  });

  it("keeps Hermes' configured model for the default sentinel", () => {
    expect(resolveHermesModelId("default")).toBeUndefined();
    expect(resolveHermesModelId(" openrouter:anthropic/claude-sonnet-4.6 ")).toBe(
      "openrouter:anthropic/claude-sonnet-4.6",
    );
  });
});
