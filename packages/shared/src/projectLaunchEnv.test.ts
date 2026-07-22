import { describe, expect, it } from "vite-plus/test";

import { isManagedRuntimeEnvKey, stripManagedRuntimeEnvKeys } from "./projectLaunchEnv.ts";

describe("projectLaunchEnv", () => {
  it("identifies managed runtime env keys", () => {
    expect(isManagedRuntimeEnvKey("T3CODE_PORT")).toBe(true);
    expect(isManagedRuntimeEnvKey("t3code_home")).toBe(true);
    expect(isManagedRuntimeEnvKey("T3_MCP_BEARER_TOKEN")).toBe(true);
    expect(isManagedRuntimeEnvKey("t3_custom")).toBe(true);
    expect(isManagedRuntimeEnvKey("CUSTOM_FLAG")).toBe(false);
  });

  it("strips inherited managed runtime env keys", () => {
    expect(
      stripManagedRuntimeEnvKeys({
        T3CODE_PORT: "3773",
        T3CODE_HOME: "/tmp/.t3",
        T3_MCP_BEARER_TOKEN: "client-token",
        T3_CUSTOM: "client-custom",
        CUSTOM_FLAG: "1",
      }),
    ).toEqual({
      CUSTOM_FLAG: "1",
    });
  });
});
