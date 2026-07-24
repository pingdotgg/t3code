import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  buildKimiAcpSpawnInput,
  resolveKimiAcpBaseModelId,
  resolveKimiThinkingEffort,
} from "./KimiAcpSupport.ts";

describe("KimiAcpSupport", () => {
  it("spawns kimi acp without reasoning flags", () => {
    const spawn = buildKimiAcpSpawnInput({ binaryPath: "/opt/kimi" }, "/tmp/project", {
      PATH: "/usr/bin",
    });
    expect(spawn).toEqual({
      command: "/opt/kimi",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { PATH: "/usr/bin" },
    });
  });

  it("defaults the binary to kimi", () => {
    expect(buildKimiAcpSpawnInput(undefined, "/tmp").command).toBe("kimi");
  });

  it("normalizes model aliases", () => {
    expect(resolveKimiAcpBaseModelId("k3")).toBe("kimi-code/k3");
    expect(resolveKimiAcpBaseModelId("kimi-code/kimi-for-coding")).toBe(
      "kimi-code/kimi-for-coding",
    );
    expect(resolveKimiAcpBaseModelId(undefined)).toBe("kimi-code/k3");
  });

  it("maps reasoningEffort to Kimi thinking levels", () => {
    expect(
      resolveKimiThinkingEffort({
        instanceId: ProviderInstanceId.make("kimi"),
        model: "kimi-code/k3",
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    ).toBe("low");
    expect(
      resolveKimiThinkingEffort({
        instanceId: ProviderInstanceId.make("kimi"),
        model: "kimi-code/k3",
        options: [{ id: "reasoningEffort", value: "medium" }],
      }),
    ).toBe("high");
    expect(
      resolveKimiThinkingEffort({
        instanceId: ProviderInstanceId.make("kimi"),
        model: "kimi-code/k3",
        options: [{ id: "reasoningEffort", value: "max" }],
      }),
    ).toBe("max");
  });
});
