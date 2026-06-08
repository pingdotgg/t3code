import { describe, expect, it } from "vite-plus/test";

import { isManagedRuntimeEnvKey, stripManagedRuntimeEnvKeys } from "./launchEnv.ts";

describe("launchEnv", () => {
  it("identifies managed runtime env keys", () => {
    expect(isManagedRuntimeEnvKey("T3CODE_PORT")).toBe(true);
    expect(isManagedRuntimeEnvKey("t3code_home")).toBe(true);
    expect(isManagedRuntimeEnvKey("CUSTOM_FLAG")).toBe(false);
  });

  it("strips inherited managed runtime env keys", () => {
    expect(
      stripManagedRuntimeEnvKeys({
        T3CODE_PORT: "3773",
        T3CODE_HOME: "/tmp/.t3",
        CUSTOM_FLAG: "1",
      }),
    ).toEqual({
      CUSTOM_FLAG: "1",
    });
  });
});
