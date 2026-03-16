import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
      providerOptions: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
          homePath: "/tmp/.codex",
        },
      },
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("high");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
    expect(parsed.providerOptions?.codex?.binaryPath).toBe("/usr/local/bin/codex");
    expect(parsed.providerOptions?.codex?.homePath).toBe("/tmp/.codex");
  });

  it("accepts claude-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeCode",
      model: "claude-sonnet-4-6",
      modelOptions: {
        claudeCode: {
          thinking: true,
          effort: "max",
        },
      },
      runtimeMode: "full-access",
      providerOptions: {
        claudeCode: {
          binaryPath: "/usr/local/bin/claude",
          permissionMode: "plan",
          maxThinkingTokens: 4000,
          experimentalAgentTeams: true,
          agentProgressSummaries: true,
        },
      },
    });

    expect(parsed.modelOptions?.claudeCode?.thinking).toBe(true);
    expect(parsed.modelOptions?.claudeCode?.effort).toBe("max");
    expect(parsed.providerOptions?.claudeCode?.binaryPath).toBe("/usr/local/bin/claude");
    expect(parsed.providerOptions?.claudeCode?.permissionMode).toBe("plan");
    expect(parsed.providerOptions?.claudeCode?.maxThinkingTokens).toBe(4000);
    expect(parsed.providerOptions?.claudeCode?.experimentalAgentTeams).toBe(true);
    expect(parsed.providerOptions?.claudeCode?.agentProgressSummaries).toBe(true);
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts provider-scoped model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("xhigh");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
  });

  it("accepts claude provider effort options including ultrathink", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      model: "claude-sonnet-4-6",
      modelOptions: {
        claudeCode: {
          effort: "ultrathink",
        },
      },
    });

    expect(parsed.modelOptions?.claudeCode?.effort).toBe("ultrathink");
  });
});
