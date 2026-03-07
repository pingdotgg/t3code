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

  it("accepts copilot-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-2",
      provider: "copilot",
      cwd: "/tmp/workspace",
      model: "gpt-5.3-codex",
      runtimeMode: "full-access",
      modelOptions: {
        copilot: {
          reasoningEffort: "high",
        },
      },
      providerOptions: {
        copilot: {
          cliPath: "/usr/local/bin/copilot",
          configDir: "/tmp/.copilot",
        },
      },
    });

    expect(parsed.provider).toBe("copilot");
    expect(parsed.modelOptions?.copilot?.reasoningEffort).toBe("high");
    expect(parsed.providerOptions?.copilot?.cliPath).toBe("/usr/local/bin/copilot");
    expect(parsed.providerOptions?.copilot?.configDir).toBe("/tmp/.copilot");
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

  it("accepts copilot model payloads without provider-specific options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-2",
      model: "gpt-5.3-codex",
      modelOptions: {
        copilot: {
          reasoningEffort: "medium",
        },
      },
    });

    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.modelOptions?.copilot?.reasoningEffort).toBe("medium");
  });
});
