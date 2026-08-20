import { describe, expect, it } from "vite-plus/test";

import { resolveAcpAuthMethodId } from "./AcpSessionRuntime.ts";
import { buildHermesAcpSpawnInput, resolveHermesAcpBaseModelId } from "./HermesAcpSupport.ts";

describe("HermesAcpSupport", () => {
  it("starts Hermes in ACP mode and carries the configured home and environment", () => {
    expect(
      buildHermesAcpSpawnInput(
        {
          binaryPath: "C:/tools/hermes.exe",
          homePath: "C:/profiles/hermes",
          authMethodId: "",
        },
        "C:/workspace",
        { HERMES_TEST: "1" },
      ),
    ).toEqual({
      command: "C:/tools/hermes.exe",
      args: ["acp"],
      cwd: "C:/workspace",
      env: {
        HERMES_TEST: "1",
        HERMES_HOME: "C:/profiles/hermes",
      },
    });
  });

  it("uses Hermes defaults when optional settings are blank", () => {
    expect(
      buildHermesAcpSpawnInput(
        { binaryPath: "", homePath: "  ", authMethodId: "" },
        "C:/workspace",
      ),
    ).toEqual({ command: "hermes", args: ["acp"], cwd: "C:/workspace", env: {} });
    expect(resolveHermesAcpBaseModelId("  ")).toBeUndefined();
    expect(resolveHermesAcpBaseModelId(" hermes-agent ")).toBeUndefined();
    expect(resolveHermesAcpBaseModelId("deepseek:deepseek-v4-flash")).toBe(
      "deepseek:deepseek-v4-flash",
    );
  });

  it("uses the auth method advertised by Hermes unless explicitly overridden", () => {
    const initialized = {
      authMethods: [{ id: "deepseek", name: "DeepSeek" }],
    };
    expect(resolveAcpAuthMethodId("", initialized)).toBe("deepseek");
    expect(resolveAcpAuthMethodId("custom-provider", initialized)).toBe("custom-provider");
  });
});
