import { describe, expect, it } from "@effect/vitest";

import { buildKiroAcpSpawnInput, resolveKiroAcpModelId } from "./KiroAcpSupport.ts";

describe("buildKiroAcpSpawnInput", () => {
  it("spawns Kiro's documented ACP command", () => {
    expect(
      buildKiroAcpSpawnInput({ binaryPath: "/usr/local/bin/kiro-cli" }, "/tmp/project", {
        KIRO_API_KEY: "secret",
      }),
    ).toEqual({
      command: "/usr/local/bin/kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { KIRO_API_KEY: "secret" },
    });
  });
});

describe("resolveKiroAcpModelId", () => {
  it("keeps the selectable default slug and normalizes explicit model ids", () => {
    expect(resolveKiroAcpModelId(undefined)).toBeUndefined();
    expect(resolveKiroAcpModelId("")).toBeUndefined();
    expect(resolveKiroAcpModelId(" default ")).toBe("default");
    expect(resolveKiroAcpModelId(" claude-opus-4.6 ")).toBe("claude-opus-4.6");
  });
});
