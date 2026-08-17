import { describe, expect, it } from "@effect/vitest";

import { buildPrimeAgentAcpSpawnInput, resolvePrimeAgentModel } from "./PrimeAgentAcpSupport.ts";

describe("resolvePrimeAgentModel", () => {
  it("defers default and empty selections to Prime Agent", () => {
    expect(resolvePrimeAgentModel(undefined)).toBeUndefined();
    expect(resolvePrimeAgentModel("   ")).toBeUndefined();
    expect(resolvePrimeAgentModel("default")).toBeUndefined();
    expect(resolvePrimeAgentModel(" openai/gpt-5.6 ")).toBe("openai/gpt-5.6");
  });
});

describe("buildPrimeAgentAcpSpawnInput", () => {
  it("builds a resumable isolated ACP invocation with model options", () => {
    expect(
      buildPrimeAgentAcpSpawnInput({
        settings: { binaryPath: "/opt/prime-agent" },
        cwd: "/tmp/project",
        environment: { PRIME_API_KEY: "secret" },
        modelSelection: {
          model: "openai/gpt-5.6",
          options: [{ id: "thinking", value: "high" }],
        },
        sessionDir: "/tmp/t3/prime-agent/thread-1",
        continueSession: true,
      }),
    ).toEqual({
      command: "/opt/prime-agent",
      args: [
        "--mode",
        "acp",
        "--offline",
        "--cwd",
        "/tmp/project",
        "--session-dir",
        "/tmp/t3/prime-agent/thread-1",
        "--continue",
        "--model",
        "openai/gpt-5.6",
        "--thinking",
        "high",
      ],
      cwd: "/tmp/project",
      env: { PRIME_API_KEY: "secret" },
    });
  });

  it("omits model and resume flags for a new default-model session", () => {
    const spawn = buildPrimeAgentAcpSpawnInput({
      settings: undefined,
      cwd: "/tmp/project",
      modelSelection: { model: "default" },
      sessionDir: "/tmp/t3/prime-agent/thread-2",
      continueSession: false,
    });

    expect(spawn.command).toBe("prime-agent");
    expect(spawn.args).not.toContain("--model");
    expect(spawn.args).not.toContain("--continue");
  });
});
