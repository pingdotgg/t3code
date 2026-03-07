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

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts claude runtime knobs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeCode",
      cwd: "/tmp/workspace",
      model: "claude-sonnet-4-6",
      providerOptions: {
        claudeCode: {
          binaryPath: "/usr/local/bin/claude",
          permissionMode: "plan",
          maxThinkingTokens: 12_000,
        },
      },
      runtimeMode: "full-access",
    });
    expect(parsed.provider).toBe("claudeCode");
    expect(parsed.providerOptions?.claudeCode?.binaryPath).toBe("/usr/local/bin/claude");
    expect(parsed.providerOptions?.claudeCode?.permissionMode).toBe("plan");
    expect(parsed.providerOptions?.claudeCode?.maxThinkingTokens).toBe(12_000);
    expect(parsed.runtimeMode).toBe("full-access");
  });

  it("accepts cursor provider payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "cursor",
      cwd: "/tmp/workspace",
      model: "composer-1.5",
      modelOptions: {
        cursor: {
          thinking: true,
        },
      },
      providerOptions: {
        cursor: {
          binaryPath: "/usr/local/bin/agent",
        },
      },
      runtimeMode: "approval-required",
    });
    expect(parsed.provider).toBe("cursor");
    expect(parsed.model).toBe("composer-1.5");
    expect(parsed.modelOptions?.cursor?.thinking).toBe(true);
    expect(parsed.providerOptions?.cursor?.binaryPath).toBe("/usr/local/bin/agent");
    expect(parsed.runtimeMode).toBe("approval-required");
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
});
